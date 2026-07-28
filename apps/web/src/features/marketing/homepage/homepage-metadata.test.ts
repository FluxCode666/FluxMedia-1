/**
 * 官网首页 Metadata 纯构建器测试。
 *
 * 使用方：Vitest；约束中英文搜索摘要只表达作品、当前图像/视频模型与既有 API
 * 集成，并防止订阅、定价、积分或固定模型名重新进入首页索引内容。
 */
import { describe, expect, it } from "vitest";

import { buildHomepageMetadata } from "./homepage-metadata";

const REMOVED_TOPIC_PATTERN =
  /subscription|pricing|credits?|credit pack|积分|积分包|订阅|定价/i;
const HIDDEN_MODEL_CATEGORY_PATTERN = /conversation models|对话模型/i;
const FIXED_MODEL_PATTERN =
  /\b(?:gpt|claude|gemini|dall-e|imagen|midjourney|flux(?:[-_. ]?\d))\b/i;

describe("buildHomepageMetadata", () => {
  it.each([
    {
      locale: "zh" as const,
      titlePhrases: ["作品", "运行时模型", "API"],
      descriptionPhrases: ["图像与视频作品", "当前运行时生成模型", "API 集成"],
      keywordPhrases: ["AI 作品生成", "图像生成 API", "视频生成模型"],
    },
    {
      locale: "en" as const,
      titlePhrases: ["work", "runtime models", "API"],
      descriptionPhrases: [
        "work",
        "current runtime generation models",
        "API integration",
      ],
      keywordPhrases: [
        "AI artwork generation",
        "runtime AI models",
        "image generation API",
        "video generation models",
      ],
    },
  ])("$locale 输出新首页索引事实", ({
    locale,
    titlePhrases,
    descriptionPhrases,
    keywordPhrases,
  }) => {
    const metadata = buildHomepageMetadata(locale);
    const title = String(metadata.title);
    const description = String(metadata.description);
    const keywords = Array.isArray(metadata.keywords)
      ? metadata.keywords.map(String)
      : [];
    const indexText = JSON.stringify(metadata);

    for (const phrase of titlePhrases) {
      expect(title.toLowerCase()).toContain(phrase.toLowerCase());
    }
    for (const phrase of descriptionPhrases) {
      expect(description.toLowerCase()).toContain(phrase.toLowerCase());
    }
    for (const phrase of keywordPhrases) {
      expect(keywords.map((keyword) => keyword.toLowerCase())).toContain(
        phrase.toLowerCase()
      );
    }
    expect(indexText).not.toMatch(REMOVED_TOPIC_PATTERN);
    expect(indexText).not.toMatch(HIDDEN_MODEL_CATEGORY_PATTERN);
    expect(indexText).not.toMatch(FIXED_MODEL_PATTERN);
  });

  it("开放图与社交卡复用同一标题和描述，但不生成社媒跳转地址", () => {
    const metadata = buildHomepageMetadata("zh");

    expect(metadata.openGraph?.title).toBe(metadata.title);
    expect(metadata.openGraph?.description).toBe(metadata.description);
    expect(metadata.twitter?.title).toBe(metadata.title);
    expect(metadata.twitter?.description).toBe(metadata.description);
    expect(JSON.stringify(metadata)).not.toMatch(
      /twitter\.com|github\.com|discord\.(?:com|gg)/i
    );
  });
});
