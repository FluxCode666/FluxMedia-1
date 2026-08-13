/**
 * 运营总览内容生产快照服务测试。
 *
 * 使用内存 reader 覆盖多产物、视频数量与秒数、免费成功、部分退款净值、
 * 计费身份漂移、读模型 readiness 以及 epoch 前与跨 epoch 状态。
 */
import { describe, expect, it, vi } from "vitest";

import type {
  OperationsContentRepository,
  OperationsContentSnapshotReader,
} from "./content-repository";
import {
  loadOperationsContentSnapshot,
  type OperationsContentServiceError,
} from "./content-service";

type ReaderOverrides = Partial<OperationsContentSnapshotReader>;

/** 构造已初始化 epoch 且两个读模型均为 v1 ready 的内存 reader。 */
function createReader(
  overrides: ReaderOverrides = {}
): OperationsContentSnapshotReader {
  return {
    readHeader: vi.fn().mockResolvedValue({
      asOf: new Date("2026-08-10T12:00:00.000Z"),
      epoch: {
        appDate: "2026-08-01",
        startsAt: new Date("2026-07-31T16:00:00.000Z"),
      },
      outputUsage: { version: 1, status: "ready" },
      creditUsage: { version: 1, status: "ready" },
    }),
    readSeries: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/** 把 reader 固定到一次快照仓储调用。 */
function createRepository(
  reader: OperationsContentSnapshotReader
): OperationsContentRepository {
  return {
    withReadOnlySnapshot: (work) => work(reader),
  };
}

describe("operations content service", () => {
  it("epoch 或任一读模型未 ready 时在业务查询前明确失败", async () => {
    for (const header of [
      {
        asOf: new Date("2026-08-10T12:00:00.000Z"),
        epoch: null,
        outputUsage: { version: 1, status: "ready" },
        creditUsage: { version: 1, status: "ready" },
      },
      {
        asOf: new Date("2026-08-10T12:00:00.000Z"),
        epoch: {
          appDate: "2026-08-01",
          startsAt: new Date("2026-07-31T16:00:00.000Z"),
        },
        outputUsage: { version: 1, status: "ready" },
        creditUsage: { version: 1, status: "reconciling" },
      },
    ]) {
      const reader = createReader({
        readHeader: vi.fn().mockResolvedValue(header),
      });

      await expect(
        loadOperationsContentSnapshot(
          {},
          "Asia/Shanghai",
          createRepository(reader)
        )
      ).rejects.toMatchObject({
        code: "not_ready",
      } satisfies Partial<OperationsContentServiceError>);
      expect(reader.readSeries).not.toHaveBeenCalled();
    }
  });

  it("从完整当期和上期序列归并多图、视频与两位小数净积分", async () => {
    const readSeries = vi
      .fn()
      .mockResolvedValueOnce([
        {
          bucketKey: "day:2026-08-08",
          imageCount: 4,
          videoCount: 2,
          videoSeconds: 25,
          creditHundredths: 1_234,
          operationCreatedAtMismatchCount: 0,
        },
        {
          bucketKey: "day:2026-08-10",
          imageCount: 1,
          videoCount: 0,
          videoSeconds: 0,
          creditHundredths: 0,
          operationCreatedAtMismatchCount: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          bucketKey: "day:2026-08-05",
          imageCount: 2,
          videoCount: 1,
          videoSeconds: 10,
          creditHundredths: 500,
          operationCreatedAtMismatchCount: 0,
        },
      ]);
    const reader = createReader({ readSeries });

    const snapshot = await loadOperationsContentSnapshot(
      {
        range: { kind: "custom", from: "2026-08-08", to: "2026-08-10" },
        granularity: "day",
      },
      "Asia/Shanghai",
      createRepository(reader)
    );

    expect(snapshot.metrics.imageCount).toMatchObject({
      current: 5,
      previous: 2,
    });
    expect(snapshot.metrics.videoCount).toMatchObject({
      current: 2,
      previous: 1,
    });
    expect(snapshot.metrics.videoSeconds).toMatchObject({
      current: 25,
      previous: 10,
    });
    expect(snapshot.metrics.netCredits).toMatchObject({
      current: 12.34,
      previous: 5,
      comparison: {
        status: "value",
        changePercent: 146.8,
      },
    });
    expect(snapshot.series.imageCount).toHaveLength(3);
    expect(snapshot.series.imageCount[1]).toMatchObject({ value: 0 });
    expect(snapshot.series.netCredits[0]).toMatchObject({ value: 12.34 });
    expect(snapshot.series.netCredits[2]).toMatchObject({ value: 0 });
    expect(readSeries).toHaveBeenCalledTimes(2);
  });

  it("免费成功合法计零且部分退款只呈现 operation 的实际净值", async () => {
    const reader = createReader({
      readSeries: vi
        .fn()
        .mockResolvedValueOnce([
          {
            bucketKey: "day:2026-08-10",
            imageCount: 2,
            videoCount: 1,
            videoSeconds: 8,
            creditHundredths: 725,
            operationCreatedAtMismatchCount: 0,
          },
        ])
        .mockResolvedValueOnce([]),
    });

    const snapshot = await loadOperationsContentSnapshot(
      {
        range: { kind: "custom", from: "2026-08-10", to: "2026-08-10" },
      },
      "Asia/Shanghai",
      createRepository(reader)
    );

    expect(snapshot.metrics.imageCount.current).toBe(2);
    expect(snapshot.metrics.videoCount.current).toBe(1);
    expect(snapshot.metrics.netCredits.current).toBe(7.25);
  });

  it("同一稳定身份存在不同 operation_created_at 时拒绝返回数据", async () => {
    const reader = createReader({
      readSeries: vi.fn().mockResolvedValue([
        {
          bucketKey: "day:2026-08-10",
          imageCount: 1,
          videoCount: 0,
          videoSeconds: 0,
          creditHundredths: 0,
          operationCreatedAtMismatchCount: 1,
        },
      ]),
    });

    await expect(
      loadOperationsContentSnapshot(
        {
          range: { kind: "custom", from: "2026-08-10", to: "2026-08-10" },
        },
        "Asia/Shanghai",
        createRepository(reader)
      )
    ).rejects.toMatchObject({ code: "invalid_data" });
  });

  it("跨 epoch 保留上线前桶和真实值，完整 epoch 前范围不查询事实", async () => {
    const partialReader = createReader({
      readSeries: vi
        .fn()
        .mockResolvedValueOnce([
          {
            bucketKey: "day:2026-08-01",
            imageCount: 3,
            videoCount: 0,
            videoSeconds: 0,
            creditHundredths: 150,
            operationCreatedAtMismatchCount: 0,
          },
        ])
        .mockResolvedValueOnce([]),
    });
    const partial = await loadOperationsContentSnapshot(
      {
        range: { kind: "custom", from: "2026-07-31", to: "2026-08-02" },
        granularity: "day",
      },
      "Asia/Shanghai",
      createRepository(partialReader)
    );

    expect(partial.metrics.imageCount.status).toBe("value");
    expect(partial.series.imageCount.map((point) => point.status)).toEqual([
      "pre_epoch",
      "value",
      "value",
    ]);
    expect(partial.series.imageCount[1]).toMatchObject({ value: 3 });

    const preEpochReader = createReader();
    const preEpoch = await loadOperationsContentSnapshot(
      {
        range: { kind: "custom", from: "2026-07-28", to: "2026-07-30" },
      },
      "Asia/Shanghai",
      createRepository(preEpochReader)
    );

    expect(preEpoch.metrics.imageCount.status).toBe("pre_epoch");
    expect(preEpoch.metrics.netCredits.status).toBe("pre_epoch");
    expect(preEpochReader.readSeries).not.toHaveBeenCalled();
  });

  it("拒绝范围外桶、重复桶和非整数的百分之一积分", async () => {
    for (const rows of [
      [
        {
          bucketKey: "day:2026-08-10",
          imageCount: 1,
          videoCount: 0,
          videoSeconds: 0,
          creditHundredths: 0,
          operationCreatedAtMismatchCount: 0,
        },
        {
          bucketKey: "day:2026-08-10",
          imageCount: 2,
          videoCount: 0,
          videoSeconds: 0,
          creditHundredths: 0,
          operationCreatedAtMismatchCount: 0,
        },
      ],
      [
        {
          bucketKey: "day:outside",
          imageCount: 1,
          videoCount: 0,
          videoSeconds: 0,
          creditHundredths: 0,
          operationCreatedAtMismatchCount: 0,
        },
      ],
      [
        {
          bucketKey: "day:2026-08-10",
          imageCount: 1,
          videoCount: 0,
          videoSeconds: 0,
          creditHundredths: 12.5,
          operationCreatedAtMismatchCount: 0,
        },
      ],
    ]) {
      const reader = createReader({
        readSeries: vi.fn().mockResolvedValue(rows),
      });

      await expect(
        loadOperationsContentSnapshot(
          {
            range: {
              kind: "custom",
              from: "2026-08-10",
              to: "2026-08-10",
            },
          },
          "Asia/Shanghai",
          createRepository(reader)
        )
      ).rejects.toMatchObject({ code: "invalid_data" });
    }
  });
});
