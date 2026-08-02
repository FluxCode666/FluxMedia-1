-- API 账号上游适配迁移：增加平台到供应商模型映射与隔离脚本配置，将旧
-- copy/move 规则转换为等价脚本，并彻底删除旧列和模板表。整份迁移可重复执行。
ALTER TABLE "image_backend_member_api_config"
  ADD COLUMN IF NOT EXISTS "model_mappings" json NOT NULL DEFAULT '[]'::json;

ALTER TABLE "image_backend_member_api_config"
  ADD COLUMN IF NOT EXISTS "request_transform_script" text NOT NULL DEFAULT '';

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'image_backend_member_api_config'
      AND column_name = 'parameter_mappings'
  ) THEN
    EXECUTE $sql$
      UPDATE image_backend_member_api_config
      SET request_transform_script = format(
        $script$// 由旧 copy/move 参数映射自动迁移，可按供应商协议继续编辑。
const rawRules = %s;
const snapshot = JSON.parse(JSON.stringify(request));
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isIndex = (value) => /^(0|[1-9][0-9]*)$/.test(value);
const isSafePath = (value) => {
  const blocked = new Set(["__proto__", "constructor", "prototype"]);
  const keyPattern = /^[A-Za-z_][A-Za-z0-9_-]*(?:\[\])?$/;
  return typeof value === "string" &&
    value.length >= 1 && value.length <= 160 &&
    value.split(".").every((segment) => {
      const key = segment.endsWith("[]") ? segment.slice(0, -2) : segment;
      return !blocked.has(key) && (keyPattern.test(segment) || isIndex(segment));
    });
};
const seenSources = new Set();
const seenTargets = new Set();
const mappingsAreValid = Array.isArray(rawRules) && rawRules.length <= 50 &&
  rawRules.every((rule) => {
    if (!isRecord(rule) ||
      (rule.mode !== "copy" && rule.mode !== "move") ||
      !isSafePath(rule.source) || !isSafePath(rule.target) ||
      seenSources.has(rule.source) || seenTargets.has(rule.target)) {
      return false;
    }
    seenSources.add(rule.source);
    seenTargets.add(rule.target);
    return true;
  });
if (!mappingsAreValid) return request;
const rules = rawRules;
const getPath = (root, path) => {
  let current = root;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      if (!isIndex(segment) || !(Number(segment) in current)) {
        return { found: false };
      }
      current = current[Number(segment)];
    } else if (
      !isRecord(current) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return { found: false };
    } else {
      current = current[segment];
    }
  }
  return { found: true, value: current };
};
const deletePath = (root, path) => {
  const segments = path.split(".");
  const last = segments.pop();
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!isIndex(segment) || !(Number(segment) in current)) return;
      current = current[Number(segment)];
    } else if (!isRecord(current) ||
      !Object.prototype.hasOwnProperty.call(current, segment)) {
      return;
    } else {
      current = current[segment];
    }
  }
  if (Array.isArray(current)) {
    if (!isIndex(last) || !(Number(last) in current)) return;
    delete current[Number(last)];
  } else if (isRecord(current) &&
    Object.prototype.hasOwnProperty.call(current, last)) {
    delete current[last];
  }
};
const setPath = (root, path, value) => {
  const segments = path.split(".");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index === segments.length - 1) {
      if (Array.isArray(current) && !isIndex(segment)) return;
      const key = Array.isArray(current) ? Number(segment) : segment;
      current[key] = value;
      return;
    }
    const nextIsArray = isIndex(segments[index + 1]);
    if (Array.isArray(current) && !isIndex(segment)) return;
    const key = Array.isArray(current) ? Number(segment) : segment;
    if (!isRecord(current[key]) && !Array.isArray(current[key])) {
      current[key] = nextIsArray ? [] : {};
    }
    current = current[key];
  }
};
const resolved = rules
  .map((rule) => ({ ...rule, sourceValue: getPath(snapshot, rule.source) }))
  .filter((rule) => rule.sourceValue.found);
for (const rule of resolved) {
  if (rule.mode === "move" && rule.source !== rule.target) {
    deletePath(request, rule.source);
  }
}
for (const rule of resolved) {
  setPath(request, rule.target, rule.sourceValue.value);
}
return request;$script$,
        parameter_mappings::text
      )
      WHERE json_typeof(parameter_mappings) = 'array'
        AND json_array_length(parameter_mappings) > 0
        AND btrim(request_transform_script) = ''
    $sql$;
  END IF;
END
$migration$;

ALTER TABLE "image_backend_member_api_config"
  DROP CONSTRAINT IF EXISTS "image_backend_member_api_config_mappings_check";

ALTER TABLE "image_backend_member_api_config"
  DROP COLUMN IF EXISTS "parameter_mappings";

DROP TABLE IF EXISTS "image_backend_parameter_mapping_template";

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'image_backend_member_api_config_model_mappings_check'
      AND conrelid = 'image_backend_member_api_config'::regclass
  ) THEN
    ALTER TABLE "image_backend_member_api_config"
      ADD CONSTRAINT "image_backend_member_api_config_model_mappings_check"
      CHECK (json_typeof("model_mappings") = 'array');
  END IF;
END
$migration$;
