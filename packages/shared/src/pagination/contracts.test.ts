/**
 * 共享分页信封的 DB-free 契约测试。
 *
 * 使用方：UOL 列表迁移回归，防止业务域重命名元数据或混入未知字段。
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createKeysetPaginationOutputSchema,
  createOffsetPaginationOutputSchema,
} from "./contracts";

const recordSchema = z.object({ id: z.string() }).strict();

describe("pagination contracts", () => {
  it("接受精确 offset 分页信封", () => {
    const schema = createOffsetPaginationOutputSchema(recordSchema);
    expect(
      schema.parse({
        records: [{ id: "record-1" }],
        page: 2,
        pageSize: 20,
        totalCount: 21,
        totalPages: 2,
      })
    ).toMatchObject({ page: 2, totalCount: 21 });
  });

  it("接受带浏览上界的 keyset 分页信封", () => {
    const schema = createKeysetPaginationOutputSchema(recordSchema);
    expect(
      schema.parse({
        records: [],
        page: 1,
        pageSize: 20,
        totalCount: 0,
        asOf: "2026-08-13T00:00:00.000Z",
        previousCursor: null,
        nextCursor: null,
      })
    ).toMatchObject({ page: 1, totalCount: 0 });
  });

  it("拒绝不安全计数、零页码和第二套元数据", () => {
    const offsetSchema = createOffsetPaginationOutputSchema(recordSchema);
    expect(
      offsetSchema.safeParse({
        records: [],
        page: 0,
        pageSize: 20,
        totalCount: -1,
        totalPages: 1,
      }).success
    ).toBe(false);
    expect(
      offsetSchema.safeParse({
        records: [],
        items: [],
        page: 1,
        pageSize: 20,
        totalCount: 0,
        totalPages: 1,
      }).success
    ).toBe(false);
  });
});
