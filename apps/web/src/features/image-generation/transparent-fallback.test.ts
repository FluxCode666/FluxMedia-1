import { describe, expect, it } from "vitest";
import { isTransparentUnsupportedError } from "./transparent-fallback";

describe("isTransparentUnsupportedError", () => {
  it("匹配后端'透明不支持'错误", () => {
    expect(
      isTransparentUnsupportedError(
        new Error(
          "Upstream Images API returned HTTP 400: Transparent background is not supported for this model. | invalid_value"
        )
      )
    ).toBe(true);
    expect(
      isTransparentUnsupportedError("transparent background is not supported")
    ).toBe(true);
  });

  it("不匹配其他错误", () => {
    expect(isTransparentUnsupportedError(new Error("rate limit reached"))).toBe(
      false
    );
    expect(isTransparentUnsupportedError(null)).toBe(false);
    expect(isTransparentUnsupportedError(undefined)).toBe(false);
  });
});
