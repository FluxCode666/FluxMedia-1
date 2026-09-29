#!/usr/bin/env bash
# 从已发布的统一镜像导出站内更新使用的应用包。
#
# 使用方：.github/workflows/release.yml 的 publish-release job。
# 参数：--image IMAGE_REF --version TAG --platform-fingerprint FP --output FILE
# 产物：gzip tar 包，根目录即镜像内的 /app（去掉 storage、releases 与媒体模型）加上
# /backend。站内更新把它解压到 /app/releases/<TAG>，由 boot.mjs 迁移后切换。
# 媒体模型与系统依赖留在镜像里，由平台指纹约束（见 compute-platform-fingerprint.sh）。

set -euo pipefail

fail() {
  printf '构建应用包失败：%s\n' "$1" >&2
  exit 1
}

image=""
version=""
platform_fingerprint=""
output=""
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || fail "$1 缺少参数值"
  case "$1" in
    --image) image="$2" ;;
    --version) version="$2" ;;
    --platform-fingerprint) platform_fingerprint="$2" ;;
    --output) output="$2" ;;
    *) fail "未知参数：$1" ;;
  esac
  shift 2
done
[ -n "${image}" ] && [ -n "${version}" ] && [ -n "${platform_fingerprint}" ] \
  && [ -n "${output}" ] || fail "--image、--version、--platform-fingerprint、--output 均必填"
command -v docker >/dev/null 2>&1 || fail "缺少 docker"

work_dir="$(mktemp -d)"
container=""
cleanup() {
  if [ -n "${container}" ]; then
    docker rm --force "${container}" >/dev/null 2>&1 || true
  fi
  rm -rf "${work_dir}"
}
trap cleanup EXIT

root="${work_dir}/root"
mkdir -p "${root}"
container="$(docker create --platform linux/amd64 "${image}")"
docker cp "${container}:/app/." "${root}/"
docker cp "${container}:/backend" "${root}/backend"
rm -rf "${root}/storage" "${root}/releases" "${root}/apps/web/models"

[ -x "${root}/backend" ] || fail "镜像缺少可执行的 /backend"
[ -f "${root}/services/unified-runtime/supervisor.mjs" ] || fail "镜像缺少 supervisor.mjs"
grep -q "\"version\":\"${version}\"" "${root}/release.json" 2>/dev/null \
  || fail "镜像 release.json 的版本不是 ${version}"
grep -q "\"platformFingerprint\":\"${platform_fingerprint}\"" "${root}/release.json" \
  || fail "镜像 release.json 的平台指纹与本次计算结果不一致"
# 应用包会被解压到另一个目录运行，绝对路径链接会指回镜像自带的文件。
absolute_link="$(find "${root}" -lname '/*' -print -quit)"
[ -z "${absolute_link}" ] || fail "包含绝对路径符号链接：${absolute_link#"${root}"}"
special_file="$(find "${root}" ! -type f ! -type d ! -type l -print -quit)"
[ -z "${special_file}" ] || fail "包含非常规文件：${special_file#"${root}"}"

mkdir -p "$(dirname "${output}")"
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  tar --sort=name --owner=0 --group=0 --numeric-owner -czf "${output}" -C "${root}" .
else
  COPYFILE_DISABLE=1 tar --uid 0 --gid 0 --numeric-owner -czf "${output}" -C "${root}" .
fi
printf '应用包：%s（%s 字节）\n' "${output}" "$(wc -c <"${output}" | tr -d ' ')"
