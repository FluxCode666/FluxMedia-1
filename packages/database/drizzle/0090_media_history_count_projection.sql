-- 图片/视频历史的事务一致精确计数投影。
--
-- 每条事实在同一写事务内维护 owner/global、all_time/day 四个原子桶；读取时按
-- media_type/status/model/visibility_state 汇总，避免高量事实表的全历史 count。
-- 触发器覆盖 INSERT、相关字段 UPDATE 与物理 DELETE；重建函数持写锁，保证回填
-- 与并发写入不会交错。所有函数均可重入创建，迁移可安全重复部署。

CREATE TABLE IF NOT EXISTS "media_history_count_projection" (
  "scope_kind" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "visibility_state" text NOT NULL,
  "media_type" text NOT NULL,
  "status" text NOT NULL,
  "model" text NOT NULL,
  "bucket_kind" text NOT NULL,
  "utc_day" date NOT NULL,
  "record_count" bigint NOT NULL,
  CONSTRAINT "media_history_count_projection_pk" PRIMARY KEY (
    "scope_kind",
    "owner_user_id",
    "visibility_state",
    "media_type",
    "status",
    "model",
    "bucket_kind",
    "utc_day"
  ),
  CONSTRAINT "media_history_count_projection_scope_check"
    CHECK (
      ("scope_kind" = 'global' AND "owner_user_id" = '') OR
      ("scope_kind" = 'owner' AND length("owner_user_id") > 0)
    ),
  CONSTRAINT "media_history_count_projection_visibility_check"
    CHECK ("visibility_state" IN ('visible', 'hidden', 'unknown')),
  CONSTRAINT "media_history_count_projection_media_type_check"
    CHECK ("media_type" IN ('image', 'video')),
  CONSTRAINT "media_history_count_projection_status_check"
    CHECK ("status" IN ('processing', 'completed', 'failed')),
  CONSTRAINT "media_history_count_projection_bucket_check"
    CHECK (
      ("bucket_kind" = 'all_time' AND "utc_day" = DATE '0001-01-01') OR
      ("bucket_kind" = 'day' AND "utc_day" > DATE '0001-01-01')
    ),
  CONSTRAINT "media_history_count_projection_count_check"
    CHECK ("record_count" >= 0)
);

CREATE INDEX IF NOT EXISTS "media_history_count_projection_owner_lookup_idx"
  ON "media_history_count_projection" (
    "scope_kind",
    "owner_user_id",
    "bucket_kind",
    "utc_day",
    "media_type",
    "status",
    "model"
  );

CREATE INDEX IF NOT EXISTS "media_history_count_projection_global_lookup_idx"
  ON "media_history_count_projection" (
    "scope_kind",
    "bucket_kind",
    "utc_day",
    "media_type",
    "status",
    "model"
  )
  WHERE "scope_kind" = 'global';

-- 对单条事实的四个原子桶做差量维护；零桶立即删除，避免漂移检查出现墓碑行。
CREATE OR REPLACE FUNCTION media_history_count_projection_apply(
  p_media_type text,
  p_user_id text,
  p_usage_log_visible boolean,
  p_status text,
  p_model text,
  p_created_at timestamp without time zone,
  p_delta bigint
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
  v_visibility_state text;
  v_updated_rows integer;
BEGIN
  IF p_delta NOT IN (-1, 1) THEN
    RAISE EXCEPTION 'media history projection delta must be -1 or 1';
  END IF;

  v_status := CASE
    WHEN p_media_type = 'image' AND p_status = 'pending' THEN 'processing'
    WHEN p_media_type = 'video' AND p_status IN ('pending', 'running')
      THEN 'processing'
    WHEN p_status IN ('completed', 'failed') THEN p_status
    ELSE NULL
  END;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'unsupported media history status: %/%', p_media_type, p_status;
  END IF;

  v_visibility_state := CASE
    WHEN p_usage_log_visible IS TRUE THEN 'visible'
    WHEN p_usage_log_visible IS FALSE THEN 'hidden'
    ELSE 'unknown'
  END;

  IF p_delta = 1 THEN
    INSERT INTO "media_history_count_projection" (
      "scope_kind",
      "owner_user_id",
      "visibility_state",
      "media_type",
      "status",
      "model",
      "bucket_kind",
      "utc_day",
      "record_count"
    )
    SELECT
      scope_row.scope_kind,
      scope_row.owner_user_id,
      v_visibility_state,
      p_media_type,
      v_status,
      p_model,
      bucket_row.bucket_kind,
      bucket_row.utc_day,
      1
    FROM (
      VALUES ('global'::text, ''::text), ('owner'::text, p_user_id)
    ) AS scope_row(scope_kind, owner_user_id)
    CROSS JOIN (
      VALUES
        ('all_time'::text, DATE '0001-01-01'),
        ('day'::text, p_created_at::date)
    ) AS bucket_row(bucket_kind, utc_day)
    ON CONFLICT (
      "scope_kind",
      "owner_user_id",
      "visibility_state",
      "media_type",
      "status",
      "model",
      "bucket_kind",
      "utc_day"
    ) DO UPDATE
    SET "record_count" =
      "media_history_count_projection"."record_count" + 1;
  ELSE
    UPDATE "media_history_count_projection"
    SET "record_count" = "record_count" - 1
    WHERE "visibility_state" = v_visibility_state
      AND "media_type" = p_media_type
      AND "status" = v_status
      AND "model" = p_model
      AND (
        ("scope_kind" = 'global' AND "owner_user_id" = '') OR
        ("scope_kind" = 'owner' AND "owner_user_id" = p_user_id)
      )
      AND (
        ("bucket_kind" = 'all_time' AND "utc_day" = DATE '0001-01-01') OR
        ("bucket_kind" = 'day' AND "utc_day" = p_created_at::date)
      );
    GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

    IF v_updated_rows <> 4 OR EXISTS (
      SELECT 1
      FROM "media_history_count_projection"
      WHERE "record_count" < 0
    ) THEN
      RAISE EXCEPTION 'media history count projection decrement drifted';
    END IF;
  END IF;

  DELETE FROM "media_history_count_projection"
  WHERE "record_count" = 0
    AND "visibility_state" = v_visibility_state
    AND "media_type" = p_media_type
    AND "status" = v_status
    AND "model" = p_model
    AND (
      ("scope_kind" = 'global' AND "owner_user_id" = '') OR
      ("scope_kind" = 'owner' AND "owner_user_id" = p_user_id)
    )
    AND (
      ("bucket_kind" = 'all_time' AND "utc_day" = DATE '0001-01-01') OR
      ("bucket_kind" = 'day' AND "utc_day" = p_created_at::date)
    );

END;
$$;

-- 图片事实触发器：无关字段 UPDATE 不触发；相关字段写回原值时也保持零写放大。
CREATE OR REPLACE FUNCTION generation_history_count_projection_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
    OLD.user_id IS NOT DISTINCT FROM NEW.user_id AND
    OLD.usage_log_visible IS NOT DISTINCT FROM NEW.usage_log_visible AND
    OLD.status IS NOT DISTINCT FROM NEW.status AND
    OLD.model IS NOT DISTINCT FROM NEW.model AND
    OLD.created_at IS NOT DISTINCT FROM NEW.created_at
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM media_history_count_projection_apply(
      'image', OLD.user_id, OLD.usage_log_visible, OLD.status::text,
      OLD.model, OLD.created_at, -1
    );
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM media_history_count_projection_apply(
      'image', NEW.user_id, NEW.usage_log_visible, NEW.status::text,
      NEW.model, NEW.created_at, 1
    );
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS generation_history_count_projection_write
  ON "generation";
CREATE TRIGGER generation_history_count_projection_write
AFTER INSERT OR DELETE OR UPDATE OF
  "user_id", "usage_log_visible", "status", "model", "created_at"
ON "generation"
FOR EACH ROW
EXECUTE FUNCTION generation_history_count_projection_trigger();

-- 视频事实触发器与图片保持同一事务语义，并把 pending/running 统一为 processing。
CREATE OR REPLACE FUNCTION video_generation_history_count_projection_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
    OLD.user_id IS NOT DISTINCT FROM NEW.user_id AND
    OLD.usage_log_visible IS NOT DISTINCT FROM NEW.usage_log_visible AND
    OLD.status IS NOT DISTINCT FROM NEW.status AND
    OLD.model IS NOT DISTINCT FROM NEW.model AND
    OLD.created_at IS NOT DISTINCT FROM NEW.created_at
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM media_history_count_projection_apply(
      'video', OLD.user_id, OLD.usage_log_visible, OLD.status,
      OLD.model, OLD.created_at, -1
    );
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM media_history_count_projection_apply(
      'video', NEW.user_id, NEW.usage_log_visible, NEW.status,
      NEW.model, NEW.created_at, 1
    );
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS video_generation_history_count_projection_write
  ON "video_generation";
CREATE TRIGGER video_generation_history_count_projection_write
AFTER INSERT OR DELETE OR UPDATE OF
  "user_id", "usage_log_visible", "status", "model", "created_at"
ON "video_generation"
FOR EACH ROW
EXECUTE FUNCTION video_generation_history_count_projection_trigger();

-- 可重入权威重建。锁阻止事实写入与 DELETE/INSERT 回填交错，但不阻断只读查询。
CREATE OR REPLACE FUNCTION rebuild_media_history_count_projection()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  LOCK TABLE "generation", "video_generation" IN SHARE ROW EXCLUSIVE MODE;
  DELETE FROM "media_history_count_projection";

  INSERT INTO "media_history_count_projection" (
    "scope_kind",
    "owner_user_id",
    "visibility_state",
    "media_type",
    "status",
    "model",
    "bucket_kind",
    "utc_day",
    "record_count"
  )
  SELECT
    scope_row.scope_kind,
    scope_row.owner_user_id,
    fact.visibility_state,
    fact.media_type,
    fact.status,
    fact.model,
    bucket_row.bucket_kind,
    bucket_row.utc_day,
    count(*)::bigint
  FROM (
    SELECT
      g.user_id,
      CASE
        WHEN g.usage_log_visible IS TRUE THEN 'visible'
        WHEN g.usage_log_visible IS FALSE THEN 'hidden'
        ELSE 'unknown'
      END AS visibility_state,
      'image'::text AS media_type,
      CASE
        WHEN g.status = 'pending' THEN 'processing'
        ELSE g.status::text
      END AS status,
      g.model,
      g.created_at
    FROM "generation" g
    UNION ALL
    SELECT
      v.user_id,
      CASE
        WHEN v.usage_log_visible IS TRUE THEN 'visible'
        WHEN v.usage_log_visible IS FALSE THEN 'hidden'
        ELSE 'unknown'
      END AS visibility_state,
      'video'::text AS media_type,
      CASE
        WHEN v.status IN ('pending', 'running') THEN 'processing'
        ELSE v.status
      END AS status,
      v.model,
      v.created_at
    FROM "video_generation" v
  ) fact
  CROSS JOIN LATERAL (
    VALUES ('global'::text, ''::text), ('owner'::text, fact.user_id)
  ) AS scope_row(scope_kind, owner_user_id)
  CROSS JOIN LATERAL (
    VALUES
      ('all_time'::text, DATE '0001-01-01'),
      ('day'::text, fact.created_at::date)
  ) AS bucket_row(bucket_kind, utc_day)
  GROUP BY
    scope_row.scope_kind,
    scope_row.owner_user_id,
    fact.visibility_state,
    fact.media_type,
    fact.status,
    fact.model,
    bucket_row.bucket_kind,
    bucket_row.utc_day;
END;
$$;

-- 返回投影与事实权威聚合之间的漂移键数量；零表示逐维度精确一致。
CREATE OR REPLACE FUNCTION media_history_count_projection_drift_count()
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  WITH expected AS (
    SELECT
      scope_row.scope_kind,
      scope_row.owner_user_id,
      fact.visibility_state,
      fact.media_type,
      fact.status,
      fact.model,
      bucket_row.bucket_kind,
      bucket_row.utc_day,
      count(*)::bigint AS record_count
    FROM (
      SELECT
        g.user_id,
        CASE
          WHEN g.usage_log_visible IS TRUE THEN 'visible'
          WHEN g.usage_log_visible IS FALSE THEN 'hidden'
          ELSE 'unknown'
        END AS visibility_state,
        'image'::text AS media_type,
        CASE
          WHEN g.status = 'pending' THEN 'processing'
          ELSE g.status::text
        END AS status,
        g.model,
        g.created_at
      FROM "generation" g
      UNION ALL
      SELECT
        v.user_id,
        CASE
          WHEN v.usage_log_visible IS TRUE THEN 'visible'
          WHEN v.usage_log_visible IS FALSE THEN 'hidden'
          ELSE 'unknown'
        END AS visibility_state,
        'video'::text AS media_type,
        CASE
          WHEN v.status IN ('pending', 'running') THEN 'processing'
          ELSE v.status
        END AS status,
        v.model,
        v.created_at
      FROM "video_generation" v
    ) fact
    CROSS JOIN LATERAL (
      VALUES ('global'::text, ''::text), ('owner'::text, fact.user_id)
    ) AS scope_row(scope_kind, owner_user_id)
    CROSS JOIN LATERAL (
      VALUES
        ('all_time'::text, DATE '0001-01-01'),
        ('day'::text, fact.created_at::date)
    ) AS bucket_row(bucket_kind, utc_day)
    GROUP BY
      scope_row.scope_kind,
      scope_row.owner_user_id,
      fact.visibility_state,
      fact.media_type,
      fact.status,
      fact.model,
      bucket_row.bucket_kind,
      bucket_row.utc_day
  ), drift AS (
    SELECT 1
    FROM expected e
    FULL OUTER JOIN "media_history_count_projection" p
      ON p.scope_kind = e.scope_kind
      AND p.owner_user_id = e.owner_user_id
      AND p.visibility_state = e.visibility_state
      AND p.media_type = e.media_type
      AND p.status = e.status
      AND p.model = e.model
      AND p.bucket_kind = e.bucket_kind
      AND p.utc_day = e.utc_day
    WHERE p.record_count IS DISTINCT FROM e.record_count
  )
  SELECT count(*)::bigint FROM drift;
$$;

-- 同口径事实边界计数。仅用于首尾不完整 UTC 日或 asOf 之后的通常空尾部。
CREATE OR REPLACE FUNCTION media_history_boundary_fact_count(
  p_scope_kind text,
  p_owner_user_id text,
  p_media_type text,
  p_status text,
  p_model text,
  p_start timestamp without time zone,
  p_end timestamp without time zone,
  p_as_of timestamp without time zone
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_image_count bigint := 0;
  v_video_count bigint := 0;
BEGIN
  IF p_scope_kind NOT IN ('global', 'owner') THEN
    RAISE EXCEPTION 'unsupported media history scope: %', p_scope_kind;
  END IF;
  IF p_scope_kind = 'owner' AND coalesce(p_owner_user_id, '') = '' THEN
    RETURN 0;
  END IF;

  IF p_media_type IS NULL OR p_media_type = 'image' THEN
    SELECT count(*)::bigint INTO v_image_count
    FROM "generation" g
    WHERE (p_scope_kind = 'global' OR g.user_id = p_owner_user_id)
      AND (p_start IS NULL OR g.created_at >= p_start)
      AND (p_end IS NULL OR g.created_at < p_end)
      AND g.created_at <= p_as_of
      AND (p_model IS NULL OR g.model = p_model)
      AND (
        p_status IS NULL OR
        (p_status = 'processing' AND g.status = 'pending') OR
        (p_status IN ('completed', 'failed') AND g.status::text = p_status)
      );
  END IF;

  IF p_media_type IS NULL OR p_media_type = 'video' THEN
    SELECT count(*)::bigint INTO v_video_count
    FROM "video_generation" v
    WHERE (p_scope_kind = 'global' OR v.user_id = p_owner_user_id)
      AND (p_start IS NULL OR v.created_at >= p_start)
      AND (p_end IS NULL OR v.created_at < p_end)
      AND v.created_at <= p_as_of
      AND (p_model IS NULL OR v.model = p_model)
      AND (
        p_status IS NULL OR
        (p_status = 'processing' AND v.status IN ('pending', 'running')) OR
        (p_status IN ('completed', 'failed') AND v.status = p_status)
      );
  END IF;

  RETURN v_image_count + v_video_count;
END;
$$;

-- 精确总数读取：无起始边界时用 all-time rollup 减通常为空的未来尾部；有边界时
-- 对完整 UTC 日求和，仅首尾两段回查事实索引，避免任意长日期范围扫描事实历史。
CREATE OR REPLACE FUNCTION media_history_exact_count(
  p_scope_kind text,
  p_owner_user_id text,
  p_media_type text,
  p_status text,
  p_model text,
  p_start timestamp without time zone,
  p_end timestamp without time zone,
  p_as_of timestamp without time zone
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_total bigint := 0;
  v_upper timestamp without time zone;
  v_upper_day timestamp without time zone;
  v_first_full_day date;
BEGIN
  IF p_scope_kind NOT IN ('global', 'owner') THEN
    RAISE EXCEPTION 'unsupported media history scope: %', p_scope_kind;
  END IF;
  IF p_scope_kind = 'owner' AND coalesce(p_owner_user_id, '') = '' THEN
    RETURN 0;
  END IF;
  IF p_media_type IS NOT NULL AND p_media_type NOT IN ('image', 'video') THEN
    RAISE EXCEPTION 'unsupported media history type: %', p_media_type;
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('processing', 'completed', 'failed') THEN
    RAISE EXCEPTION 'unsupported media history status: %', p_status;
  END IF;

  v_upper := CASE
    WHEN p_end IS NOT NULL AND p_end < p_as_of THEN p_end
    ELSE p_as_of
  END;
  IF p_start IS NOT NULL AND p_start >= v_upper THEN
    RETURN media_history_boundary_fact_count(
      p_scope_kind, p_owner_user_id, p_media_type, p_status, p_model,
      p_start, p_end, p_as_of
    );
  END IF;

  IF p_start IS NULL THEN
    SELECT coalesce(sum(p.record_count), 0)::bigint INTO v_total
    FROM "media_history_count_projection" p
    WHERE p.scope_kind = p_scope_kind
      AND p.owner_user_id = CASE
        WHEN p_scope_kind = 'global' THEN '' ELSE p_owner_user_id
      END
      AND p.bucket_kind = 'all_time'
      AND p.utc_day = DATE '0001-01-01'
      AND (p_media_type IS NULL OR p.media_type = p_media_type)
      AND (p_status IS NULL OR p.status = p_status)
      AND (p_model IS NULL OR p.model = p_model);

    v_total := v_total - media_history_boundary_fact_count(
      p_scope_kind, p_owner_user_id, p_media_type, p_status, p_model,
      p_as_of + INTERVAL '1 microsecond', NULL,
      timestamp '9999-12-31 23:59:59.999999'
    );
    IF p_end IS NOT NULL AND p_end <= p_as_of THEN
      v_total := v_total - media_history_boundary_fact_count(
        p_scope_kind, p_owner_user_id, p_media_type, p_status, p_model,
        p_end, NULL, p_as_of
      );
    END IF;
    RETURN greatest(v_total, 0);
  END IF;

  IF p_start::date = v_upper::date THEN
    RETURN media_history_boundary_fact_count(
      p_scope_kind, p_owner_user_id, p_media_type, p_status, p_model,
      p_start, p_end, p_as_of
    );
  END IF;

  v_upper_day := date_trunc('day', v_upper);
  v_first_full_day := CASE
    WHEN p_start = date_trunc('day', p_start) THEN p_start::date
    ELSE p_start::date + 1
  END;

  SELECT coalesce(sum(p.record_count), 0)::bigint INTO v_total
  FROM "media_history_count_projection" p
  WHERE p.scope_kind = p_scope_kind
    AND p.owner_user_id = CASE
      WHEN p_scope_kind = 'global' THEN '' ELSE p_owner_user_id
    END
    AND p.bucket_kind = 'day'
    AND p.utc_day >= v_first_full_day
    AND p.utc_day < v_upper_day::date
    AND (p_media_type IS NULL OR p.media_type = p_media_type)
    AND (p_status IS NULL OR p.status = p_status)
    AND (p_model IS NULL OR p.model = p_model);

  IF p_start <> date_trunc('day', p_start) THEN
    v_total := v_total + media_history_boundary_fact_count(
      p_scope_kind, p_owner_user_id, p_media_type, p_status, p_model,
      p_start, date_trunc('day', p_start) + INTERVAL '1 day', p_as_of
    );
  END IF;

  v_total := v_total + media_history_boundary_fact_count(
    p_scope_kind, p_owner_user_id, p_media_type, p_status, p_model,
    v_upper_day, p_end, p_as_of
  );
  RETURN greatest(v_total, 0);
END;
$$;

-- 建立维护机制后立即从权威事实执行一次可重入回填，并以漂移检查阻断错误迁移。
SELECT rebuild_media_history_count_projection();
DO $$
BEGIN
  IF media_history_count_projection_drift_count() <> 0 THEN
    RAISE EXCEPTION 'media history count projection backfill drifted';
  END IF;
END;
$$;
