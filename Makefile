SHELL := /bin/bash

.DEFAULT_GOAL := help

GO_SERVICE := services/api-gateway
GO_BIND ?= :8080
# Explicit environment > root .env.local > root .env. Never invent a database
# or auth secret here: exported defaults override dotenv and hide existing data.
DEV_ENV := node scripts/with-root-env.mjs --exec

.PHONY: help dev-infra-up dev-migrate dev-frontend dev-backend dev test-go test-go-integration test

help:
	@printf '%s\n' \
		'make dev-infra-up       启动本地 PostgreSQL/Redis 容器' \
		'make dev-migrate        执行数据库迁移' \
		'make dev-frontend       启动 Next.js 页面开发服务（3000）' \
		'make dev-backend        启动 Go backend（8080）' \
		'make dev                同时启动前端和 Go backend' \
		'make test               运行 Go 单元测试和全仓 TypeScript 测试'

dev-infra-up:
	docker start fluxcode-local-postgres fluxmedia-local-redis
	docker exec fluxcode-local-postgres pg_isready
	$(DEV_ENV) sh -c 'REDISCLI_AUTH="$$REDIS_PASSWORD" exec docker exec --env REDISCLI_AUTH fluxmedia-local-redis redis-cli --no-auth-warning ping'

dev-migrate: dev-infra-up
	$(DEV_ENV) go -C $(GO_SERVICE) run . --migrate

dev-frontend: dev-infra-up
	$(DEV_ENV) pnpm dev:web

dev-backend: dev-infra-up
	GO_BACKEND_BIND='$(GO_BIND)' $(DEV_ENV) go -C $(GO_SERVICE) run .

dev: dev-migrate
	@trap 'kill 0' INT TERM EXIT; \
		$(MAKE) dev-frontend & \
		$(MAKE) dev-backend & \
		wait

test-go:
	cd $(GO_SERVICE) && gofmt -w *.go && go vet ./... && go test -race ./... && go mod verify

test-go-integration: dev-infra-up
	$(DEV_ENV) node scripts/test-go-integration.mjs

test: test-go
	node --test scripts/with-root-env.test.mjs
	pnpm turbo test
