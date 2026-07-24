/** 页面生图来源校验的 DB-free 单测。 */

import { describe, expect, it } from "vitest";
import {
  getTrustedImageGenerationOrigins,
  hasTrustedImageGenerationOrigin,
} from "./request-security";

function createRequest(origin?: string) {
  return new Request("https://app.example.test/api/images/generate", {
    method: "POST",
    headers: origin ? { Origin: origin } : undefined,
  });
}

describe("页面生图请求来源校验", () => {
  it("只接受 Better Auth 配置的站点 Origin", () => {
    const environment = { BETTER_AUTH_URL: "https://app.example.test" };

    expect(
      hasTrustedImageGenerationOrigin(
        createRequest("https://app.example.test"),
        environment
      )
    ).toBe(true);
    expect(
      hasTrustedImageGenerationOrigin(
        createRequest("https://attacker.example.test"),
        environment
      )
    ).toBe(false);
  });

  it("支持额外受信 Origin，并按 URL origin 标准化比较", () => {
    const environment = {
      BETTER_AUTH_URL: "https://app.example.test",
      BETTER_AUTH_TRUSTED_ORIGINS:
        " https://studio.example.test/path , https://APP.EXAMPLE.TEST ",
    };

    expect(
      hasTrustedImageGenerationOrigin(
        createRequest("https://studio.example.test"),
        environment
      )
    ).toBe(true);
    expect(
      getTrustedImageGenerationOrigins(createRequest(), environment)
    ).toEqual(
      new Set(["https://app.example.test", "https://studio.example.test"])
    );
  });

  it("拒绝缺失、null 或格式非法的 Origin", () => {
    const environment = { BETTER_AUTH_URL: "https://app.example.test" };

    expect(hasTrustedImageGenerationOrigin(createRequest(), environment)).toBe(
      false
    );
    expect(
      hasTrustedImageGenerationOrigin(createRequest("null"), environment)
    ).toBe(false);
    expect(
      hasTrustedImageGenerationOrigin(createRequest("not a URL"), environment)
    ).toBe(false);
  });

  it("仅在没有部署来源配置时回退到请求 origin", () => {
    const request = createRequest("https://app.example.test");

    expect(hasTrustedImageGenerationOrigin(request, {})).toBe(true);
    expect(
      hasTrustedImageGenerationOrigin(
        createRequest("https://attacker.example.test"),
        {}
      )
    ).toBe(false);
  });

  it("配置存在但全部无效时失败关闭，不信任请求 Host", () => {
    const environment = { BETTER_AUTH_URL: "not a URL" };
    const request = createRequest("https://app.example.test");

    expect(getTrustedImageGenerationOrigins(request, environment)).toEqual(
      new Set()
    );
    expect(hasTrustedImageGenerationOrigin(request, environment)).toBe(false);
  });
});
