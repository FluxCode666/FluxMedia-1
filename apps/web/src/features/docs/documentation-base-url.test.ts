/**
 * 文档 Base URL 解析与占位符替换测试。
 *
 * 覆盖生产反向代理、本地开发端口、非法转发头和配置失败边界，确保复制出的 API
 * 示例始终绑定用户当前访问的合法 HTTP(S) origin。
 */
import { describe, expect, it } from "vitest";

import {
  DOCUMENTATION_BASE_URL_PLACEHOLDER,
  replaceDocumentationBaseUrl,
  resolveDocumentationBaseUrl,
} from "./documentation-base-url";

/** 使用标准 Headers 构造纯解析测试输入，不启动 Next.js 服务。 */
function createHeaders(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("resolveDocumentationBaseUrl", () => {
  it("优先使用反向代理提供的当前公网域名和协议", () => {
    const result = resolveDocumentationBaseUrl(
      createHeaders({
        host: "web:3000",
        "x-forwarded-host": "tenant.example.com",
        "x-forwarded-proto": "https",
      }),
      "https://configured.example.com"
    );

    expect(result).toBe("https://tenant.example.com");
  });

  it("代理链只读取第一个公开值并保留非默认端口", () => {
    const result = resolveDocumentationBaseUrl(
      createHeaders({
        "x-forwarded-host": "preview.example.com:8443, web:3000",
        "x-forwarded-proto": "https, http",
      }),
      "https://configured.example.com"
    );

    expect(result).toBe("https://preview.example.com:8443");
  });

  it.each([
    "localhost:3000",
    "127.0.0.1:3100",
    "[::1]:3200",
  ])("直连本地开发 Host %s 使用 HTTP", (host) => {
    expect(
      resolveDocumentationBaseUrl(
        createHeaders({ host }),
        "https://configured.example.com"
      )
    ).toBe(`http://${host}`);
  });

  it("非法转发 Host 回退到当前请求 Host", () => {
    const result = resolveDocumentationBaseUrl(
      createHeaders({
        host: "safe.example.com",
        "x-forwarded-host": "user@attacker.example.com/path",
        "x-forwarded-proto": "https",
      }),
      "https://configured.example.com"
    );

    expect(result).toBe("https://safe.example.com");
  });

  it("缺少可用请求 Host 时回退站点配置 origin", () => {
    expect(
      resolveDocumentationBaseUrl(
        createHeaders({ "x-forwarded-host": "invalid/path" }),
        "https://configured.example.com/"
      )
    ).toBe("https://configured.example.com");
  });

  it("拒绝带路径的回退配置", () => {
    expect(() =>
      resolveDocumentationBaseUrl(
        createHeaders({}),
        "https://configured.example.com/app"
      )
    ).toThrow("Documentation fallback Base URL must be an origin");
  });
});

describe("replaceDocumentationBaseUrl", () => {
  it("替换示例中的全部 Base URL 占位符", () => {
    const source = `${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/models\n${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/credits`;

    expect(
      replaceDocumentationBaseUrl(source, "https://tenant.example.com")
    ).toBe(
      "https://tenant.example.com/v1/models\nhttps://tenant.example.com/v1/credits"
    );
  });
});
