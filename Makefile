SHELL := /bin/bash

.DEFAULT_GOAL := help

GO_SERVICE := services/api-gateway
GO_BIND ?= :8080
LOCAL_DATABASE_URL ?= postgresql://fluxcode:fluxcode_local_dev@127.0.0.1:5432/fluxcode?sslmode=disable
LOCAL_REDIS_HOST ?= 127.0.0.1
LOCAL_REDIS_PORT ?= 6379
LOCAL_REDIS_PASSWORD ?= 123456
LOCAL_REDIS_DB ?= 4

export DATABASE_URL ?= $(LOCAL_DATABASE_URL)
export BETTER_AUTH_SECRET ?= local-development-secret-change-me
export BETTER_AUTH_URL ?= http://localhost:3000
export NEXT_PUBLIC_APP_URL ?= http://localhost:3000
export REDIS_HOST ?= $(LOCAL_REDIS_HOST)
export REDIS_PORT ?= $(LOCAL_REDIS_PORT)
export REDIS_PASSWORD ?= $(LOCAL_REDIS_PASSWORD)
export REDIS_DB ?= $(LOCAL_REDIS_DB)
export REDIS_TLS ?= false

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
	docker start fluxcode-local-postgres 2>/dev/null || true
	docker start fluxmedia-local-redis 2>/dev/null || true
	docker exec fluxcode-local-postgres pg_isready -U fluxcode -d fluxcode
	docker exec fluxmedia-local-redis redis-cli -a "$${REDIS_PASSWORD}" --no-auth-warning ping

dev-migrate: dev-infra-up
	pnpm --filter @repo/database db:migrate

dev-frontend: dev-infra-up
	pnpm dev:web

dev-backend: dev-infra-up
	cd $(GO_SERVICE) && GO_BACKEND_BIND='$(GO_BIND)' go run .

dev: dev-migrate
	@trap 'kill 0' INT TERM EXIT; \
		$(MAKE) dev-frontend & \
		$(MAKE) dev-backend & \
		wait

test-go:
	cd $(GO_SERVICE) && gofmt -w *.go && go vet ./... && go test -race ./... && go mod verify

test-go-integration: dev-infra-up
	cd $(GO_SERVICE) && REDIS_ADDR='$(LOCAL_REDIS_HOST):$(LOCAL_REDIS_PORT)' REDIS_PASSWORD='$(LOCAL_REDIS_PASSWORD)' go test -tags=integration ./...

test: test-go
	pnpm turbo test
