/**
 * 模型配置 multipart 保存请求的 DB-free Origin 校验测试。
 *
 * 使用方是后续管理保存 Route；测试确保仅站点静态受信来源或未配置部署来源时的同源本地
 * 请求可以继续读取正文，缺失、opaque、非法协议、无效配置与跨站来源全部失败关闭。
 */
import { describe, expect, it } from "vitest";

import {
  getTrustedModelConfigurationOrigins,
  hasTrustedModelConfigurationOrigin,
} from "./request-origin";

/**
 * 创建模型配置保存请求并允许省略 Origin。
 *
 * @param origin - 浏览器 Origin 头；undefined 用于模拟脚本或伪造请求缺失头部。
 * @param requestUrl - 服务端看到的完整请求 URL，用于本地未配置场景的同源回退。
 * @returns 不携带 Cookie、正文或凭据的 POST Request。
 * @sideEffects 无网络请求；只创建标准 Request 对象。
 * @failure Request 构造参数非法时由标准运行时抛出 TypeError。
 */
function createRequest(
  origin?: string,
  requestUrl = "https://app.example.test/api/admin/model-configuration"
): Request {
  return new Request(requestUrl, {
    method: "POST",
    headers: origin ? { Origin: origin } : undefined,
  });
}

describe("模型配置保存请求 Origin 校验", () => {
  it("只接受 Better Auth 配置的站点 Origin 并拒绝跨站来源", () => {
    const environment = { BETTER_AUTH_URL: "https://app.example.test" };

    expect(
      hasTrustedModelConfigurationOrigin(
        createRequest("https://app.example.test"),
        environment
      )
    ).toBe(true);
    expect(
      hasTrustedModelConfigurationOrigin(
        createRequest("https://attacker.example.test"),
        environment
      )
    ).toBe(false);
  });

  it("支持逗号分隔的额外受信来源并按标准 URL origin 去重", () => {
    const environment = {
      BETTER_AUTH_URL: "https://APP.example.test:443/login",
      BETTER_AUTH_TRUSTED_ORIGINS:
        " https://studio.example.test/path , https://app.example.test ",
    };

    expect(
      getTrustedModelConfigurationOrigins(createRequest(), environment)
    ).toEqual(
      new Set(["https://app.example.test", "https://studio.example.test"])
    );
    expect(
      hasTrustedModelConfigurationOrigin(
        createRequest("https://studio.example.test/editor"),
        environment
      )
    ).toBe(true);
  });

  it.each([
    undefined,
    "null",
    "not a URL",
    "data:text/plain,origin",
    "ftp://app.example.test",
  ])("拒绝缺失、opaque、格式错误或非 HTTP(S) Origin：%s", (origin) => {
    expect(
      hasTrustedModelConfigurationOrigin(createRequest(origin), {
        BETTER_AUTH_URL: "https://app.example.test",
      })
    ).toBe(false);
  });

  it("仅在没有部署来源配置时回退到请求 URL 的同源 Origin", () => {
    expect(
      hasTrustedModelConfigurationOrigin(
        createRequest(
          "http://localhost:3100",
          "http://localhost:3100/api/admin/model-configuration"
        ),
        {}
      )
    ).toBe(true);
    expect(
      hasTrustedModelConfigurationOrigin(
        createRequest(
          "http://attacker.test",
          "http://localhost:3100/api/admin/model-configuration"
        ),
        {}
      )
    ).toBe(false);
  });

  it("部署来源配置存在但全部非法时失败关闭且不信任请求 Host", () => {
    const environment = {
      BETTER_AUTH_URL: "not a URL",
      BETTER_AUTH_TRUSTED_ORIGINS: "null,ftp://app.example.test",
    };
    const request = createRequest("https://app.example.test");

    expect(getTrustedModelConfigurationOrigins(request, environment)).toEqual(
      new Set()
    );
    expect(hasTrustedModelConfigurationOrigin(request, environment)).toBe(
      false
    );
  });
});
