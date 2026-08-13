/**
 * 图库详情返回恢复快照测试。
 *
 * 覆盖有界游标重放、主体/筛选/页签绑定、TTL、畸形存储和敏感 DTO 拒绝，
 * 保证 sessionStorage 只承担短期恢复元数据而不是图库内容缓存。
 */

import { describe, expect, it } from "vitest";
import {
  createGalleryRecoverySnapshot,
  parseGalleryRecoverySnapshot,
  readGalleryRecoverySnapshot,
  saveGalleryRecoverySnapshot,
} from "./gallery-recovery";

const now = Date.parse("2026-08-13T08:00:00.000Z");

/** 创建一份满足当前主体与筛选的有效恢复快照。 */
function validSnapshot() {
  return createGalleryRecoverySnapshot({
    cursorChain: ["cursor-2", "cursor-3"],
    filterFingerprint: "filter-fingerprint",
    nextCursor: "cursor-4",
    principalFingerprint: "principal-fingerprint",
    savedAt: now,
    scroll: {
      anchorItemId: "generation-42",
      anchorOffset: 24,
      scrollY: 1820,
    },
    tab: "final",
  });
}

describe("gallery recovery snapshot", () => {
  /** 有效快照可恢复游标链、下一边界和滚动锚点。 */
  it("restores bounded metadata for the same browsing scope", () => {
    const result = parseGalleryRecoverySnapshot(
      JSON.stringify(validSnapshot()),
      {
        filterFingerprint: "filter-fingerprint",
        now: now + 1_000,
        principalFingerprint: "principal-fingerprint",
        tab: "final",
      }
    );

    expect(result).toMatchObject({
      status: "valid",
      snapshot: {
        cursorChain: ["cursor-2", "cursor-3"],
        nextCursor: "cursor-4",
        scroll: { anchorItemId: "generation-42", scrollY: 1820 },
      },
    });
  });

  /** 过期快照安全失效，不允许详情返回时重放长期游标。 */
  it("rejects an expired snapshot", () => {
    expect(
      parseGalleryRecoverySnapshot(JSON.stringify(validSnapshot()), {
        filterFingerprint: "filter-fingerprint",
        now: now + 30 * 60 * 1_000 + 1,
        principalFingerprint: "principal-fingerprint",
        tab: "final",
      })
    ).toEqual({ reason: "expired", status: "invalid" });
  });

  /** 主体、筛选或页签不匹配时必须回退首批，不能跨浏览上下文恢复。 */
  it("binds the snapshot to principal, filters and tab", () => {
    const raw = JSON.stringify(validSnapshot());
    const base = {
      filterFingerprint: "filter-fingerprint",
      now: now + 1_000,
      principalFingerprint: "principal-fingerprint",
      tab: "final" as const,
    };

    expect(
      parseGalleryRecoverySnapshot(raw, {
        ...base,
        principalFingerprint: "another-principal",
      })
    ).toEqual({ reason: "principal-mismatch", status: "invalid" });
    expect(
      parseGalleryRecoverySnapshot(raw, {
        ...base,
        filterFingerprint: "another-filter",
      })
    ).toEqual({ reason: "filter-mismatch", status: "invalid" });
    expect(
      parseGalleryRecoverySnapshot(raw, { ...base, tab: "uploads" })
    ).toEqual({ reason: "tab-mismatch", status: "invalid" });
  });

  /** 快照拒绝卡片 DTO 和签名资源地址，避免 sessionStorage 无界保存内容。 */
  it("rejects stored items and signed resource URLs", () => {
    expect(
      parseGalleryRecoverySnapshot(
        JSON.stringify({
          ...validSnapshot(),
          items: [
            {
              id: "generation-1",
              imageUrl: "/api/storage/output.png?sig=long-lived",
            },
          ],
        }),
        {
          filterFingerprint: "filter-fingerprint",
          now: now + 1_000,
          principalFingerprint: "principal-fingerprint",
          tab: "final",
        }
      )
    ).toEqual({ reason: "malformed", status: "invalid" });
  });

  /** 超出最大重放批次数的快照无效，保证恢复成本保持有界。 */
  it("rejects an unbounded cursor chain", () => {
    expect(() =>
      createGalleryRecoverySnapshot({
        ...validSnapshot(),
        cursorChain: Array.from({ length: 11 }, (_, index) => `c-${index}`),
      })
    ).toThrow();
  });

  /** sessionStorage 不可用或内容损坏时返回安全失败而不是抛错。 */
  it("handles unavailable and malformed session storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(
      saveGalleryRecoverySnapshot(storage, "gallery", validSnapshot())
    ).toBe(true);
    expect(
      readGalleryRecoverySnapshot(storage, "gallery", {
        filterFingerprint: "filter-fingerprint",
        now: now + 1_000,
        principalFingerprint: "principal-fingerprint",
        tab: "final",
      }).status
    ).toBe("valid");
    expect(
      readGalleryRecoverySnapshot(
        {
          getItem: () => {
            throw new Error("storage denied");
          },
          setItem: () => undefined,
        },
        "gallery",
        {
          filterFingerprint: "filter-fingerprint",
          now: now + 1_000,
          principalFingerprint: "principal-fingerprint",
          tab: "final",
        }
      )
    ).toEqual({ reason: "unavailable", status: "invalid" });
  });
});
