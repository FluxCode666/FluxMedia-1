#!/bin/sh

# Nginx URL 隐私静态门：确保访问日志不记录查询字符串/Referer，并要求所有站点响应
# 使用 same-origin Referrer-Policy。CI 和发布前可直接执行，不需要启动 Nginx。

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MAIN_CONFIG="$SCRIPT_DIR/nginx.conf"
SITE_CONFIG="$SCRIPT_DIR/conf.d/fluxmedia.conf"

if grep -Fq '"$request"' "$MAIN_CONFIG"; then
  echo 'nginx access log must not include $request' >&2
  exit 1
fi

if grep -Fq '$http_referer' "$MAIN_CONFIG"; then
  echo 'nginx access log must not include $http_referer' >&2
  exit 1
fi

if ! grep -Fq '"$request_method $uri $server_protocol"' "$MAIN_CONFIG"; then
  echo 'nginx access log must use the query-free $uri request line' >&2
  exit 1
fi

if grep -Fq 'strict-origin-when-cross-origin' "$SITE_CONFIG"; then
  echo 'nginx Referrer-Policy must not expose origins to external sites' >&2
  exit 1
fi

header_count=$(grep -Fc 'add_header Referrer-Policy "same-origin" always;' "$SITE_CONFIG")
if [ "$header_count" -lt 2 ]; then
  echo 'each HTTPS server must declare Referrer-Policy same-origin' >&2
  exit 1
fi

echo 'nginx URL privacy canary passed'
