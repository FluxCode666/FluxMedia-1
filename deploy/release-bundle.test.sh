#!/usr/bin/env bash
# 发布部署包与站内系统更新器的回归测试（需 Linux：flock、GNU coreutils）。
# 覆盖：manifest 严格解析、部署包构建/下载/校验、路径穿越拒绝、更新器安装、
# runner 从请求到落地发布的完整链路，以及降级、非法请求、符号链接请求的拒绝。
# 使用 file:// 下载源与桩 deploy-release.sh，不触碰 Docker、数据库或 systemd。

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "${test_dir}"' EXIT

readonly GIT_SHA="0123456789abcdef0123456789abcdef01234567"
readonly APP_IMAGE="ghcr.io/fluxcode666/fluxmedia-1-app"
readonly APP_DIGEST="sha256:$(printf 'a%.0s' $(seq 1 64))"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

expect_failure() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    fail "${description}"
  fi
}

sha256_of() {
  sha256sum "$1" | awk '{ print $1 }'
}

json_field() {
  python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)' "$1" "$2"
}

# ---------- manifest 解析 ----------
manifest="${test_dir}/manifest.env"
write_manifest() {
  printf 'RELEASE_TAG=%s\nGIT_SHA=%s\nAPP_IMAGE=%s\nAPP_DIGEST=%s\nBUNDLE_SHA256=%s\n' \
    "$1" "${GIT_SHA}" "${APP_IMAGE}" "${APP_DIGEST}" "$2" >"${manifest}"
}
write_manifest v1.2.3 "$(printf 'b%.0s' $(seq 1 64))"
bash "${script_dir}/read-release-manifest.sh" "${manifest}" v1.2.3 \
  | grep -qx 'APP_DIGEST='"${APP_DIGEST}" || fail "合法 manifest 应解析成功"
expect_failure "版本不一致应拒绝" \
  bash "${script_dir}/read-release-manifest.sh" "${manifest}" v1.2.4
printf 'EXTRA=1\n' >>"${manifest}"
expect_failure "未知键应拒绝" bash "${script_dir}/read-release-manifest.sh" "${manifest}"
write_manifest v1.2.3 "$(printf 'b%.0s' $(seq 1 64))"
sed -i 's|^APP_IMAGE=.*|APP_IMAGE=docker.io/evil/app|' "${manifest}"
expect_failure "非 GHCR 官方镜像应拒绝" \
  bash "${script_dir}/read-release-manifest.sh" "${manifest}"
write_manifest '$(touch /tmp/pwned)' "$(printf 'b%.0s' $(seq 1 64))"
expect_failure "命令替换版本号应拒绝" \
  bash "${script_dir}/read-release-manifest.sh" "${manifest}"

# ---------- 构建与下载 ----------
releases="${test_dir}/releases"
bash "${script_dir}/build-release-bundle.sh" \
  --output "${releases}/v1.2.3" --version v1.2.3 --git-sha "${GIT_SHA}" \
  --app-image "${APP_IMAGE}" --app-digest "${APP_DIGEST}" >/dev/null
export FLUXMEDIA_RELEASE_BASE_URL="file://${releases}"

fetched="${test_dir}/fetched"
bash "${script_dir}/fetch-release-bundle.sh" v1.2.3 "${fetched}" \
  | grep -qx "RELEASE_TAG=v1.2.3" || fail "下载应输出 manifest"
for required in docker-compose.next.yml fluxmedia.conf deploy-release.sh \
  apply-release.sh system-update-runner.sh install-system-updater.sh \
  fluxmedia-system-update.service fluxmedia-system-update.path release-manifest.env; do
  [ -f "${fetched}/bundle/${required}" ] || fail "部署包缺少 ${required}"
done
# apply-release.sh 的落地清单必须与构建清单完全一致。
staged_list="$(
  sed -n '/^readonly STAGED_FILES=(/,/^)/p' "${script_dir}/apply-release.sh" \
    | sed '1d;$d' | tr -d ' ' | sort
)"
bundle_list="$(tar -tzf "${releases}/v1.2.3/fluxmedia-deploy.tar.gz" | sort)"
[ "${staged_list}" = "${bundle_list}" ] || fail "apply-release 清单与部署包不一致"

expect_failure "非空目标目录应拒绝" \
  bash "${script_dir}/fetch-release-bundle.sh" v1.2.3 "${fetched}"
expect_failure "不存在的 Release 应失败" \
  bash "${script_dir}/fetch-release-bundle.sh" v9.9.9 "${test_dir}/missing"

cp -r "${releases}/v1.2.3" "${releases}/v1.2.4"
sed -i 's/^RELEASE_TAG=.*/RELEASE_TAG=v1.2.4/' "${releases}/v1.2.4/fluxmedia-release.env"
printf 'tamper' >>"${releases}/v1.2.4/fluxmedia-deploy.tar.gz"
expect_failure "SHA-256 不一致应拒绝" \
  bash "${script_dir}/fetch-release-bundle.sh" v1.2.4 "${test_dir}/tampered"

mkdir -p "${test_dir}/evil/inner" "${releases}/v1.2.5"
printf 'x' >"${test_dir}/evil/inner/file"
tar -czf "${releases}/v1.2.5/fluxmedia-deploy.tar.gz" -C "${test_dir}/evil" inner/file
write_manifest v1.2.5 "$(sha256_of "${releases}/v1.2.5/fluxmedia-deploy.tar.gz")"
cp "${manifest}" "${releases}/v1.2.5/fluxmedia-release.env"
expect_failure "含子路径的部署包应拒绝" \
  bash "${script_dir}/fetch-release-bundle.sh" v1.2.5 "${test_dir}/evil-fetch"

# ---------- 更新器安装 ----------
export FLUXMEDIA_SYSTEM_UPDATE_STATE_DIR="${test_dir}/state/system-update"
export FLUXMEDIA_SYSTEMD_UNIT_DIR="${test_dir}/units"
systemctl_log="${test_dir}/systemctl.log"
cat >"${test_dir}/systemctl" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"${systemctl_log}"
STUB
chmod +x "${test_dir}/systemctl"
export FLUXMEDIA_SYSTEMCTL="${test_dir}/systemctl"

deploy_path="${test_dir}/deploy"
mkdir -p "${deploy_path}"
bash "${fetched}/bundle/install-system-updater.sh" \
  --deploy-path "${deploy_path}" --app-uid 1001 --app-gid 1001 >/dev/null
state_dir="${FLUXMEDIA_SYSTEM_UPDATE_STATE_DIR}"
[ "$(json_field "${state_dir}/status/status.json" state)" = "idle" ] \
  || fail "安装后应写入 idle 状态"
[ "$(stat -c %a "${state_dir}/requests")" = "700" ] || fail "requests 目录权限应为 700"
grep -qx "PathExists=${state_dir}/requests/update-request.json" \
  "${FLUXMEDIA_SYSTEMD_UNIT_DIR}/fluxmedia-system-update.path" || fail "path 单元未渲染状态目录"
grep -q "${deploy_path}/system-update-runner.sh --deploy-path ${deploy_path}" \
  "${FLUXMEDIA_SYSTEMD_UNIT_DIR}/fluxmedia-system-update.service" || fail "service 单元未渲染部署目录"
grep -qx 'daemon-reload' "${systemctl_log}" || fail "单元变更后应 daemon-reload"
grep -qx 'restart fluxmedia-system-update.path' "${systemctl_log}" || fail "单元变更后应重启 path"
: >"${systemctl_log}"
bash "${fetched}/bundle/install-system-updater.sh" \
  --deploy-path "${deploy_path}" --app-uid 1001 --app-gid 1001 >/dev/null
if grep -q 'daemon-reload\|restart' "${systemctl_log}"; then
  fail "单元未变更时不应 reload/restart"
fi
expect_failure "root uid 应拒绝" bash "${fetched}/bundle/install-system-updater.sh" \
  --deploy-path "${deploy_path}" --app-uid 0 --app-gid 0

# ---------- runner 全链路（桩 deploy-release.sh） ----------
# 构造与真实部署包同构、但 deploy-release.sh 只输出证据的 v1.3.0。
stub_bundle="${test_dir}/stub-bundle"
mkdir -p "${stub_bundle}" "${releases}/v1.3.0"
tar -xzf "${releases}/v1.2.3/fluxmedia-deploy.tar.gz" -C "${stub_bundle}"
cat >"${stub_bundle}/deploy-release.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >"$4/deploy-args"
printf 'deployed_image_ref=%s@%s\n' "$1" "$2"
printf 'deployment_completed=true\n'
STUB
(cd "${stub_bundle}" && tar -czf "${releases}/v1.3.0/fluxmedia-deploy.tar.gz" *)
write_manifest v1.3.0 "$(sha256_of "${releases}/v1.3.0/fluxmedia-deploy.tar.gz")"
cp "${manifest}" "${releases}/v1.3.0/fluxmedia-release.env"

# 目标服务器上的现役脚本来自上一版部署包。
cp "${fetched}/bundle/"*.sh "${deploy_path}/"
printf 'FLUXMEDIA_RELEASE_TAG=v1.2.3\n' >"${deploy_path}/.env"

request_update() {
  printf '%s' "$1" >"${state_dir}/requests/.tmp-request"
  mv "${state_dir}/requests/.tmp-request" "${state_dir}/requests/update-request.json"
}
run_runner() {
  bash "${deploy_path}/system-update-runner.sh" --deploy-path "${deploy_path}"
}

request_update '{"version":"v1.3.0","requestId":"req-00000001","requestedBy":"root-1"}'
run_runner >/dev/null 2>&1 || fail "合法请求应部署成功"
status_file="${state_dir}/status/status.json"
[ "$(json_field "${status_file}" state)" = "succeeded" ] || fail "状态应为 succeeded"
[ "$(json_field "${status_file}" targetVersion)" = "v1.3.0" ] || fail "状态应记录目标版本"
[ "$(json_field "${status_file}" previousVersion)" = "v1.2.3" ] || fail "状态应记录原版本"
[ ! -e "${state_dir}/requests/update-request.json" ] || fail "请求应被取走"
grep -qx "${APP_IMAGE} ${APP_DIGEST} v1.3.0 ${deploy_path} ${GIT_SHA}" \
  "${deploy_path}/deploy-args" || fail "deploy-release.sh 参数不正确"
[ -f "${deploy_path}/docker-compose.next.yml" ] || fail "候选 Compose 未落地"
[ -z "$(ls -A "${state_dir}/work")" ] || fail "工作目录应清理"

printf 'FLUXMEDIA_RELEASE_TAG=v1.3.0\n' >"${deploy_path}/.env"
request_update '{"version":"v1.3.0","requestId":"req-00000002"}'
expect_failure "同版本请求应拒绝" run_runner
[ "$(json_field "${status_file}" error)" = "version_not_newer" ] \
  || fail "降级/同版本应记录 version_not_newer"
printf 'FLUXMEDIA_RELEASE_TAG=v1.2.3\n' >"${deploy_path}/.env"

request_update '{"version":"v1.3.0-rc.1","requestId":"req-00000003"}'
expect_failure "预发布版本应拒绝" run_runner
[ "$(json_field "${status_file}" error)" = "invalid_request" ] || fail "预发布应记录 invalid_request"

request_update '{"version":"v1.3.0","requestId":"x;rm -rf /"}'
expect_failure "非法 requestId 应拒绝" run_runner

ln -s /etc/passwd "${state_dir}/requests/update-request.json"
expect_failure "符号链接请求应拒绝" run_runner
[ "$(json_field "${status_file}" error)" = "invalid_request" ] || fail "符号链接应记录 invalid_request"
[ ! -e "${state_dir}/requests/update-request.json" ] || fail "符号链接请求应被移除"

request_update '{"version":"v1.4.0","requestId":"req-00000004"}'
expect_failure "缺失 Release 应失败" run_runner
[ "$(json_field "${status_file}" error)" = "download_failed" ] || fail "应记录 download_failed"

run_runner >/dev/null 2>&1 || fail "无请求时应空操作成功"

printf '发布部署包与站内系统更新器测试通过。\n'
