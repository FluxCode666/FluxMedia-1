#!/usr/bin/env bash
# 发布部署包的回归测试（需 Linux：flock、GNU coreutils）。
# 覆盖：manifest 严格解析、部署包构建/下载/校验、路径穿越拒绝，以及 apply-release.sh
# 落地部署包、调用 deploy-release.sh 与部署锁互斥。
# 使用 file:// 下载源与桩 deploy-release.sh，不触碰 Docker 或数据库。

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
  apply-release.sh read-release-manifest.sh release-manifest.env; do
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

# ---------- apply-release 落地与发布（桩 deploy-release.sh） ----------
stub_bundle="${test_dir}/stub-bundle"
cp -r "${fetched}/bundle" "${stub_bundle}"
cat >"${stub_bundle}/deploy-release.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >"$4/deploy-args"
printf 'deployment_completed=true\n'
STUB

deploy_path="${test_dir}/deploy"
mkdir -p "${deploy_path}"
bash "${stub_bundle}/apply-release.sh" \
  --deploy-path "${deploy_path}" --bundle-dir "${stub_bundle}" >/dev/null \
  || fail "合法部署包应落地并发布"
grep -qx "${APP_IMAGE} ${APP_DIGEST} v1.2.3 ${deploy_path} ${GIT_SHA}" \
  "${deploy_path}/deploy-args" || fail "deploy-release.sh 参数不正确"
[ -f "${deploy_path}/docker-compose.next.yml" ] || fail "候选 Compose 未落地"
[ "$(stat -c %a "${deploy_path}/deploy-release.sh")" = "750" ] \
  || fail "部署脚本权限应为 750"
if ls -A "${deploy_path}" | grep -q '\.staging\.'; then
  fail "不应残留 staging 文件"
fi

# 部署锁被占用时必须在任何文件变更前拒绝。
rm -f "${deploy_path}/deploy-args"
exec 8>"${deploy_path}/release-state/deploy.lock"
flock -n 8 || fail "测试无法持有部署锁"
expect_failure "部署锁被占用时应拒绝" bash "${stub_bundle}/apply-release.sh" \
  --deploy-path "${deploy_path}" --bundle-dir "${stub_bundle}"
exec 8>&-
[ ! -e "${deploy_path}/deploy-args" ] || fail "锁冲突时不应调用 deploy-release.sh"

rm "${stub_bundle}/fluxmedia.conf"
expect_failure "部署包缺文件应拒绝" bash "${stub_bundle}/apply-release.sh" \
  --deploy-path "${deploy_path}" --bundle-dir "${stub_bundle}"

printf '发布部署包测试通过。\n'
