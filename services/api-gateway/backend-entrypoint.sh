#!/bin/sh
set -eu

cd "${FLUXMEDIA_BACKEND_ROOT:-/app}"

if [ "$#" -gt 0 ]; then
	exec "$@"
fi

exec "${GO_BACKEND_EXECUTABLE:-/backend}"
