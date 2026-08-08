/**
 * 数据库迁移错误的安全序列化边界。
 *
 * 职责：展开 Drizzle 与 node-postgres 的 cause 链，只保留诊断所需字段，并在写入
 * CI/生产日志前移除数据库 URL 与常见凭据。
 * 使用方：run-migrations.mjs 与对应 Node 测试。
 * 关键依赖：仅使用 JavaScript Error 标准字段，无数据库副作用。
 */

const MAX_CAUSE_DEPTH = 8;
const MAX_FIELD_LENGTH = 1_000;
const POSTGRES_ERROR_FIELDS = [
  "code",
  "column",
  "constraint",
  "dataType",
  "detail",
  "hint",
  "position",
  "routine",
  "schema",
  "severity",
  "table",
  "where",
];

/**
 * 移除错误文本中的连接 URL 与常见凭据，并限制单字段长度。
 *
 * @param value 来自可信代码或数据库驱动的错误字段。
 * @returns 可安全写入部署日志的短文本。
 * @sideEffect 无副作用。
 */
function sanitizeMigrationErrorText(value) {
  return value
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/giu, "[REDACTED_DATABASE_URL]")
    .replace(
      /\b(password|secret(?:Key)?|token)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}]+)/giu,
      "$1=[REDACTED]"
    )
    .slice(0, MAX_FIELD_LENGTH);
}

/**
 * 将单层 Error 投影为不包含 query、parameters 或连接配置的安全对象。
 *
 * @param error 当前异常链节点。
 * @returns 包含名称、消息及 PostgreSQL 定位字段的日志对象。
 * @sideEffect 无副作用。
 */
function describeMigrationError(error) {
  const description = {
    message: sanitizeMigrationErrorText(error.message),
    name: error.name,
  };

  for (const field of POSTGRES_ERROR_FIELDS) {
    const value = error[field];
    if (typeof value === "string" && value.length > 0) {
      description[field] = sanitizeMigrationErrorText(value);
    }
  }

  return description;
}

/**
 * 展开迁移异常的 cause 链，避免 Drizzle 包装层隐藏 PostgreSQL 根因。
 *
 * @param error 捕获到的未知迁移异常。
 * @returns 最多八层、已脱敏且可 JSON 序列化的错误描述数组。
 * @sideEffect 无副作用；循环 cause 会被安全截断。
 */
export function describeMigrationErrorChain(error) {
  if (!(error instanceof Error)) {
    return [
      {
        message: "Unknown database migration error",
        name: "UnknownError",
      },
    ];
  }

  const descriptions = [];
  const visited = new Set();
  let current = error;

  while (
    current instanceof Error &&
    !visited.has(current) &&
    descriptions.length < MAX_CAUSE_DEPTH
  ) {
    visited.add(current);
    descriptions.push(describeMigrationError(current));
    current = current.cause;
  }

  return descriptions;
}
