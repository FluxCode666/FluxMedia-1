/** 历史记录错误本地化测试，锁定普通用户降级与管理员摘要展示边界。 */

import { describe, expect, it } from "vitest";
import { formatHistoryError } from "./history-error-copy";

const zhCopy = (_en: string, zh: string) => zh;

describe("formatHistoryError", () => {
  it("本地化稳定错误", () => {
    expect(formatHistoryError("Generation timed out", zhCopy)).toBe("生成超时");
    expect(
      formatHistoryError(
        "Prompt did not pass content safety review; modify the prompt and retry",
        zhCopy
      )
    ).toBe("提示词未通过内容安全审核，请修改提示词后重试。");
  });

  it("未知文本降级为通用失败且不透传", () => {
    expect(formatHistoryError("Failed query: select secret", zhCopy)).toBe(
      "生成失败"
    );
  });

  it("管理员模式展示服务端已经脱敏的错误摘要", () => {
    expect(
      formatHistoryError("Gemini 视频上游返回 HTTP 429", zhCopy, {
        showAdminDetails: true,
      })
    ).toBe("Gemini 视频上游返回 HTTP 429");
  });

  it("空错误保持为空", () => {
    expect(formatHistoryError(null, zhCopy)).toBeNull();
  });
});
