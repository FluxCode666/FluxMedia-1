/**
 * 站内 API 上游适配管理员文档契约测试。
 *
 * 使用方：Vitest；锁定六操作、脚本返回语义、容量估算和图片跨重启风险说明，避免
 * 运行时演进后管理员页面继续展示过期契约。
 */

import { describe, expect, it } from "vitest";

import { getApiUpstreamAdapterDocsContent } from "./api-upstream-adapter-docs";

const EXPECTED_OPERATIONS = [
  "images.generate",
  "images.generate.query",
  "images.edit",
  "images.edit.query",
  "videos.generate",
  "videos.query",
] as const;

describe("API upstream adapter admin docs", () => {
  it.each(["zh", "en"])("%s 覆盖六操作和部分请求信封语义", (locale) => {
    const content = getApiUpstreamAdapterDocsContent(locale);
    expect(content.operationRows.map(([operation]) => operation)).toEqual(
      EXPECTED_OPERATIONS
    );
    expect(content.requestInput).toMatch(/headers/u);
    expect(content.requestInput).toMatch(/省略|Omit/u);
    expect(content.requestInput).toMatch(/return/u);
    expect(content.responseInput).toContain("pollAfterSeconds");
    expect(content.responseInput).toContain("5");
  });

  it.each(["zh", "en"])("%s 明确媒体、跨重启和容量边界", (locale) => {
    const content = getApiUpstreamAdapterDocsContent(locale);
    const safety = content.safetyItems.join("\n");
    expect(safety).toMatch(/首尾帧|First\/last frames/u);
    expect(safety).toMatch(/参考图|reference images/u);
    expect(safety).toMatch(/进程崩溃|process crash/u);
    expect(safety).toMatch(/孤儿任务|orphan tasks/u);
    expect(safety).toContain("api_upstream_image_task_orphan_risk");
    expect(content.capacityRows).toEqual([
      [
        locale === "zh" ? "1（默认）" : "1 (default)",
        "1",
        "20 jobs/s",
        "10 cycles/s",
      ],
      ["2", "2", "40 jobs/s", "20 cycles/s"],
      ["4", "4", "80 jobs/s", "40 cycles/s"],
      [
        locale === "zh" ? "8（上限）" : "8 (maximum)",
        "8",
        "160 jobs/s",
        "80 cycles/s",
      ],
    ]);
  });
});
