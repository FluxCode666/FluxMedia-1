import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  db: {},
}));

vi.mock("@repo/database/schema", () => ({
  systemSetting: {
    key: "key",
    value: "value",
  },
}));

import {
  applyManagedEnvBlock,
  buildManagedEnvBlock,
  shouldSyncSettingToEnvFile,
} from "./env-file";

const BEGIN = "# BEGIN GPT2IMAGE ADMIN SETTINGS";
const END = "# END GPT2IMAGE ADMIN SETTINGS";

describe("system settings env file sync", () => {
  it("only writes registered settings not owned by dedicated operations", () => {
    expect(shouldSyncSettingToEnvFile("NEXT_PUBLIC_APP_URL")).toBe(true);
    expect(shouldSyncSettingToEnvFile("SYSTEM_ASSETS_BUCKET_NAME")).toBe(true);
    expect(shouldSyncSettingToEnvFile("APP_TIME_ZONE")).toBe(false);
    expect(
      shouldSyncSettingToEnvFile("CONTENT_MODERATION_BLOCK_RISK_LEVEL")
    ).toBe(false);
    expect(shouldSyncSettingToEnvFile("MODEL_MARKETPLACE_CONFIG")).toBe(false);
    expect(shouldSyncSettingToEnvFile("VIDEO_MODEL_CAPABILITY_OVERRIDES")).toBe(
      false
    );

    expect(shouldSyncSettingToEnvFile("UNKNOWN_INTERNAL_SETTING")).toBe(false);
  });
});

describe("buildManagedEnvBlock", () => {
  it("serializes string/number/object values with JSON.stringify quoting", () => {
    const block = buildManagedEnvBlock([
      { key: "NEXT_PUBLIC_APP_NAME", value: "Hello World" },
      { key: "RATE_LIMIT_AI_REQUESTS_PER_MINUTE", value: 20 },
    ]);

    expect(block).toContain('NEXT_PUBLIC_APP_NAME="Hello World"');
    expect(block).toContain('RATE_LIMIT_AI_REQUESTS_PER_MINUTE="20"');
  });

  it("only includes synced keys, sorted, wrapped in BEGIN/END markers", () => {
    const block = buildManagedEnvBlock([
      { key: "NEXT_PUBLIC_APP_URL", value: "https://example.com" },
      // 非托管 key（不在定义且非内部白名单）应被过滤掉
      { key: "SOME_UNMANAGED_KEY", value: "secret" },
      { key: "NEXT_PUBLIC_APP_NAME", value: "FluxMedia" },
      // 空值（null/undefined）应被剔除
      { key: "NEXT_PUBLIC_APP_NAME", value: null },
    ]);

    const lines = block.split("\n");
    expect(lines[0]).toBe(BEGIN);
    expect(lines[lines.length - 1]).toBe(END);
    expect(block).not.toContain("SOME_UNMANAGED_KEY");
    expect(block).toContain('NEXT_PUBLIC_APP_NAME="FluxMedia"');
    // 按 key 字母序排序：NEXT_PUBLIC_APP_NAME 在 NEXT_PUBLIC_APP_URL 之前
    expect(block.indexOf("NEXT_PUBLIC_APP_NAME")).toBeLessThan(
      block.indexOf("NEXT_PUBLIC_APP_URL")
    );
  });

  it("drops values whose serialized line embeds the block sentinel (S-M9)", () => {
    const block = buildManagedEnvBlock([
      { key: "NEXT_PUBLIC_APP_NAME", value: `evil ${END} tail` },
      { key: "NEXT_PUBLIC_APP_NAME", value: "FluxMedia" },
    ]);

    // 含哨兵子串的值被排除，托管块仍只有一对 BEGIN/END 边界
    expect(block).not.toContain("evil");
    expect(block.match(new RegExp(END, "g"))).toHaveLength(1);
    expect(block).toContain('NEXT_PUBLIC_APP_NAME="FluxMedia"');
  });
});

describe("applyManagedEnvBlock", () => {
  it("appends managed block when none exists", () => {
    const managed = `${BEGIN}\nNEXT_PUBLIC_APP_NAME="FluxMedia"\n${END}`;
    const next = applyManagedEnvBlock("DATABASE_URL=postgres://x", managed);

    expect(next).toContain("DATABASE_URL=postgres://x");
    expect(next.endsWith(`${managed}\n`)).toBe(true);
  });

  it("replaces existing managed block in place preserving surrounding lines", () => {
    const current = `KEEP_ME=1\n${BEGIN}\nOLD="old"\n${END}\nTAIL=2`;
    const managed = `${BEGIN}\nNEXT_PUBLIC_APP_NAME="FluxMedia"\n${END}`;
    const next = applyManagedEnvBlock(current, managed);

    expect(next).toContain("KEEP_ME=1");
    expect(next).toContain("TAIL=2");
    expect(next).toContain('NEXT_PUBLIC_APP_NAME="FluxMedia"');
    expect(next).not.toContain('OLD="old"');
    // 仍只保留一对哨兵
    expect(next.match(new RegExp(END, "g"))).toHaveLength(1);
  });

  it("does not corrupt output when a value contains $& or $1 (M-M25)", () => {
    const managed = buildManagedEnvBlock([
      { key: "EPAY_KEY", value: "a$&b$1c$$d$`e" },
    ]);
    const current = `${BEGIN}\nOLD="old"\n${END}`;
    const next = applyManagedEnvBlock(current, managed);

    // String.replace 的 $ 特殊序列被函数式 replacer 规避，值逐字保留
    expect(next).toContain('EPAY_KEY="a$&b$1c$$d$`e"');
    expect(next).not.toContain('OLD="old"');
  });
});
