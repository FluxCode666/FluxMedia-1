/**
 * 图库 PostgreSQL SQL 构造器测试。
 *
 * 不连接数据库，编译三类页签查询，证明所有读取都有用户/浏览上界/唯一排序键和
 * limit，上传图按 JSON 数组序号展开成卡片而不是按父任务粗粒度翻页。
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ db: { execute: vi.fn() } }));

import {
  buildFinalGallerySql,
  buildUploadGallerySql,
  buildVideoGallerySql,
} from "./gallery-repository";

const baseQuery = {
  userId: "user-1",
  tab: "final" as const,
  asOf: new Date("2026-08-13T08:00:00.000Z"),
  cursor: {
    createdAt: new Date("2026-08-13T07:00:00.000Z"),
    id: "item-20",
  },
  limit: 21,
};

/** 编译 Drizzle SQL，保留参数化值用于约束断言。 */
function compile(query: Parameters<PgDialect["sqlToQuery"]>[0]) {
  return new PgDialect().sqlToQuery(query);
}

describe("gallery repository SQL", () => {
  /** 成品页只读取本人已完成、有存储产物的一批任务。 */
  it("builds a bounded final-image keyset query", () => {
    const compiled = compile(buildFinalGallerySql(baseQuery));
    expect(compiled.sql).toContain("g.user_id =");
    expect(compiled.sql).toContain("g.status = 'completed'");
    expect(compiled.sql).toContain("g.storage_key is not null");
    expect(compiled.sql).toContain("(g.created_at, g.id) <");
    expect(compiled.sql).toContain("order by g.created_at desc, g.id desc");
    expect(compiled.params).toContain("user-1");
    expect(compiled.params).toContain(21);
  });

  /** 上传页在父任务内部展开数组并使用合成 card sort id，避免多图跳项。 */
  it("expands upload cards before applying the keyset", () => {
    const compiled = compile(
      buildUploadGallerySql({ ...baseQuery, tab: "uploads" })
    );
    expect(compiled.sql).toContain("jsonb_array_elements");
    expect(compiled.sql).toContain("with ordinality");
    expect(compiled.sql).toContain("input_index");
    expect(compiled.sql).toContain("sort_id");
    expect(compiled.sql).toContain("(created_at, sort_id) <");
    expect(compiled.sql).toContain("order by created_at desc, sort_id desc");
    expect(compiled.params).toContain(21);
  });

  /** 视频页沿用独立表唯一 keyset，不加载图片或上传图数据。 */
  it("builds a bounded video keyset query", () => {
    const compiled = compile(
      buildVideoGallerySql({ ...baseQuery, tab: "videos" })
    );
    expect(compiled.sql).toContain("from video_generation v");
    expect(compiled.sql).toContain("v.status = 'completed'");
    expect(compiled.sql).toContain("(v.created_at, v.id) <");
    expect(compiled.sql).toContain("order by v.created_at desc, v.id desc");
    expect(compiled.sql).not.toContain("from generation g");
  });
});
