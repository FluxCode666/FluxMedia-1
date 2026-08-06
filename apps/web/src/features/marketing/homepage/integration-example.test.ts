/**
 * 首页快速集成示例的安全契约测试。
 *
 * 使用方：Vitest；覆盖可信 origin、运行时模型选择、shell/JSON 注入防护与目录失败
 * 降级，确保首页不会把请求头或真实 API Key 拼进可复制命令。
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HomepageIntegration } from "./homepage-integration";
import {
  buildHomepageIntegrationExample,
  getHomepageIntegrationContent,
  type HomepageIntegrationCatalogState,
} from "./integration-example";

vi.mock("@/i18n/routing", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement("a", { href }, children),
}));

const READY_CATALOG = {
  status: "ready",
  image: [{ id: "gpt-image-alpha" }, { id: "gpt-image-zeta" }],
} as const satisfies HomepageIntegrationCatalogState;

/** 创建使用可信生产 origin 的构建器输入。 */
function createProductionInput(
  overrides: Partial<Parameters<typeof buildHomepageIntegrationExample>[0]> = {}
) {
  return {
    catalog: READY_CATALOG,
    origin: "https://media.example.com",
    runtime: "production" as const,
    ...overrides,
  };
}

describe("buildHomepageIntegrationExample", () => {
  it.each([
    "https://media.example.com",
    "https://media.example.com/",
  ])("为可信 HTTPS origin 生成稳定的首次图片请求：%s", (origin) => {
    const result = buildHomepageIntegrationExample(
      createProductionInput({ origin })
    );

    expect(result.status).toBe("available");
    if (result.status !== "available") return;

    expect(result.modelId).toBe("gpt-image-alpha");
    expect(result.endpointUrl).toBe(
      "https://media.example.com/v1/images/generations"
    );
    expect(result.curl.match(/\/v1\/images\/generations/g)?.length).toBe(1);
    expect(result.curl).toContain("$FLUXMEDIA_API_KEY");
    expect(result.curl).not.toContain("<API_KEY>");
    expect(JSON.parse(result.requestBody)).toMatchObject({
      model: "gpt-image-alpha",
      response_format: "url",
    });
    expect(JSON.parse(result.requestBody)).not.toHaveProperty("n");
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000/",
    "http://127.25.4.9:3000",
    "http://[::1]:3000",
  ])("仅在开发环境接受 loopback HTTP：%s", (origin) => {
    const result = buildHomepageIntegrationExample(
      createProductionInput({ origin, runtime: "development" })
    );

    expect(result.status).toBe("available");
  });

  it.each([
    "http://media.example.com",
    "http://localhost:3000",
    "https://user:password@media.example.com",
    "https://media.example.com?origin=evil.example",
    "https://media.example.com#fragment",
    "https://media.example.com/not-an-origin",
    "https://media.example.com,https://forwarded.example",
    "https://media.example.com\n-H 'X-Injected: yes'",
    "//forwarded.example",
  ])("对生产不安全 origin 失败关闭且不生成 cURL：%s", (origin) => {
    const result = buildHomepageIntegrationExample(
      createProductionInput({ origin })
    );

    expect(result).toEqual({
      reason: "unsafe_origin",
      status: "unavailable",
    });
    expect(result).not.toHaveProperty("curl");
  });

  it.each([
    "http://example.com",
    "http://127.0.0.1.evil.example:3000",
    "http://[::2]:3000",
  ])("开发环境也拒绝非 loopback HTTP：%s", (origin) => {
    const result = buildHomepageIntegrationExample(
      createProductionInput({ origin, runtime: "development" })
    );

    expect(result.status).toBe("unavailable");
  });

  it("对模型 ID 同时执行 JSON 序列化和 shell 单引号转义", () => {
    const attackModel = "image';\n touch /tmp/pwned; `id`; $(whoami) #";
    const result = buildHomepageIntegrationExample(
      createProductionInput({
        catalog: { status: "ready", image: [{ id: attackModel }] },
      })
    );

    expect(result.status).toBe("available");
    if (result.status !== "available") return;

    expect(JSON.parse(result.requestBody).model).toBe(attackModel);
    expect(result.requestBody).toContain("\\n");
    expect(result.curl).toContain("'\"'\"'");
    expect(result.curl).not.toContain("\n touch /tmp/pwned");
    expect(result.curl).toContain("$(whoami)");
    expect(result.curl.split("\n")).toHaveLength(4);
  });

  it("忽略调用方夹带的真实 API Key，只生成固定环境变量占位符", () => {
    const inputWithCanary = {
      ...createProductionInput(),
      apiKey: "sk-real-api-key-canary",
      authorization: "Bearer another-real-key-canary",
    };
    const result = buildHomepageIntegrationExample(inputWithCanary);

    expect(result.status).toBe("available");
    if (result.status !== "available") return;

    expect(result.curl).toContain("$FLUXMEDIA_API_KEY");
    expect(result.curl).not.toMatch(
      /sk-real-api-key-canary|another-real-key-canary/
    );
  });

  it.each([
    {
      catalog: { status: "unavailable" } as const,
      reason: "catalog_unavailable" as const,
    },
    {
      catalog: { status: "ready", image: [] } as const,
      reason: "no_image_model" as const,
    },
    {
      catalog: {
        status: "ready",
        image: [{ id: "default" }, { id: "unknown" }, { id: "auto" }],
      } as const,
      reason: "no_image_model" as const,
    },
  ])("目录不可用或没有具体图像模型时不生成命令", ({ catalog, reason }) => {
    const result = buildHomepageIntegrationExample(
      createProductionInput({ catalog })
    );

    expect(result).toEqual({ status: "unavailable", reason });
    expect(result).not.toHaveProperty("curl");
  });
});

describe("getHomepageIntegrationContent", () => {
  it.each([
    {
      locale: "zh",
      phrases: ["快速集成", "服务端", "GET /v1/models", "权限"],
      copy: "复制",
    },
    {
      locale: "en",
      phrases: ["Quick integration", "server", "GET /v1/models", "permission"],
      copy: "Copy",
    },
  ])("$locale 提供三步、安全限制与固定入口", ({ locale, phrases, copy }) => {
    const content = getHomepageIntegrationContent(locale);
    const visibleText = JSON.stringify(content);

    expect(content.steps).toHaveLength(3);
    expect(content.links).toEqual({
      apiDocs: "/api-docs",
      apiKeys: "/dashboard/external-api",
    });
    expect(content.copyLabels.copy).toBe(copy);
    expect(content.endpointPath).toBe("/v1/images/generations");
    for (const phrase of phrases) {
      expect(visibleText.toLowerCase()).toContain(phrase.toLowerCase());
    }
    expect(visibleText).not.toMatch(/subscription|订阅|积分包|credit pack/i);
  });
});

describe("HomepageIntegration", () => {
  it("可用状态通过共享代码块服务端输出占位密钥和运行时模型", () => {
    const html = renderToStaticMarkup(
      HomepageIntegration({ catalog: READY_CATALOG, locale: "en" })
    );

    expect(html).toContain("gpt-image-alpha");
    expect(html).toContain("/v1/images/generations");
    expect(html).toContain("$FLUXMEDIA_API_KEY");
    expect(html).toContain("Server-side cURL example");
    expect(html).not.toMatch(/sk-real-api-key-canary|another-real-key-canary/);
  });

  it("不可用状态仍服务端输出三步和两个固定入口，不输出 cURL", () => {
    const html = renderToStaticMarkup(
      HomepageIntegration({
        catalog: { status: "unavailable" },
        locale: "zh",
      })
    );

    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).toContain('href="/api-docs"');
    expect(html).toContain('href="/dashboard/external-api"');
    expect(html).toContain("当前无法读取公开模型目录");
    expect(html).not.toContain("curl &#x27;");
  });
});
