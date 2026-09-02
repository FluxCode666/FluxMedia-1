import {
  apiUpstreamAdapterDraftSchema,
  createDefaultApiUpstreamOperations,
} from "@repo/shared/image-backend/api-upstream-adaptation";
import type { ImageSizeConfigSnapshot } from "@repo/shared/image-backend/image-size-config";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  type BoundImageSizeConfigAdapter,
  canonicalizeImageSizeConfigSnapshot,
  IMAGE_SIZE_CONFIG_BINDING_LOCK_QUERY,
  type RefreshBoundImageSizeConfigAdaptersDependencies,
  type RefreshedImageSizeConfigAdapterVersion,
  refreshBoundImageSizeConfigAdapters,
} from "./image-size-config-binding";
import { buildBoundImageSizeConfigAdaptersQuery } from "./image-size-config-service";

const NOW = new Date("2026-09-01T08:00:00.000Z");

function sizeConfig(
  size = "1024x1024",
  mappings: ImageSizeConfigSnapshot["mappings"] = [
    { resolution: "1K", aspectRatio: "1:1", size },
  ]
): ImageSizeConfigSnapshot {
  return { id: "size-config-a", name: "标准尺寸", mappings };
}

function adapter(
  memberId: string,
  revision: number,
  imageSizeConfig: ImageSizeConfigSnapshot | null
): BoundImageSizeConfigAdapter {
  return {
    memberId,
    currentAdapterVersionId: `${memberId}-v${revision}`,
    revision,
    credentialScope: "https://images.example.com|bearer",
    configuration: apiUpstreamAdapterDraftSchema.parse({
      baseUrl: "https://images.example.com/v1",
      useStream: false,
      imageSizeConfig,
      modelMappings: [],
      authentication: { mode: "bearer" },
      credentialScope: "https://images.example.com|bearer",
      operations: createDefaultApiUpstreamOperations(),
    }),
  };
}

function createRefreshHarness(
  adapters: BoundImageSizeConfigAdapter[],
  switchResult = true
) {
  const inserted: RefreshedImageSizeConfigAdapterVersion[] = [];
  const switched: Array<{
    memberId: string;
    expectedCurrentVersionId: string;
    nextVersionId: string;
    updatedAt: Date;
  }> = [];
  let idSequence = 0;
  const dependencies: RefreshBoundImageSizeConfigAdaptersDependencies = {
    configId: "size-config-a",
    snapshot: sizeConfig("1536x1024"),
    now: NOW,
    createId: () => `next-version-${++idSequence}`,
    loadBoundAdapters: vi.fn(async () => adapters),
    insertVersion: vi.fn(async (version) => {
      inserted.push(version);
    }),
    switchCurrentVersion: vi.fn(async (input) => {
      switched.push(input);
      return switchResult;
    }),
  };
  return {
    inserted,
    switched,
    dependencies,
  };
}

describe("image size config bindings", () => {
  it("配置更新时为所有绑定供应商创建新版本并切换当前指针", async () => {
    const first = adapter("member-a", 2, sizeConfig());
    const second = adapter("member-b", 7, sizeConfig());
    const harness = createRefreshHarness([first, second]);

    await expect(
      refreshBoundImageSizeConfigAdapters(harness.dependencies)
    ).resolves.toEqual({ scanned: 2, refreshed: 2 });

    expect(harness.inserted).toHaveLength(2);
    expect(harness.inserted.map((version) => version.revision)).toEqual([3, 8]);
    expect(
      harness.inserted.map(
        (version) => version.configuration.imageSizeConfig?.mappings[0]?.size
      )
    ).toEqual(["1536x1024", "1536x1024"]);
    expect(harness.switched).toEqual([
      {
        memberId: "member-a",
        expectedCurrentVersionId: "member-a-v2",
        nextVersionId: "next-version-1",
        updatedAt: NOW,
      },
      {
        memberId: "member-b",
        expectedCurrentVersionId: "member-b-v7",
        nextVersionId: "next-version-2",
        updatedAt: NOW,
      },
    ]);
  });

  it("不修改历史适配版本中的旧尺寸快照", async () => {
    const current = adapter("member-a", 2, sizeConfig());
    const historicalConfiguration = structuredClone(current.configuration);
    const harness = createRefreshHarness([current]);

    await refreshBoundImageSizeConfigAdapters(harness.dependencies);

    expect(current.configuration).toEqual(historicalConfiguration);
    expect(
      apiUpstreamAdapterDraftSchema.parse(current.configuration).imageSizeConfig
        ?.mappings[0]?.size
    ).toBe("1024x1024");
    expect(
      harness.inserted[0]?.configuration.imageSizeConfig?.mappings[0]?.size
    ).toBe("1536x1024");
  });

  it("删除配置时创建 imageSizeConfig 为 null 的当前版本", async () => {
    const harness = createRefreshHarness([
      adapter("member-a", 4, sizeConfig()),
    ]);
    harness.dependencies.snapshot = null;

    await expect(
      refreshBoundImageSizeConfigAdapters(harness.dependencies)
    ).resolves.toEqual({ scanned: 1, refreshed: 1 });
    expect(harness.inserted[0]).toMatchObject({
      memberIdSnapshot: "member-a",
      revision: 5,
      configuration: { imageSizeConfig: null },
    });
  });

  it("相同映射仅顺序不同时不产生无意义版本", async () => {
    const mappings = [
      { resolution: "2K", aspectRatio: "16:9", size: "2048x1152" },
      { resolution: "1K", aspectRatio: "1:1", size: "1024x1024" },
    ];
    const current = adapter("member-a", 3, sizeConfig("ignored", mappings));
    const harness = createRefreshHarness([current]);
    harness.dependencies.snapshot = sizeConfig(
      "ignored",
      [...mappings].reverse()
    );

    await expect(
      refreshBoundImageSizeConfigAdapters(harness.dependencies)
    ).resolves.toEqual({ scanned: 1, refreshed: 0 });
    expect(harness.inserted).toHaveLength(0);
    expect(harness.switched).toHaveLength(0);
  });

  it("当前版本 CAS 失败时抛错，使外层数据库事务整体回滚", async () => {
    const harness = createRefreshHarness(
      [adapter("member-a", 1, sizeConfig())],
      false
    );

    await expect(
      refreshBoundImageSizeConfigAdapters(harness.dependencies)
    ).rejects.toThrow("刷新供应商 member-a 时发生版本冲突");
  });

  it("配置维护和供应商保存共用事务锁，绑定查询锁定当前指针", () => {
    const dialect = new PgDialect();
    const lock = dialect.sqlToQuery(IMAGE_SIZE_CONFIG_BINDING_LOCK_QUERY);
    const bound = dialect.sqlToQuery(
      buildBoundImageSizeConfigAdaptersQuery("size-config-a")
    );

    expect(lock.sql).toContain("pg_advisory_xact_lock");
    expect(bound.sql).toContain("#>> '{imageSizeConfig,id}'");
    expect(bound.sql).toContain("for update of api");
    expect(bound.params).toEqual(["size-config-a"]);
  });

  it("快照映射使用稳定顺序", () => {
    expect(
      canonicalizeImageSizeConfigSnapshot(
        sizeConfig("ignored", [
          { resolution: "2K", aspectRatio: "16:9", size: "2048x1152" },
          { resolution: "1K", aspectRatio: "1:1", size: "1024x1024" },
        ])
      ).mappings.map((mapping) => mapping.resolution)
    ).toEqual(["1K", "2K"]);
  });
});
