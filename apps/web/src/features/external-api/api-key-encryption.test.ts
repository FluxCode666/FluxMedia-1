/**
 * 外部 API Key 可恢复密文工具的 DB-free 单元测试。
 *
 * 职责：验证密文不泄露明文、可重复恢复、错误 Secret 与损坏密文 fail-closed。
 * 使用方：API Key 刷新后复制能力的密码学回归门。
 * 关键依赖：Vitest、Node.js crypto。
 */
import { describe, expect, it } from "vitest";

import {
  decryptExternalApiKey,
  encryptExternalApiKey,
} from "./api-key-encryption";

const API_KEY = "sk-test-api-key";
const ENCRYPTION_SECRET = "test-encryption-secret";

describe("external API key encryption", () => {
  it("使用随机 IV 生成不同密文并可恢复同一个 API Key", () => {
    const first = encryptExternalApiKey(API_KEY, ENCRYPTION_SECRET);
    const second = encryptExternalApiKey(API_KEY, ENCRYPTION_SECRET);

    expect(first).not.toBe(second);
    expect(first).not.toContain(API_KEY);
    expect(first.startsWith("v1.")).toBe(true);
    expect(decryptExternalApiKey(first, ENCRYPTION_SECRET)).toBe(API_KEY);
    expect(decryptExternalApiKey(second, ENCRYPTION_SECRET)).toBe(API_KEY);
  });

  it("错误 Secret 或损坏密文都会拒绝恢复", () => {
    const encrypted = encryptExternalApiKey(API_KEY, ENCRYPTION_SECRET);

    expect(() => decryptExternalApiKey(encrypted, "wrong-secret")).toThrow(
      "Stored API key could not be decrypted"
    );
    expect(() =>
      decryptExternalApiKey("v1.invalid", ENCRYPTION_SECRET)
    ).toThrow("Stored API key could not be decrypted");
  });
});
