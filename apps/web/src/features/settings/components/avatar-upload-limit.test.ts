import { describe, expect, it } from "vitest";

import {
  isAvatarFileSizeAllowed,
  resolveAvatarMaxFileSizeBytes,
} from "./avatar-upload-limit";

const FIVE_MB = 5 * 1024 * 1024;

describe("头像上传大小限制", () => {
  it("使用系统统一上限并允许精确边界", () => {
    expect(resolveAvatarMaxFileSizeBytes(FIVE_MB)).toBe(FIVE_MB);
    expect(isAvatarFileSizeAllowed(FIVE_MB, FIVE_MB)).toBe(true);
    expect(isAvatarFileSizeAllowed(FIVE_MB + 1, FIVE_MB)).toBe(false);
  });

  it("非法系统值回退到 5 MB", () => {
    expect(resolveAvatarMaxFileSizeBytes(Number.NaN)).toBe(FIVE_MB);
    expect(resolveAvatarMaxFileSizeBytes(0)).toBe(FIVE_MB);
  });
});
