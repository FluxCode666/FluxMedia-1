import { describe, expect, it } from "vitest";

import {
  AdobeAcceptedVideoError,
  AdobeRequestError,
  AuthError,
  isAdobeMemberSwitchableError,
  QuotaExhaustedError,
  UpstreamTemporaryError,
} from "./errors";

describe("isAdobeMemberSwitchableError", () => {
  it("switches members on 429/5xx upstream-temporary errors", () => {
    const err = new UpstreamTemporaryError(
      'submit failed: 429 {"error":"rate limited"}',
      { statusCode: 429, errorType: "status" }
    );
    expect(isAdobeMemberSwitchableError(err)).toBe(true);
  });

  it("switches members on account quota and token auth errors", () => {
    expect(
      isAdobeMemberSwitchableError(
        new QuotaExhaustedError("Adobe quota exhausted")
      )
    ).toBe(true);
    expect(
      isAdobeMemberSwitchableError(
        new AuthError("Token invalid or expired", { statusCode: 401 })
      )
    ).toBe(true);
  });

  it("does not switch members on terminal or non-Adobe errors", () => {
    // 请求本身的 4xx（如 400 坏请求）：切换成员也无法恢复。
    expect(
      isAdobeMemberSwitchableError(
        new AdobeRequestError("submit failed: 400 bad")
      )
    ).toBe(false);
    expect(isAdobeMemberSwitchableError(new Error("network down"))).toBe(false);
    expect(isAdobeMemberSwitchableError(null)).toBe(false);
    // 仅按错误类型判定，不按消息字符串——传字符串不应触发成员切换。
    expect(isAdobeMemberSwitchableError("submit failed: 429")).toBe(false);
    expect(
      isAdobeMemberSwitchableError(
        new AdobeAcceptedVideoError("poll failed after submission")
      )
    ).toBe(false);
  });
});
