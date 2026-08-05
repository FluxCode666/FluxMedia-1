/**
 * 媒体限制服务 DB-free 测试。
 *
 * 通过内存仓储验证用户覆盖读取、角色护栏、NULL 继承和事务内审计，不加载数据库。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUserRole } from "../auth/roles";
import { resolveMediaLimitPolicy } from "./media-limit-policy";
import {
  createMediaLimitService,
  type LockedUserConcurrency,
  type MediaLimitAuditLogInsert,
  type MediaLimitRepository,
  MediaLimitServiceError,
} from "./media-limit-service";

/** 创建支持锁内更新和审计断言的内存仓储。 */
function createRepository(initial: LockedUserConcurrency[]) {
  const users = new Map(initial.map((item) => [item.id, { ...item }]));
  const audits: MediaLimitAuditLogInsert[] = [];
  const repository: MediaLimitRepository = {
    async readUserConcurrency(userId) {
      return users.get(userId) ?? null;
    },
    async transaction(work) {
      return work({
        async lockUserConcurrency(userId) {
          return users.get(userId) ?? null;
        },
        async updateUserConcurrency(input) {
          const current = users.get(input.userId);
          if (!current) throw new Error("missing user");
          users.set(input.userId, {
            ...current,
            override: input.override,
            updatedAt: input.updatedAt,
          });
        },
        async insertAuditLog(input) {
          audits.push(input);
        },
      });
    },
  };
  return { repository, users, audits };
}

/** 创建一条确定时间的用户并发记录。 */
function user(
  id: string,
  role: AppUserRole,
  override: number | null = null
): LockedUserConcurrency {
  return { id, role, override, updatedAt: new Date("2026-08-05T00:00:00Z") };
}

describe("media limit service", () => {
  const now = new Date("2026-08-05T01:00:00Z");
  const readPolicy = vi.fn(async () =>
    resolveMediaLimitPolicy({
      defaultUserConcurrency: 20,
      maxFileSizeMb: 5,
      maxUploadSizeMb: 75,
      maxEditReferenceImages: 16,
    })
  );

  beforeEach(() => {
    readPolicy.mockClear();
  });

  it("用户覆盖优先于系统默认且不包含套餐字段", async () => {
    const state = createRepository([user("member", "user", 36)]);
    const service = createMediaLimitService({
      repository: state.repository,
      readPolicy,
      now: () => now,
      createAuditId: () => "audit-1",
      warn: vi.fn(),
    });

    const result = await service.getForUser("member");

    expect(result).toMatchObject({
      limit: 36,
      override: 36,
      effectiveSource: "user_override",
      maxFileSizeMb: 5,
      maxUploadSizeMb: 75,
      maxEditReferenceImages: 16,
    });
    expect(result).not.toHaveProperty("plan");
  });

  it("管理员设置低权限用户覆盖并完整记录审计", async () => {
    const state = createRepository([user("member", "user")]);
    const service = createMediaLimitService({
      repository: state.repository,
      readPolicy,
      now: () => now,
      createAuditId: () => "audit-1",
      warn: vi.fn(),
    });

    const result = await service.setUserConcurrencyOverride({
      actor: { userId: "admin-1", role: "admin" },
      userId: "member",
      override: 40,
      reason: "客户容量调整",
      requestId: "request-1",
    });

    expect(result).toEqual({
      changed: true,
      before: null,
      after: 40,
      effectiveConcurrency: 40,
      effectiveSource: "user_override",
      auditLogId: "audit-1",
      updatedAt: now,
    });
    expect(state.users.get("member")?.override).toBe(40);
    expect(state.audits).toEqual([
      expect.objectContaining({
        id: "audit-1",
        adminUserId: "admin-1",
        targetUserId: "member",
        reason: "客户容量调整",
        before: { imageGenerationConcurrencyOverride: null },
        after: { imageGenerationConcurrencyOverride: 40 },
        metadata: expect.objectContaining({
          requestId: "request-1",
          actorRole: "admin",
          targetRole: "user",
        }),
      }),
    ]);
  });

  it("清空覆盖恢复默认 20", async () => {
    const state = createRepository([user("member", "user", 40)]);
    const service = createMediaLimitService({
      repository: state.repository,
      readPolicy,
      now: () => now,
      createAuditId: () => "audit-2",
      warn: vi.fn(),
    });

    const result = await service.setUserConcurrencyOverride({
      actor: { userId: "root", role: "super_admin" },
      userId: "member",
      override: null,
      reason: "恢复系统默认",
      requestId: "request-2",
    });

    expect(result).toMatchObject({
      after: null,
      effectiveConcurrency: 20,
      effectiveSource: "system_default",
    });
    expect(state.users.get("member")?.override).toBeNull();
  });

  it.each([
    {
      actor: { userId: "observer", role: "observer_admin" as const },
      target: user("member", "user"),
    },
    {
      actor: { userId: "admin", role: "admin" as const },
      target: user("peer", "admin"),
    },
    {
      actor: { userId: "admin", role: "admin" as const },
      target: user("admin", "admin"),
    },
  ])("拒绝无权角色或平级目标 %#", async ({ actor, target }) => {
    const state = createRepository([target]);
    const service = createMediaLimitService({
      repository: state.repository,
      readPolicy,
      now: () => now,
      createAuditId: () => "audit-forbidden",
      warn: vi.fn(),
    });

    await expect(
      service.setUserConcurrencyOverride({
        actor,
        userId: target.id,
        override: 30,
        reason: "测试权限",
        requestId: "request-forbidden",
      })
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(state.audits).toHaveLength(0);
  });

  it.each([0, -1, 1.5, 10_001])("拒绝非法覆盖值 %s", async (override) => {
    const state = createRepository([user("member", "user")]);
    const service = createMediaLimitService({
      repository: state.repository,
      readPolicy,
      now: () => now,
      createAuditId: () => "audit-invalid",
      warn: vi.fn(),
    });

    await expect(
      service.setUserConcurrencyOverride({
        actor: { userId: "root", role: "super_admin" },
        userId: "member",
        override,
        reason: "非法输入测试",
        requestId: "request-invalid",
      })
    ).rejects.toBeInstanceOf(MediaLimitServiceError);
    expect(state.users.get("member")?.override).toBeNull();
  });
});
