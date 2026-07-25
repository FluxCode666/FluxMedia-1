-- 将旧图片生成记录的 Asia/Shanghai 墙上时间逐行归一化为 UTC。
--
-- 历史默认值 now() 受数据库会话时区影响，而应用显式 Date 与服务端 metadata 均使用
-- UTC。迁移连接自身已固定 UTC，不能再用当前迁移会话的时区推断旧口径；这里
-- 只把经生产证据确认的 Asia/Shanghai 作为旧候选，并让其他历史时区 fail-closed。
--
-- upstreamStream.startedAt 由服务端 Date.toISOString() 生成，是最强 UTC 锚点；早期缺少
-- 该字段的终态记录才回退 completed_at。两类证据冲突、锚点非法或无证据时整体回滚。
-- 迁移期间旧 Web 仍可能写入，因此先锁表，最后才原子切换后续默认值。
LOCK TABLE "generation" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  generation_count bigint;
  legacy_count bigint;
  utc_count bigint;
  ambiguous_count bigint;
  updated_count bigint;
  verification_failure_count bigint;
BEGIN
  CREATE TEMP TABLE "generation_0052_time_evidence" (
    "id" text PRIMARY KEY,
    "original_created_at" timestamp NOT NULL,
    "normalized_created_at" timestamp NOT NULL,
    "classification" text NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO "generation_0052_time_evidence" (
    "id",
    "original_created_at",
    "normalized_created_at",
    "classification"
  )
  WITH "raw_evidence" AS (
    SELECT
      "id",
      "created_at",
      "completed_at",
      "metadata" #>> '{upstreamStream,startedAt}' AS "started_at_text"
    FROM "generation"
  ),
  "time_candidates" AS (
    SELECT
      "id",
      "created_at",
      "completed_at",
      "started_at_text",
      COALESCE((
        "started_at_text" ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        AND pg_input_is_valid(
          "started_at_text",
          'timestamp with time zone'
        )
      ), false) AS "started_at_valid",
      CASE
        WHEN
          "started_at_text" ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
          AND pg_input_is_valid(
            "started_at_text",
            'timestamp with time zone'
          )
        THEN "started_at_text"::timestamptz AT TIME ZONE 'UTC'
      END AS "started_at_utc",
      "created_at" AS "utc_candidate",
      ("created_at" AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC'
        AS "legacy_candidate"
    FROM "raw_evidence"
  ),
  "classified_evidence" AS (
    SELECT
      "id",
      "created_at",
      "utc_candidate",
      "legacy_candidate",
      "started_at_text",
      "started_at_valid",
      "started_at_text" IS NOT NULL AND NOT "started_at_valid"
        AS "invalid_started_at",
      (
        "started_at_valid"
        AND abs(
          extract(epoch FROM "started_at_utc" - "legacy_candidate")
        ) <= 1
      ) AS "legacy_anchor_supported",
      (
        "started_at_valid"
        AND abs(
          extract(epoch FROM "started_at_utc" - "utc_candidate")
        ) <= 1
      ) AS "utc_anchor_supported",
      (
        "completed_at" IS NOT NULL
        AND "completed_at" - "legacy_candidate"
          BETWEEN interval '0 seconds' AND interval '45 minutes'
      ) AS "legacy_completed_supported",
      (
        "completed_at" IS NOT NULL
        AND "completed_at" - "utc_candidate"
          BETWEEN interval '0 seconds' AND interval '45 minutes'
      ) AS "utc_completed_supported"
    FROM "time_candidates"
  ),
  "classified_rows" AS (
    SELECT
      "id",
      "created_at",
      "legacy_candidate",
      CASE
        WHEN "invalid_started_at" THEN 'ambiguous'
        WHEN
          "started_at_valid"
          AND "legacy_anchor_supported"
          AND NOT "utc_anchor_supported"
          AND NOT "utc_completed_supported"
        THEN 'legacy'
        WHEN
          "started_at_valid"
          AND "utc_anchor_supported"
          AND NOT "legacy_anchor_supported"
          AND NOT "legacy_completed_supported"
        THEN 'utc'
        WHEN
          "started_at_text" IS NULL
          AND "legacy_completed_supported"
          AND NOT "utc_completed_supported"
        THEN 'legacy'
        WHEN
          "started_at_text" IS NULL
          AND "utc_completed_supported"
          AND NOT "legacy_completed_supported"
        THEN 'utc'
        ELSE 'ambiguous'
      END AS "classification"
    FROM "classified_evidence"
  )
  SELECT
    "id",
    "created_at",
    CASE
      WHEN "classification" = 'legacy' THEN "legacy_candidate"
      ELSE "created_at"
    END,
    "classification"
  FROM "classified_rows";

  SELECT
    count(*),
    count(*) FILTER (WHERE "classification" = 'legacy'),
    count(*) FILTER (WHERE "classification" = 'utc'),
    count(*) FILTER (WHERE "classification" = 'ambiguous')
  INTO
    generation_count,
    legacy_count,
    utc_count,
    ambiguous_count
  FROM "generation_0052_time_evidence";

  IF ambiguous_count > 0 THEN
    RAISE EXCEPTION
      '0052 无法逐行判断 generation 时间口径：总记录 % 条，旧口径 % 条，UTC 口径 % 条，不明确 % 条',
      generation_count,
      legacy_count,
      utc_count,
      ambiguous_count;
  END IF;

  UPDATE "generation" AS "generation_row"
  SET "created_at" = "evidence"."normalized_created_at"
  FROM "generation_0052_time_evidence" AS "evidence"
  WHERE "evidence"."classification" = 'legacy'
    AND "generation_row"."id" = "evidence"."id"
    AND "generation_row"."created_at" = "evidence"."original_created_at";

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> legacy_count THEN
    RAISE EXCEPTION
      '0052 generation 更新时间数量不一致：应更新 % 条，实际更新 % 条',
      legacy_count,
      updated_count;
  END IF;

  SELECT count(*)
  INTO verification_failure_count
  FROM "generation" AS "generation_row"
  JOIN "generation_0052_time_evidence" AS "evidence"
    ON "evidence"."id" = "generation_row"."id"
  WHERE "generation_row"."created_at"
    IS DISTINCT FROM "evidence"."normalized_created_at";

  IF verification_failure_count > 0 THEN
    RAISE EXCEPTION
      '0052 generation 时间归一化后仍有 % 条不一致记录',
      verification_failure_count;
  END IF;

  ALTER TABLE "generation"
    ALTER COLUMN "created_at"
    SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');

  RAISE NOTICE
    '0052 generation 时间归一化完成：总记录 % 条，旧口径更新 % 条，UTC 口径保留 % 条',
    generation_count,
    updated_count,
    utc_count;
END $$;
