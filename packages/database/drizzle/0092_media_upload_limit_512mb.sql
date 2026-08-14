-- 将视频持久化输入清单的单次总量上限从 200 MiB 提升到 512 MiB。
-- WHY：数据库继续显式拒绝单文件超过 200 MiB；这里只把多个输入的合计值提升，
-- 避免后台允许保存 512 MiB 后，数据库约束仍按历史总量拒绝任务持久化。
DO $migration$
DECLARE
  function_identity constant text :=
    'public.video_input_manifest_is_valid(json,text,text,text)';
  function_oid regprocedure := to_regprocedure(function_identity);
  function_definition text;
  legacy_total_limit_count integer;
  file_limit_count integer;
  new_total_limit_count integer;
BEGIN
  IF function_oid IS NULL THEN
    RAISE EXCEPTION '0092 blocked: required function % is missing',
      function_identity;
  END IF;

  SELECT pg_get_functiondef(function_oid)
  INTO function_definition;
  IF function_definition NOT LIKE 'CREATE OR REPLACE FUNCTION%' THEN
    RAISE EXCEPTION '0092 blocked: unexpected function definition for %',
      function_identity;
  END IF;

  legacy_total_limit_count := (
    length(function_definition)
    - length(replace(
      function_definition,
      'total_bytes > 209715200',
      ''
    ))
  ) / length('total_bytes > 209715200');
  file_limit_count := (
    length(function_definition)
    - length(replace(
      function_definition,
      'byte_count > 209715200',
      ''
    ))
  ) / length('byte_count > 209715200');
  new_total_limit_count := (
    length(function_definition)
    - length(replace(
      function_definition,
      'total_bytes > 536870912',
      ''
    ))
  ) / length('total_bytes > 536870912');

  IF legacy_total_limit_count = 1
    AND file_limit_count = 0
    AND new_total_limit_count = 0
  THEN
    EXECUTE replace(
      function_definition,
      'total_bytes > 209715200',
      'byte_count > 209715200 OR total_bytes > 536870912'
    );
  ELSIF NOT (
    legacy_total_limit_count = 0
    AND file_limit_count = 1
    AND new_total_limit_count = 1
  ) THEN
    RAISE EXCEPTION
      '0092 blocked: unexpected media limit constants in function %',
      function_identity;
  END IF;

  SELECT pg_get_functiondef(function_oid)
  INTO function_definition;
  IF position('total_bytes > 209715200' IN function_definition) > 0
    OR position('byte_count > 209715200' IN function_definition) = 0
    OR position('total_bytes > 536870912' IN function_definition) = 0
  THEN
    RAISE EXCEPTION '0092 failed to update function %', function_identity;
  END IF;
END;
$migration$;
