/**
 * 首页 JSON-LD 纯生成器与安全渲染测试。
 *
 * 使用方：Vitest；验证可见 FAQ 与 FAQPage 共用同一问答、软件结构无报价、
 * 空社媒配置不产生占位，并锁定 script 闭合攻击的安全转义。
 */

import { siteConfig } from "@repo/shared/config";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HomePageJsonLd } from "@/components/seo/json-ld";
import {
  HomepageFaq,
  parseHomepageFaqItems,
} from "@/features/marketing/homepage/homepage-faq";
import enMessages from "../../../messages/en.json";
import zhMessages from "../../../messages/zh.json";

import {
  generateFAQSchema,
  generateOrganizationSchema,
  generateSoftwareApplicationSchema,
} from "./json-ld";

/**
 * 从静态 HTML 中解析全部 JSON-LD 对象。
 *
 * @param html - React 服务端渲染产生的静态 HTML。
 * @returns 按脚本出现顺序解析的结构化数据对象。
 * @throws script 内容不是有效 JSON 时显式抛出解析错误。
 */
function parseJsonLdScripts(html: string): Record<string, unknown>[] {
  return Array.from(
    html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g),
    (match) => JSON.parse(match[1] ?? "null") as Record<string, unknown>
  );
}

describe("首页 FAQ 结构化数据", () => {
  it.each([
    ["zh" as const, zhMessages.Homepage.faq],
    ["en" as const, enMessages.Homepage.faq],
  ])("%s FAQPage 与页面可见问答逐项一致", (locale, faqCopy) => {
    const faqItems = parseHomepageFaqItems(faqCopy.items);
    const visibleHtml = renderToStaticMarkup(
      createElement(HomepageFaq, {
        eyebrow: faqCopy.eyebrow,
        title: faqCopy.title,
        description: faqCopy.description,
        items: faqItems,
      })
    );
    const jsonLdHtml = renderToStaticMarkup(
      createElement(HomePageJsonLd, { locale, faqs: faqItems })
    );
    const faqSchema = parseJsonLdScripts(jsonLdHtml).find(
      (schema) => schema["@type"] === "FAQPage"
    );

    expect(faqSchema).toEqual(generateFAQSchema(faqItems));
    for (const item of faqItems) {
      expect(visibleHtml).toContain(item.question);
      expect(visibleHtml).toContain(item.answer);
    }
    expect(JSON.stringify(faqSchema)).not.toMatch(
      /subscription|pricing|credits?|credit pack|积分包|订阅套餐|初始积分|额外收费/i
    );
  });
});

describe("首页产品与组织结构化数据", () => {
  it.each([
    "zh",
    "en",
  ] as const)("%s SoftwareApplication 保留产品事实但不输出报价", (locale) => {
    const schema = generateSoftwareApplicationSchema(locale);
    const serialized = JSON.stringify(schema);

    expect(schema).toMatchObject({
      "@type": "SoftwareApplication",
      name: "FluxMedia",
      applicationCategory: "MultimediaApplication",
      url: expect.stringMatching(/^https?:\/\//),
    });
    expect(schema.description).toEqual(expect.any(String));
    expect(schema.description.length).toBeGreaterThan(0);
    expect(schema).not.toHaveProperty("offers");
    expect(serialized).not.toMatch(/Offer|free tier|免费版本|priceCurrency/i);
  });

  it("社媒配置为空时 Organization 不输出 sameAs 或空地址", () => {
    const schema = generateOrganizationSchema();
    const serialized = JSON.stringify(schema);

    expect(schema.logo).toBe(`${siteConfig.url}${siteConfig.logo}`);
    expect(schema).not.toHaveProperty("sameAs");
    expect(serialized).not.toMatch(/twitter|github|discord/i);
    expect(serialized).not.toContain('"sameAs":[]');
    expect(serialized).not.toContain('"sameAs":""');
  });
});

describe("首页 JSON-LD script 安全序列化", () => {
  it("FAQ 攻击字符串不能闭合 script 或注入第二个脚本", () => {
    const attack = '</script><script data-canary="injected">alert(1)</script>';
    const html = renderToStaticMarkup(
      createElement(HomePageJsonLd, {
        locale: "zh",
        faqs: [{ question: attack, answer: attack }],
      })
    );
    const schemas = parseJsonLdScripts(html);
    const faqSchema = schemas.find((schema) => schema["@type"] === "FAQPage");

    expect(html).not.toContain(attack);
    expect(html).not.toContain('<script data-canary="injected">');
    expect(html).toContain("\\u003c/script>");
    expect(faqSchema).toEqual(
      generateFAQSchema([{ question: attack, answer: attack }])
    );
  });
});
