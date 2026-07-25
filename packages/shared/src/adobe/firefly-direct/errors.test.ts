import { describe, expect, it } from "vitest";

import {
  AdobeAcceptedVideoError,
  AdobeRequestError,
  AuthError,
  isAdobeRotatableError,
  QuotaExhaustedError,
  UpstreamTemporaryError,
} from "./errors";

describe("isAdobeRotatableError", () => {
  it("rotates on 429/5xx upstream-temporary (submit failed: 429)", () => {
    const err = new UpstreamTemporaryError(
      'submit failed: 429 {"error":"rate limited"}',
      { statusCode: 429, errorType: "status" }
    );
    expect(isAdobeRotatableError(err)).toBe(true);
  });

  it("rotates on account quota exhausted and token auth errors", () => {
    expect(
      isAdobeRotatableError(new QuotaExhaustedError("Adobe quota exhausted"))
    ).toBe(true);
    expect(
      isAdobeRotatableError(
        new AuthError("Token invalid or expired", { statusCode: 401 })
      )
    ).toBe(true);
  });

  it("does not rotate on terminal request errors or non-Adobe errors", () => {
    // 请求本身的 4xx（如 400 坏请求）：换号也救不了，不轮换。
    expect(
      isAdobeRotatableError(new AdobeRequestError("submit failed: 400 bad"))
    ).toBe(false);
    expect(isAdobeRotatableError(new Error("network down"))).toBe(false);
    expect(isAdobeRotatableError(null)).toBe(false);
    // 仅按错误类型判定，不按消息字符串——传字符串不应被当作可轮换。
    expect(isAdobeRotatableError("submit failed: 429")).toBe(false);
    expect(
      isAdobeRotatableError(
        new AdobeAcceptedVideoError("poll failed after submission")
      )
    ).toBe(false);
  });
});
