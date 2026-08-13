/**
 * 运营总览管理员明细服务的 DB-free 测试。
 *
 * 使用方：Vitest。锁定五类增长明细、epoch 截断、Cohort 目标日、签名 cursor
 * 的主体/筛选绑定，以及商业化和内容尚未接入时的稳定失败。
 */
import { describe, expect, it, vi } from "vitest";

import type {
  OperationsGrowthDetailQuery,
  OperationsGrowthDetailRepository,
  OperationsGrowthDetailRow,
} from "./detail-repository";
import { loadOperationsDetail } from "./detail-service";

const AS_OF = new Date("2026-08-14T06:00:00.000Z");
const EPOCH_START = new Date("2026-07-31T16:00:00.000Z");
const TOKEN_SECRET = "operations-detail-test-secret";

/** 生成服务测试使用的安全增长明细行。 */
function makeRow(
  userId: string,
  businessTime: string,
  retained: boolean | null = null
): OperationsGrowthDetailRow {
  return {
    userId,
    name: `名称-${userId}`,
    email: `${userId}@example.com`,
    role: "user",
    banned: false,
    businessTime: new Date(businessTime),
    retained,
  };
}

/** 创建在内存中捕获查询的单快照仓储。 */
function createRepository(rows: OperationsGrowthDetailRow[]) {
  const readRows = vi.fn(async (_query: OperationsGrowthDetailQuery) => rows);
  const repository: OperationsGrowthDetailRepository = {
    async withReadOnlySnapshot(work) {
      return work({
        readHeader: vi.fn().mockResolvedValue({
          asOf: AS_OF,
          epoch: { appDate: "2026-08-01", startsAt: EPOCH_START },
        }),
        readRows,
      });
    },
  };
  return { readRows, repository };
}

/** 构造固定范围的一页增长明细请求。 */
function createInput(
  detail: "users" | "login_activity" | "creation_activity" | "payment_activity"
) {
  return {
    granularity: "day" as const,
    range: {
      kind: "custom" as const,
      from: "2026-08-01",
      to: "2026-08-07",
    },
    selection: { module: "growth" as const, detail },
    limit: 2,
  };
}

describe("operations detail service", () => {
  it.each([
    ["users", "users", undefined],
    ["login_activity", "activity", "login"],
    ["creation_activity", "activity", "creation"],
    ["payment_activity", "activity", "payment"],
  ] as const)("把 %s 选择映射为同源仓储查询", async (detail, kind, activityKind) => {
    const { readRows, repository } = createRepository([]);

    const result = await loadOperationsDetail(
      {
        actorUserId: "admin-1",
        timeZone: "Asia/Shanghai",
        input: createInput(detail),
      },
      { repository, tokenSecret: TOKEN_SECRET }
    );

    expect(readRows).toHaveBeenCalledOnce();
    expect(readRows.mock.calls[0]?.[0]).toMatchObject({
      kind,
      ...(activityKind ? { activityKind } : {}),
      start: EPOCH_START,
      end: new Date("2026-08-07T16:00:00.000Z"),
      epochStart: EPOCH_START,
      asOf: AS_OF,
      cursor: null,
      limit: 3,
    });
    expect(result).toMatchObject({
      selection: { module: "growth", detail },
      rows: [],
      nextCursor: null,
    });
  });

  it("返回完整管理员核对字段并用最后一行签发下一页 cursor", async () => {
    const { repository } = createRepository([
      makeRow("user-3", "2026-08-03T00:00:00.000Z"),
      makeRow("user-2", "2026-08-02T00:00:00.000Z"),
      makeRow("user-1", "2026-08-01T00:00:00.000Z"),
    ]);

    const result = await loadOperationsDetail(
      {
        actorUserId: "admin-1",
        timeZone: "Asia/Shanghai",
        input: createInput("users"),
      },
      { repository, tokenSecret: TOKEN_SECRET }
    );
    expect(result.range).toMatchObject({
      from: "2026-08-01",
      to: "2026-08-07",
      timeZone: "Asia/Shanghai",
      asOf: AS_OF,
      epochDate: "2026-08-01",
    });

    expect(result.rows).toEqual([
      {
        userId: "user-3",
        name: "名称-user-3",
        email: "user-3@example.com",
        role: "user",
        banned: false,
        businessTime: "2026-08-03T00:00:00.000Z",
        retained: null,
      },
      {
        userId: "user-2",
        name: "名称-user-2",
        email: "user-2@example.com",
        role: "user",
        banned: false,
        businessTime: "2026-08-02T00:00:00.000Z",
        retained: null,
      },
    ]);
    expect(result.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("下一页固定上一页 asOf，并拒绝跨管理员或跨筛选复用 cursor", async () => {
    const firstRepository = createRepository([
      makeRow("user-3", "2026-08-03T00:00:00.000Z"),
      makeRow("user-2", "2026-08-02T00:00:00.000Z"),
      makeRow("user-1", "2026-08-01T00:00:00.000Z"),
    ]).repository;
    const first = await loadOperationsDetail(
      {
        actorUserId: "admin-1",
        timeZone: "Asia/Shanghai",
        input: createInput("users"),
      },
      { repository: firstRepository, tokenSecret: TOKEN_SECRET }
    );
    expect(first.nextCursor).not.toBeNull();

    const second = createRepository([]);
    await loadOperationsDetail(
      {
        actorUserId: "admin-1",
        timeZone: "Asia/Shanghai",
        input: { ...createInput("users"), cursor: first.nextCursor },
      },
      { repository: second.repository, tokenSecret: TOKEN_SECRET }
    );
    expect(second.readRows.mock.calls[0]?.[0]).toMatchObject({
      asOf: AS_OF,
      cursor: {
        businessTime: new Date("2026-08-02T00:00:00.000Z"),
        stableId: "user-2",
      },
    });

    await expect(
      loadOperationsDetail(
        {
          actorUserId: "admin-2",
          timeZone: "Asia/Shanghai",
          input: { ...createInput("users"), cursor: first.nextCursor },
        },
        { repository: second.repository, tokenSecret: TOKEN_SECRET }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      loadOperationsDetail(
        {
          actorUserId: "admin-1",
          timeZone: "Asia/Shanghai",
          input: {
            ...createInput("login_activity"),
            cursor: first.nextCursor,
          },
        },
        { repository: second.repository, tokenSecret: TOKEN_SECRET }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
    const tamperedCursor = `${first.nextCursor?.slice(0, -1)}A`;
    await expect(
      loadOperationsDetail(
        {
          actorUserId: "admin-1",
          timeZone: "Asia/Shanghai",
          input: { ...createInput("users"), cursor: tamperedCursor },
        },
        { repository: second.repository, tokenSecret: TOKEN_SECRET }
      )
    ).rejects.toMatchObject({ code: "validation_error" });

    const laterSnapshot = new Date("2026-08-14T12:00:00.000Z");
    const laterReadRows = vi.fn(
      async (_query: OperationsGrowthDetailQuery) => []
    );
    const laterRepository: OperationsGrowthDetailRepository = {
      async withReadOnlySnapshot(work) {
        return work({
          readHeader: vi.fn().mockResolvedValue({
            asOf: laterSnapshot,
            epoch: { appDate: "2026-08-01", startsAt: EPOCH_START },
          }),
          readRows: laterReadRows,
        });
      },
    };
    await loadOperationsDetail(
      {
        actorUserId: "admin-1",
        timeZone: "Asia/Shanghai",
        input: { ...createInput("users"), cursor: first.nextCursor },
      },
      { repository: laterRepository, tokenSecret: TOKEN_SECRET }
    );
    expect(laterReadRows.mock.calls[0]?.[0]).toMatchObject({ asOf: AS_OF });
  });

  it("Cohort 明细只读所选注册日和精确成熟目标日", async () => {
    const { readRows, repository } = createRepository([
      makeRow("user-1", "2026-08-02T02:00:00.000Z", true),
    ]);

    const result = await loadOperationsDetail(
      {
        actorUserId: "admin-1",
        timeZone: "Asia/Shanghai",
        input: {
          granularity: "day",
          range: {
            kind: "custom",
            from: "2026-08-01",
            to: "2026-08-07",
          },
          selection: {
            module: "growth",
            detail: "retention_cohorts",
            cohortDate: "2026-08-02",
            retentionDay: 7,
          },
          limit: 100,
        },
      },
      { repository, tokenSecret: TOKEN_SECRET }
    );

    expect(readRows.mock.calls[0]?.[0]).toMatchObject({
      kind: "cohort",
      start: new Date("2026-08-01T16:00:00.000Z"),
      end: new Date("2026-08-02T16:00:00.000Z"),
      targetStart: new Date("2026-08-08T16:00:00.000Z"),
      targetEnd: new Date("2026-08-09T16:00:00.000Z"),
    });
    expect(result.rows[0]).toMatchObject({ retained: true });
  });

  it("拒绝未成熟 Cohort，并为商业化和内容返回稳定未实现", async () => {
    const { repository } = createRepository([]);
    await expect(
      loadOperationsDetail(
        {
          actorUserId: "admin-1",
          timeZone: "Asia/Shanghai",
          input: {
            range: {
              kind: "custom",
              from: "2026-08-01",
              to: "2026-08-07",
            },
            selection: {
              module: "growth",
              detail: "retention_cohorts",
              cohortDate: "2026-08-07",
              retentionDay: 30,
            },
          },
        },
        { repository, tokenSecret: TOKEN_SECRET }
      )
    ).rejects.toMatchObject({ code: "validation_error" });

    for (const selection of [
      { module: "commercialization", detail: "orders" },
      { module: "content", detail: "image_outputs" },
    ]) {
      await expect(
        loadOperationsDetail(
          {
            actorUserId: "admin-1",
            timeZone: "Asia/Shanghai",
            input: { selection },
          },
          { repository, tokenSecret: TOKEN_SECRET }
        )
      ).rejects.toMatchObject({
        name: "OperationsDetailServiceError",
        code: "not_implemented",
      });
    }
  });

  it("未初始化 epoch 和非法输入返回稳定错误且不读取明细", async () => {
    const readRows = vi.fn();
    const repository: OperationsGrowthDetailRepository = {
      async withReadOnlySnapshot(work) {
        return work({
          readHeader: vi.fn().mockResolvedValue({
            asOf: AS_OF,
            epoch: null,
          }),
          readRows,
        });
      },
    };
    await expect(
      loadOperationsDetail(
        {
          actorUserId: "admin-1",
          timeZone: "Asia/Shanghai",
          input: { selection: { module: "growth", detail: "unknown" } },
        },
        { repository, tokenSecret: TOKEN_SECRET }
      )
    ).rejects.toMatchObject({ code: "validation_error" });

    await expect(
      loadOperationsDetail(
        {
          actorUserId: "admin-1",
          timeZone: "Asia/Shanghai",
          input: createInput("users"),
        },
        { repository, tokenSecret: TOKEN_SECRET }
      )
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(readRows).not.toHaveBeenCalled();
  });

  it("没有服务端 HMAC 密钥时即使首屏无下一页也拒绝读取", async () => {
    const { repository } = createRepository([]);
    await expect(
      loadOperationsDetail(
        {
          actorUserId: "admin-1",
          timeZone: "Asia/Shanghai",
          input: createInput("users"),
        },
        { repository, tokenSecret: "" }
      )
    ).rejects.toMatchObject({ code: "not_ready" });
  });

  it("拒绝空管理员身份，避免签发无主体 cursor", async () => {
    const { repository } = createRepository([]);
    await expect(
      loadOperationsDetail(
        {
          actorUserId: "  ",
          timeZone: "Asia/Shanghai",
          input: createInput("users"),
        },
        { repository, tokenSecret: TOKEN_SECRET }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("拒绝仓储返回查询范围外或未来的损坏行", async () => {
    const { repository } = createRepository([
      makeRow("user-1", "2026-08-10T00:00:00.000Z"),
    ]);
    await expect(
      loadOperationsDetail(
        {
          actorUserId: "admin-1",
          timeZone: "Asia/Shanghai",
          input: createInput("users"),
        },
        { repository, tokenSecret: TOKEN_SECRET }
      )
    ).rejects.toMatchObject({ code: "invalid_data" });
  });
});
