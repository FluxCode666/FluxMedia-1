/**
 * JSON-safe 媒体引用契约测试。
 *
 * 职责：验证 data、storage、remote 三种跨传输媒体 DTO，以及 MIME、单项和总字节
 * 边界；真实远程下载仍需在 operation 执行时经过 SSRF 与内容复验。
 */
import { describe, expect, it } from "vitest";

import {
  MAX_MEDIA_INPUT_BYTES,
  mediaInputReferenceSchema,
  mediaInputReferencesSchema,
} from "./media-contract";

describe("media input reference contract", () => {
  it.each([
    {
      source: "data",
      mimeType: "image/png",
      base64: "aW1hZ2U=",
      byteLength: 5,
    },
    {
      source: "storage",
      mimeType: "image/jpeg",
      storageKey: "users/u1/input.jpg",
      storageBucket: "generations",
      byteLength: 128,
    },
    {
      source: "remote",
      mimeType: "image/webp",
      url: "https://cdn.example.com/input.webp",
      byteLength: 256,
    },
  ])("accepts $source media reference", (input) => {
    expect(mediaInputReferenceSchema.safeParse(input).success).toBe(true);
  });

  it("rejects invalid MIME, unsafe URL and unknown fields", () => {
    expect(
      mediaInputReferenceSchema.safeParse({
        source: "data",
        mimeType: "text/html",
        base64: "PGh0bWw+",
        byteLength: 6,
      }).success
    ).toBe(false);
    expect(
      mediaInputReferenceSchema.safeParse({
        source: "remote",
        mimeType: "image/png",
        url: "http://127.0.0.1/input.png",
        byteLength: 10,
      }).success
    ).toBe(false);
    expect(
      mediaInputReferenceSchema.safeParse({
        source: "storage",
        mimeType: "image/png",
        storageKey: "users/u1/input.png",
        byteLength: 10,
        authorization: "secret",
      }).success
    ).toBe(false);
  });

  it("rejects inconsistent base64 length and oversized totals", () => {
    expect(
      mediaInputReferenceSchema.safeParse({
        source: "data",
        mimeType: "image/png",
        base64: "aW1hZ2U=",
        byteLength: 100,
      }).success
    ).toBe(false);

    const oversized = Array.from({ length: 2 }, (_, index) => ({
      source: "storage" as const,
      mimeType: "image/png" as const,
      storageKey: `users/u1/${index}.png`,
      byteLength: MAX_MEDIA_INPUT_BYTES / 2 + 1,
    }));
    expect(mediaInputReferencesSchema.safeParse(oversized).success).toBe(false);
  });
});
