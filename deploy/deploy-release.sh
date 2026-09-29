#!/usr/bin/env bash
# FluxMedia 生产发布执行器：在目标服务器上把一个已发布版本切换为线上运行版本。
#
# 使用方：
#   - apply-release.sh（由 GitHub Actions Deploy Production 与站内系统更新器共同调用）。
# 参数：<app_image> <app_digest> <image_tag> <deploy_path> <git_sha>
# 前置：deploy_path 中已由 apply-release.sh 原子放置同一 Release 部署包内的全部文件
# （docker-compose.next.yml、备份/门禁/恢复脚本、Nginx 配置与路由 smoke）。
# 关键不变量：迁移前任何失败都恢复上一版；迁移标记落盘后只保持维护状态，
# 绝不自动启动旧 schema 镜像。标准输出中的 key=value 行是部署安全证据，调用方会校验。
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "用法：deploy-release.sh <app_image> <app_digest> <image_tag> <deploy_path> <git_sha>" >&2
  exit 2
fi

app_image="$1"
app_digest="$2"
image_tag="$3"
deploy_path="$4"
git_sha="$5"
app_ref="${app_image}@${app_digest}"
cd "${deploy_path}"

if [ ! -f .env ]; then
  echo "目标服务器缺少 ${deploy_path}/.env，请先从 deploy/.env.example 创建并填写。" >&2
  exit 1
fi
if [ ! -f docker-compose.yml ] || [ ! -f docker-compose.next.yml ]; then
  echo "目标服务器缺少现役或候选 Compose，拒绝拓扑迁移。" >&2
  exit 1
fi
if [ ! -f read-env-value.sh ]; then
  echo "目标服务器缺少部署 dotenv 读取器。" >&2
  exit 1
fi
if [ ! -f create-database-backup.sh ]; then
  echo "目标服务器缺少数据库备份脚本。" >&2
  exit 1
fi
if [ ! -f read-release-ledger-digest.sh ]; then
  echo "目标服务器缺少发布门禁账本摘要读取器。" >&2
  exit 1
fi
if [ ! -f release-recovery-policy.sh ]; then
  echo "目标服务器缺少发布恢复策略脚本。" >&2
  exit 1
fi
if [ ! -f fluxmedia.conf ] || [ ! -f smoke-production-routing.sh ]; then
  echo "目标服务器缺少 Nginx 配置或公网路由 smoke 脚本。" >&2
  exit 1
fi
if [ ! -f install-system-updater.sh ]; then
  echo "目标服务器缺少站内系统更新器安装脚本。" >&2
  exit 1
fi

# 用受测解析器读取单行 dotenv。
# 不会 source/eval 配置或打印其他值。
read_env_value() {
  key="$1"
  bash ./read-env-value.sh .env "${key}"
}

require_env_value() {
  key="$1"
  value=""
  if ! value="$(read_env_value "${key}")" || [ -z "${value}" ]; then
    echo "生产 .env 缺少 ${key}，拒绝进入部署流程。" >&2
    return 1
  fi
}

# 只更新流水线托管的镜像元数据键。
set_env_value() {
  key="$1"
  value="$2"
  if grep -q "^${key}=" .env; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" .env
    rm -f .env.bak
  else
    printf '%s=%s\n' "${key}" "${value}" >> .env
  fi
}

replace_nginx_configuration_atomically() {
  local source_path="$1"
  local target_path="$2"
  local target_directory="${target_path%/*}"
  local target_name="${target_path##*/}"
  local target_tmp="${target_directory}/.${target_name}.tmp.$$"

  if ! install -m 600 "${source_path}" "${target_tmp}"; then
    rm -f "${target_tmp}"
    return 1
  fi
  if ! chown --reference="${target_path}" "${target_tmp}" \
    || ! chmod --reference="${target_path}" "${target_tmp}" \
    || ! mv -f "${target_tmp}" "${target_path}"; then
    rm -f "${target_tmp}"
    return 1
  fi
}

# 先备份并原子安装版本化 Nginx 配置。语法或 reload 失败时同样
# 原子恢复原配置；此时应用尚未停服。
install_nginx_configuration() {
  nginx_target=/etc/nginx/conf.d/fluxmedia.conf
  nginx_backup_dir="${deploy_path}/config-backups"
  nginx_backup_path="${nginx_backup_dir}/fluxmedia.conf.$(date -u +%Y%m%dT%H%M%SZ).before-${image_tag}"
  if [ ! -f "${nginx_target}" ]; then
    echo "目标服务器缺少现有 Nginx 站点配置，拒绝无备份覆盖。" >&2
    return 1
  fi
  install -d -m 750 "${nginx_backup_dir}"
  install -m 644 "${nginx_target}" "${nginx_backup_path}"
  replace_nginx_configuration_atomically \
    fluxmedia.conf "${nginx_target}"
  if ! nginx -t; then
    replace_nginx_configuration_atomically \
      "${nginx_backup_path}" "${nginx_target}"
    nginx -t
    echo "新 Nginx 配置校验失败，已恢复原配置。" >&2
    return 1
  fi
  if ! systemctl reload nginx; then
    replace_nginx_configuration_atomically \
      "${nginx_backup_path}" "${nginx_target}"
    nginx -t
    systemctl reload nginx
    echo "Nginx reload 失败，已恢复原配置。" >&2
    return 1
  fi
  nginx_configuration_installed=true
  printf 'nginx_config_backup=%s\n' "${nginx_backup_path}"
}

restore_previous_nginx_configuration() {
  if [ "${nginx_configuration_installed}" != "true" ]; then
    return 0
  fi
  if ! replace_nginx_configuration_atomically \
    "${nginx_backup_path}" /etc/nginx/conf.d/fluxmedia.conf \
    || ! nginx -t \
    || ! systemctl reload nginx; then
    echo "上一版 Nginx 配置恢复失败。" >&2
    return 1
  fi
  nginx_configuration_installed=false
}

active_compose() {
  docker compose \
    --env-file "${deploy_path}/.env" \
    -f docker-compose.yml --project-name fluxmedia "$@"
}

candidate_compose() {
  FLUXMEDIA_APP_IMAGE_REF="${app_ref}" \
  FLUXMEDIA_RELEASE_TAG="${image_tag}" \
    docker compose \
      --env-file "${deploy_path}/.env" \
      -f docker-compose.next.yml --project-name fluxmedia "$@"
}

# 使用候选统一镜像运行只读数据库门禁，不启动常驻进程。
run_release_gate() {
  gate="$1"
  expected_ledger_digest="${2:-}"
  if [ -n "${expected_ledger_digest}" ]; then
    candidate_compose run --rm --no-deps \
      --interactive=false \
      -e "RELEASE_CREDITS_LEDGER_DIGEST=${expected_ledger_digest}" \
      -e GO_BACKEND_SKIP_MIGRATION=true app \
      node apps/web/scripts/release-governance-gate.mjs "${gate}" \
      </dev/null
  else
    candidate_compose run --rm --no-deps \
      --interactive=false -e GO_BACKEND_SKIP_MIGRATION=true app \
      node apps/web/scripts/release-governance-gate.mjs "${gate}" \
      </dev/null
  fi
}

# 用本次新 Web 镜像编译旧 parameterMappings/requestTransformScript
# 经 0075/0077 将生成的脚本，并确认非终态 API 视频已排空。
# 命令只输出脱敏 JSON 证据。
run_api_upstream_adapter_preflight() {
  candidate_compose run --rm --no-deps \
    --interactive=false app \
    node apps/web/scripts/preflight-api-upstream-adapter-migration.mjs \
    </dev/null
}

# 旧 schema 输入全部复制为任务对象；0074 已完成时命令是幂等空操作。
run_video_input_asset_migration() {
  candidate_compose run --rm --no-deps \
    --interactive=false \
    --volume "${storage_path}:/app/storage" \
    --volume "${deploy_path}/state:/app/state" \
    -e GO_BACKEND_SKIP_MIGRATION=true \
    -e "VIDEO_INPUT_ROLLBACK_MANIFEST=/app/state/video-input-rollback-${image_tag}.ndjson" \
    app \
    node apps/web/scripts/migrate-video-input-assets.mjs migrate \
    --confirm-no-legacy-writers </dev/null
}

# state 必须由镜像内的非 root 用户持有，且不可向同机其他用户开放。
prepare_video_input_migration_state() {
  app_uid="$(docker run --rm --entrypoint id "${app_ref}" -u)"
  app_gid="$(docker run --rm --entrypoint id "${app_ref}" -g)"
  if ! [[ "${app_uid}" =~ ^[0-9]+$ ]] \
    || ! [[ "${app_gid}" =~ ^[0-9]+$ ]]; then
    echo "无法确定统一应用镜像的运行用户，拒绝创建迁移状态目录。" >&2
    return 1
  fi
  storage_path=/root/docker-data/fluxmedia
  if [ -L "${storage_path}" ]; then
    echo "生产存储路径不能是符号链接，拒绝挂载。" >&2
    return 1
  fi
  if [ ! -d "${storage_path}" ]; then
    install -d -m 750 -o "${app_uid}" -g "${app_gid}" "${storage_path}"
  elif ! docker run --rm --entrypoint sh \
    --user "${app_uid}:${app_gid}" \
    --volume "${storage_path}:/app/storage" \
    "${app_ref}" -c 'test -w /app/storage'; then
    if [ -n "$(find "${storage_path}" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      echo "生产存储目录已有内容但统一应用用户不可写，拒绝迁移。" >&2
      return 1
    fi
    chown "${app_uid}:${app_gid}" "${storage_path}"
    chmod 750 "${storage_path}"
  fi
  install -d -m 700 \
    -o "${app_uid}" -g "${app_gid}" "${deploy_path}/state"
}

# 统计迁移只创建 building 状态；必须使用新 Web 镜像补齐事实、汇总并零差异
# 对账后才能启动页面。已 ready 的当前版本逐模型跳过，避免每次发布重复全扫。
run_dashboard_analytics_backfill() {
  candidate_compose run --rm --no-deps \
    --interactive=false app \
    node apps/web/scripts/backfill-dashboard-analytics.mjs \
    --batch-size=500 --skip-ready </dev/null
}

# 首次部署运营总览时，以生产 APP_TIME_ZONE 的当前自然日初始化不可变 epoch；
# 后续发布读取已有值并成功跳过，绝不按新的部署日期改写历史事实。
run_operations_epoch_gate() {
  active_compose exec -T \
    -e "OPERATIONS_EPOCH_INITIALIZED_BY=release-${image_tag}" \
    app /usr/local/bin/fluxmedia-entrypoint \
    node /app/services/unified-runtime/ensure-operations-epoch.mjs \
    </dev/null
}

remove_env_key() {
  key="$1"
  sed -i.bak "/^${key}=/d" .env
  rm -f .env.bak
}

# 仅在迁移开始前恢复旧镜像元数据；是否重启由退出状态机决定。
restore_previous_metadata() {
  if [ -n "${previous_app_ref}" ]; then
    set_env_value FLUXMEDIA_APP_IMAGE_REF "${previous_app_ref}"
  else
    remove_env_key FLUXMEDIA_APP_IMAGE_REF
  fi
  if [ -n "${previous_release_tag}" ]; then
    set_env_value FLUXMEDIA_RELEASE_TAG "${previous_release_tag}"
  else
    remove_env_key FLUXMEDIA_RELEASE_TAG
  fi
}

release_state_dir="${deploy_path}/release-state"
migration_marker="${release_state_dir}/migration-in-progress.env"
deployment_attempt="${release_state_dir}/deployment-attempt.env"

for required_key in DATABASE_URL BETTER_AUTH_SECRET REDIS_HOST REDIS_PASSWORD CRON_SECRET; do
  require_env_value "${required_key}"
done
bind_host="$(read_env_value BIND_HOST)"
bind_host="${bind_host:-127.0.0.1}"
web_port="$(read_env_value WEB_PORT)"
web_port="${web_port:-3000}"
backend_port="$(read_env_value GO_BACKEND_PORT)"
backend_port="${backend_port:-3001}"
if [ "${bind_host}" != "127.0.0.1" ] \
  || [ "${web_port}" != "3000" ] \
  || [ "${backend_port}" != "3001" ]; then
  echo "生产 .env 的 BIND_HOST/WEB_PORT/GO_BACKEND_PORT 必须为 127.0.0.1/3000/3001。" >&2
  exit 1
fi

activate_compose_file() {
  source_path="$1"
  compose_tmp="${deploy_path}/.docker-compose.yml.tmp.$$"
  install -m 640 "${source_path}" "${compose_tmp}"
  mv -f "${compose_tmp}" "${deploy_path}/docker-compose.yml"
}

write_migration_marker() {
  marker_tmp="${migration_marker}.tmp.$$"
  install -d -m 700 "${release_state_dir}"
  (
    umask 077
    {
      printf 'MIGRATION_STARTED=true\n'
      printf 'APP_IMAGE_REF=%s\n' "${app_ref}"
      printf 'RELEASE_TAG=%s\n' "${image_tag}"
      printf 'GIT_SHA=%s\n' "${git_sha}"
    } > "${marker_tmp}"
  )
  mv -f "${marker_tmp}" "${migration_marker}"
}

write_deployment_attempt() {
  attempt_tmp="${deployment_attempt}.tmp.$$"
  install -d -m 700 "${release_state_dir}"
  (
    umask 077
    {
      printf 'ATTEMPT_STARTED=true\n'
      printf 'PREVIOUS_LAYOUT=%s\n' "${previous_layout}"
      printf 'PREVIOUS_COMPOSE_PATH=%s\n' "${previous_compose_path}"
      printf 'NGINX_BACKUP_PATH=%s\n' "${nginx_backup_path}"
      printf 'PREVIOUS_APP_IMAGE_REF=%s\n' "${previous_app_ref}"
      printf 'PREVIOUS_RELEASE_TAG=%s\n' "${previous_release_tag}"
      printf 'PREVIOUS_IMAGE=%s\n' "${previous_image}"
      printf 'PREVIOUS_BACKEND_IMAGE=%s\n' "${previous_backend_image}"
      printf 'PREVIOUS_SCRIPT_RUNTIME_IMAGE=%s\n' "${previous_script_runtime_image}"
      printf 'PREVIOUS_MEDIA_PROCESSING_IMAGE=%s\n' "${previous_media_processing_image}"
      printf 'PREVIOUS_TAG=%s\n' "${previous_tag}"
      printf 'TARGET_APP_IMAGE_REF=%s\n' "${app_ref}"
      printf 'TARGET_RELEASE_TAG=%s\n' "${image_tag}"
      printf 'TARGET_GIT_SHA=%s\n' "${git_sha}"
    } > "${attempt_tmp}"
  )
  mv -f "${attempt_tmp}" "${deployment_attempt}"
}

active_services="$(active_compose config --services)"
previous_layout=unknown
if printf '%s\n' "${active_services}" | grep -qx app; then
  previous_layout=unified
elif for required_service in web backend script-runtime media-processing; do
  printf '%s\n' "${active_services}" | grep -qx "${required_service}" || exit 1
done; then
  previous_layout=legacy
fi
if [ "${previous_layout}" = "unknown" ]; then
  echo "无法识别现役 Compose 拓扑，拒绝部署。" >&2
  exit 1
fi

previous_app_ref="$(read_env_value FLUXMEDIA_APP_IMAGE_REF)"
previous_release_tag="$(read_env_value FLUXMEDIA_RELEASE_TAG)"
previous_image="$(read_env_value FLUXMEDIA_IMAGE)"
previous_backend_image="$(read_env_value FLUXMEDIA_BACKEND_IMAGE)"
previous_script_runtime_image="$(read_env_value FLUXMEDIA_SCRIPT_RUNTIME_IMAGE)"
previous_media_processing_image="$(read_env_value FLUXMEDIA_MEDIA_PROCESSING_IMAGE)"
previous_tag="$(read_env_value FLUXMEDIA_TAG)"
maintenance_resume=false
if [ -f "${migration_marker}" ]; then
  marker_started="$(
    bash ./read-env-value.sh "${migration_marker}" MIGRATION_STARTED
  )"
  marker_app_ref="$(
    bash ./read-env-value.sh "${migration_marker}" APP_IMAGE_REF
  )"
  marker_release_tag="$(
    bash ./read-env-value.sh "${migration_marker}" RELEASE_TAG
  )"
  marker_git_sha="$(
    bash ./read-env-value.sh "${migration_marker}" GIT_SHA
  )"
  if [ "${marker_started}" != "true" ] \
    || [[ ! "${marker_app_ref}" =~ ^[A-Za-z0-9._/@:-]+@sha256:[a-f0-9]{64}$ ]] \
    || [[ ! "${marker_release_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$ ]] \
    || [[ ! "${marker_git_sha}" =~ ^[a-f0-9]{40}$ ]]; then
    echo "生产迁移标记无效，拒绝自动恢复。" >&2
    exit 1
  fi
  maintenance_resume=true
  printf 'maintenance_resume=true\n'
  printf 'migration_marker_image=%s\n' "${marker_app_ref}"
fi

previous_release_available=false
if [ "${previous_layout}" = "unified" ] \
  && [[ "${previous_app_ref}" =~ ^[A-Za-z0-9._/@:-]+@sha256:[a-f0-9]{64}$ ]]; then
  previous_release_available=true
  printf 'previous_release=%s\n' "${previous_app_ref}"
elif [ "${previous_layout}" = "legacy" ] \
  && [[ "${previous_image}" =~ ^[A-Za-z0-9._/@:-]+$ ]] \
  && [[ "${previous_backend_image}" =~ ^[A-Za-z0-9._/@:-]+$ ]] \
  && [[ "${previous_script_runtime_image}" =~ ^[A-Za-z0-9._/@:-]+$ ]] \
  && [[ "${previous_media_processing_image}" =~ ^[A-Za-z0-9._/@:-]+$ ]] \
  && [[ "${previous_tag}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  previous_release_available=true
  printf 'previous_release=%s:%s\n' \
    "${previous_image}" "${previous_tag}"
else
  printf 'previous_release=unknown\n'
fi
if [ "${maintenance_resume}" != "true" ] \
  && [ "${previous_release_available}" != "true" ]; then
  echo "无法验证上一版镜像元数据，拒绝进入生产停机窗口。" >&2
  exit 1
fi

recover_interrupted_pre_migration_attempt() {
  if [ ! -f "${deployment_attempt}" ]; then
    return 0
  fi
  if [ "${maintenance_resume}" = "true" ]; then
    echo "迁移标记优先于旧发布尝试账本，继续前向恢复。"
    return 0
  fi

  attempt_started="$(bash ./read-env-value.sh "${deployment_attempt}" ATTEMPT_STARTED)"
  attempt_layout="$(bash ./read-env-value.sh "${deployment_attempt}" PREVIOUS_LAYOUT)"
  attempt_compose="$(bash ./read-env-value.sh "${deployment_attempt}" PREVIOUS_COMPOSE_PATH)"
  attempt_nginx="$(bash ./read-env-value.sh "${deployment_attempt}" NGINX_BACKUP_PATH)"
  attempt_app_ref="$(bash ./read-env-value.sh "${deployment_attempt}" PREVIOUS_APP_IMAGE_REF)"
  attempt_release_tag="$(bash ./read-env-value.sh "${deployment_attempt}" PREVIOUS_RELEASE_TAG)"
  attempt_image="$(bash ./read-env-value.sh "${deployment_attempt}" PREVIOUS_IMAGE)"
  attempt_backend_image="$(bash ./read-env-value.sh "${deployment_attempt}" PREVIOUS_BACKEND_IMAGE)"
  attempt_script_image="$(bash ./read-env-value.sh "${deployment_attempt}" PREVIOUS_SCRIPT_RUNTIME_IMAGE)"
  attempt_media_image="$(bash ./read-env-value.sh "${deployment_attempt}" PREVIOUS_MEDIA_PROCESSING_IMAGE)"
  attempt_tag="$(bash ./read-env-value.sh "${deployment_attempt}" PREVIOUS_TAG)"

  if [ "${attempt_started}" != "true" ] \
    || [ "${attempt_layout}" != "${previous_layout}" ]; then
    echo "部署尝试账本与现役拓扑不一致，拒绝自动恢复。" >&2
    return 1
  fi
  case "${attempt_compose}" in
    "${deploy_path}"/compose-history/docker-compose.before-*.yml) ;;
    *)
      echo "部署尝试账本中的 Compose 路径无效。" >&2
      return 1
      ;;
  esac
  case "${attempt_nginx}" in
    "${deploy_path}"/config-backups/fluxmedia.conf.*) ;;
    *)
      echo "部署尝试账本中的 Nginx 路径无效。" >&2
      return 1
      ;;
  esac
  if [ ! -f "${attempt_compose}" ] || [ ! -f "${attempt_nginx}" ]; then
    echo "部署尝试账本引用的恢复文件不存在。" >&2
    return 1
  fi
  if [ "${attempt_layout}" = "unified" ]; then
    if [ "${attempt_app_ref}" != "${previous_app_ref}" ] \
      || [ "${attempt_release_tag}" != "${previous_release_tag}" ]; then
      echo "统一应用恢复镜像与部署尝试账本不一致。" >&2
      return 1
    fi
    interrupted_services=(app)
  else
    if [ "${attempt_image}" != "${previous_image}" ] \
      || [ "${attempt_backend_image}" != "${previous_backend_image}" ] \
      || [ "${attempt_script_image}" != "${previous_script_runtime_image}" ] \
      || [ "${attempt_media_image}" != "${previous_media_processing_image}" ] \
      || [ "${attempt_tag}" != "${previous_tag}" ]; then
      echo "旧四服务恢复镜像与部署尝试账本不一致。" >&2
      return 1
    fi
    interrupted_services=(web backend script-runtime media-processing)
  fi

  echo "检测到迁移边界前中断，先恢复上一版应用与 Nginx。"
  replace_nginx_configuration_atomically \
    "${attempt_nginx}" /etc/nginx/conf.d/fluxmedia.conf
  nginx -t
  systemctl reload nginx
  docker compose \
    --project-directory "${deploy_path}" \
    --env-file "${deploy_path}/.env" \
    -f "${attempt_compose}" \
    --project-name fluxmedia up -d --no-deps \
    "${interrupted_services[@]}"
  for service in "${interrupted_services[@]}"; do
    if [ -z "$(docker compose \
      --project-directory "${deploy_path}" \
      --env-file "${deploy_path}/.env" \
      -f "${attempt_compose}" \
      --project-name fluxmedia ps -q --status running "${service}")" ]; then
      echo "中断恢复后 ${service} 未运行，保留账本并停止发布。" >&2
      return 1
    fi
  done
  rm -f "${deployment_attempt}"
  echo "上一版应用已恢复，继续本次发布。"
}

recover_interrupted_pre_migration_attempt
cron_secret="$(read_env_value CRON_SECRET)"
if [ "${#cron_secret}" -lt 32 ]; then
  echo "生产 .env 缺少至少 32 字符的 CRON_SECRET，拒绝停服。" >&2
  exit 1
fi
unset cron_secret
# 停服前先确认当前配置能创建恢复点。未配置 S3 时，备份脚本会使用
# deploy-path/backups 下的持久化本地目录，不会跳过数据库备份。
bash ./create-database-backup.sh \
  preflight .env "${deploy_path}" "${image_tag}" "${git_sha}"

application_stopped="${maintenance_resume}"
migration_started="${maintenance_resume}"
deployment_succeeded=false
previous_application_was_running=false
nginx_configuration_installed=false
nginx_backup_path=""
install -d -m 750 "${deploy_path}/compose-history"
previous_compose_path="${deploy_path}/compose-history/docker-compose.before-${image_tag}-$(date -u +%Y%m%dT%H%M%SZ).yml"
install -m 640 docker-compose.yml "${previous_compose_path}"

previous_compose() {
  docker compose \
    --project-directory "${deploy_path}" \
    --env-file "${deploy_path}/.env" \
    -f "${previous_compose_path}" \
    --project-name fluxmedia "$@"
}

# 迁移前允许恢复旧服务；迁移开始后只保持维护状态。
handle_deployment_exit() {
  status="$?"
  recovery_action="keep-maintenance"
  if [ "${status}" -eq 0 ] || [ "${deployment_succeeded}" = "true" ]; then
    return
  fi

  # The marker is the durable authority. This closes the signal or
  # SSH-loss window between its atomic rename and the next shell
  # assignment.
  if [ -f "${migration_marker}" ]; then
    migration_started=true
  fi

  if ! recovery_action="$(
    bash ./release-recovery-policy.sh \
      "${migration_started}" \
      "${application_stopped}" \
      "${previous_application_was_running}" \
      "${previous_release_available}"
  )"; then
    echo "发布恢复策略执行失败，保持维护状态。" >&2
    recovery_action="keep-maintenance"
  fi

  if [ "${recovery_action}" = "keep-maintenance" ] \
    && [ "${migration_started}" = "true" ]; then
    echo "迁移已开始：保持维护状态，禁止自动启动旧 schema 镜像。" >&2
    active_compose stop --timeout 30 app >/dev/null 2>&1 || true
    return "${status}"
  fi

  if ! restore_previous_nginx_configuration; then
    recovery_action="keep-maintenance"
  fi

  restore_previous_metadata
  if [ "${recovery_action}" = "restart-previous" ]; then
    echo "迁移尚未开始，恢复原本运行的上一版应用。" >&2
    activate_compose_file "${previous_compose_path}"
    if [ "${previous_layout}" = "legacy" ]; then
      previous_services=(web backend script-runtime media-processing)
    else
      previous_services=(app)
    fi
    if ! previous_compose up -d --no-deps \
      "${previous_services[@]}" >/dev/null 2>&1; then
      echo "上一版服务恢复失败，保持维护状态。" >&2
    else
      rm -f "${deployment_attempt}"
    fi
  elif [ "${recovery_action}" = "keep-maintenance" ] \
    && [ "${application_stopped}" = "true" ]; then
    echo "缺少可证明安全的上一版运行状态，保持维护状态。" >&2
  fi
  return "${status}"
}
trap handle_deployment_exit EXIT

candidate_compose config --quiet
resolved_image="$(candidate_compose config --images)"
if [ "${resolved_image}" != "${app_ref}" ]; then
  echo "候选 Compose 未解析为本次 digest 固定镜像，拒绝部署。" >&2
  exit 1
fi
install_nginx_configuration

if ! candidate_compose pull app; then
  exit 1
fi

echo "在停服前烟测统一应用镜像与数据库门禁。"
# tee 同时保留成功输出供后续判断，并在失败退出前回放阻断证据。
preliminary_preflight="$(
  run_release_gate preflight-early | tee /dev/stderr
)"
if printf '%s\n' "${preliminary_preflight}" \
  | grep -qx 'relay_only_column=present'; then
  initial_governance_migration=true
else
  initial_governance_migration=false
fi

# Validate the non-root image user and storage permissions before any
# production service is stopped.
prepare_video_input_migration_state

# 站内系统更新器的请求/状态目录是候选 Compose 的 bind mount 源，必须在任何
# app 容器启动前以镜像运行用户准备好；此时仍处于可恢复的停服前阶段。
bash ./install-system-updater.sh \
  --deploy-path "${deploy_path}" \
  --app-uid "${app_uid}" \
  --app-gid "${app_gid}"

echo "进入维护状态并停止旧应用服务。"
if [ "${previous_layout}" = "legacy" ]; then
  previous_services=(web backend script-runtime media-processing)
else
  previous_services=(app)
fi
previous_application_was_running=true
for service in "${previous_services[@]}"; do
  if [ -z "$(previous_compose ps -q --status running "${service}")" ]; then
    previous_application_was_running=false
  fi
done
if [ "${maintenance_resume}" != "true" ] \
  && [ "${previous_application_was_running}" != "true" ]; then
  echo "上一版应用并非全部运行，拒绝进入无法自动恢复的停机窗口。" >&2
  exit 1
fi
if [ "${maintenance_resume}" != "true" ]; then
  # 在可能只停掉部分服务之前持久化恢复依据。硬中断后的下一次
  # workflow 会先幂等恢复该 Compose、镜像元数据与 Nginx。
  write_deployment_attempt
fi
# 持久恢复账本已经落盘；stop 前再设置进程内停服状态，使普通命令失败时
# EXIT trap 也会幂等地重新拉起完整上一版拓扑。
application_stopped=true
if ! previous_compose stop --timeout 60 "${previous_services[@]}"; then
  echo "停止上一版应用失败，尝试恢复完整上一版拓扑。" >&2
  exit 1
fi
for service in "${previous_services[@]}"; do
  if [ -n "$(previous_compose ps -q --status running "${service}")" ]; then
    echo "旧应用容器仍在运行，拒绝迁移。" >&2
    exit 1
  fi
done

run_release_gate drain
run_release_gate preflight-early
run_api_upstream_adapter_preflight

echo "创建迁移前数据库备份并校验最终存储。"
bash ./create-database-backup.sh \
  create .env "${deploy_path}" "${image_tag}" "${git_sha}"

# 从下一步持久标记开始进入不可逆迁移边界：先原子记录目标版本，再切换
# 镜像元数据和 Compose，最后执行资产与数据库迁移。标记落盘后的任何失败
# 都只能保持维护并前向恢复，绝不重新启动旧 schema 镜像。
write_migration_marker
migration_started=true
set_env_value FLUXMEDIA_APP_IMAGE_REF "${app_ref}"
set_env_value FLUXMEDIA_RELEASE_TAG "${image_tag}"
activate_compose_file docker-compose.next.yml
echo "收编历史视频输入资产。"
run_video_input_asset_migration
release_preflight="$(
  run_release_gate preflight | tee /dev/stderr
)"
release_credits_ledger_digest="$(
  printf '%s\n' "${release_preflight}" \
    | bash ./read-release-ledger-digest.sh
)"

echo "执行数据库迁移。"
# 迁移容器不得继承调用方 stdin（SSH 会话或 systemd），否则可能吞掉后续
# web 启动与健康检查命令，并让未完成的部署被误判为成功。
if ! active_compose run --rm --no-deps --interactive=false \
  -e GO_BACKEND_SKIP_MIGRATION=false app /backend --migrate </dev/null; then
  echo "数据库迁移失败，保持维护状态等待恢复备份或前向修复。" >&2
  exit 1
fi

if [ "${initial_governance_migration}" = "true" ]; then
  run_release_gate \
    postcheck-initial "${release_credits_ledger_digest}"
else
  run_release_gate postcheck "${release_credits_ledger_digest}"
fi

echo "回填并对账控制台统计读模型。"
if ! run_dashboard_analytics_backfill; then
  echo "控制台统计回填或对账失败，保持维护状态等待前向修复。" >&2
  exit 1
fi

echo "启动统一应用服务。"
if ! active_compose up -d --remove-orphans app; then
  echo "统一应用启动失败，保持维护状态。" >&2
  exit 1
fi

echo "确保运营总览生产统计起点已初始化。"
if ! run_operations_epoch_gate; then
  echo "运营总览生产统计起点初始化失败，停止新 Web 并保持维护状态。" >&2
  exit 1
fi

app_container_id="$(active_compose ps -q app)"
if [ -z "${app_container_id}" ]; then
  echo "未找到统一应用容器。" >&2
  exit 1
fi

for attempt in $(seq 1 30); do
  app_health_status="$(
    docker inspect --format \
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "${app_container_id}"
  )"
  if [ "${app_health_status}" = "healthy" ]; then
    echo "统一应用四个内部进程均已通过健康检查。"
    bash ./smoke-production-routing.sh \
      https://media.flux-code.cc https://media.fluxhall.cc
    application_stopped=false
    deployment_succeeded=true
    rm -f "${migration_marker}" "${deployment_attempt}"
    printf 'deployed_image_ref=%s\n' "${app_ref}"
    printf 'deployment_completed=true\n'
    if ! docker image prune -f --filter "until=168h"; then
      echo "统一应用已部署，但旧镜像清理失败；保留镜像并继续。" >&2
    fi
    trap - EXIT
    exit 0
  fi
  if [ "${app_health_status}" = "unhealthy" ] \
    || [ "${app_health_status}" = "exited" ]; then
    break
  fi
  echo "等待统一应用健康检查：${attempt}/30，当前状态=${app_health_status}。"
  sleep 10
done

active_compose logs --tail=200 app >&2
echo "统一应用健康检查失败，保持维护状态且不启动旧镜像。" >&2
exit 1
