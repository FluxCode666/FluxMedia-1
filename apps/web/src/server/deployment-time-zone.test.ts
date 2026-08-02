/**
 * 部署时区不变量的 DB-free 回归测试。
 *
 * PostgreSQL 的 `timestamp without time zone` 在 Node 端会按进程 `TZ` 解析；因此运行时
 * 必须固定为 UTC，而 `APP_TIME_ZONE` 仅控制面向用户的展示。测试同时约束本地与 Compose
 * 示例，避免把两者都配置成北京时间后让所有数据库时间提前 8 小时。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd(), "../..");
const composeSource = readFileSync(
  resolve(repositoryRoot, "deploy/docker-compose.yml"),
  "utf8"
);
const rootEnvExample = readFileSync(
  resolve(repositoryRoot, ".env.example"),
  "utf8"
);
const deployEnvExample = readFileSync(
  resolve(repositoryRoot, "deploy/.env.example"),
  "utf8"
);

/**
 * 从 Compose 源码中截取一个顶层 service，供部署契约断言使用。
 *
 * @param serviceName 两空格缩进的服务名。
 * @returns 对应服务源码；服务不存在时返回空字符串，让断言给出明确差异。
 */
function readComposeService(serviceName: string): string {
  const lines = composeSource.split("\n");
  const start = lines.indexOf(`  ${serviceName}:`);
  if (start < 0) return "";
  const nextServiceOffset = lines
    .slice(start + 1)
    .findIndex((line) => /^ {2}[A-Za-z0-9_-]+:$/.test(line));
  const end =
    nextServiceOffset < 0 ? lines.length : start + nextServiceOffset + 1;
  return lines.slice(start, end).join("\n");
}

/**
 * 读取示例 env 中单个未加引号的值。
 *
 * @param source env 文件文本。
 * @param key 变量名。
 * @returns 首个匹配值；缺失时返回 undefined。
 */
function readEnvExampleValue(source: string, key: string): string | undefined {
  return source
    .split("\n")
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1);
}

describe("deployment time-zone contract", () => {
  it("keeps Node and migration processes in UTC", () => {
    expect(readComposeService("migrate")).toContain("      TZ: UTC");
    expect(readComposeService("web")).toContain("      TZ: UTC");
    expect(readEnvExampleValue(rootEnvExample, "TZ")).toBe("UTC");
    expect(readEnvExampleValue(deployEnvExample, "TZ")).toBe("UTC");
  });

  it("uses Asia/Shanghai only as the default display time zone", () => {
    expect(readComposeService("web")).toContain(
      `      APP_TIME_ZONE: \${APP_TIME_ZONE:-Asia/Shanghai}`
    );
    expect(readEnvExampleValue(rootEnvExample, "APP_TIME_ZONE")).toBe(
      "Asia/Shanghai"
    );
    expect(readEnvExampleValue(deployEnvExample, "APP_TIME_ZONE")).toBe(
      "Asia/Shanghai"
    );
  });
});
