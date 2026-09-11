#!/bin/sh
set -eu

cd /app

if [ "${GO_BACKEND_SKIP_MIGRATION:-false}" != "true" ]; then
	printf '%s\n' 'running database migrations'
	pnpm --dir packages/database db:migrate
fi

if [ "${GO_BACKEND_MIGRATE_ONLY:-false}" = "true" ]; then
	printf '%s\n' 'database migrations completed'
	exit 0
fi

exec /backend "$@"
