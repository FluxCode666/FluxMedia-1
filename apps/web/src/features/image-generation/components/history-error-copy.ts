/**
 * 历史记录安全错误的本地化映射。
 *
 * 使用方：图片/视频历史列表与详情弹层。普通用户只接收固定安全英文文案并转换为
 * 当前界面语言；管理员记录还可接收服务端已脱敏的诊断摘要。
 */

type Copy = (en: string, zh: string) => string;

/**
 * 本地化服务端白名单错误。
 *
 * @param error 历史 UOL 返回的稳定安全错误或空值。
 * @param copy 当前语言的二选一文案函数。
 * @param options 管理员是否可以显示服务端已脱敏的具体错误摘要。
 * @returns 本地化简易错误；空值保持 `null`。
 */
export function formatHistoryError(
  error: string | null,
  copy: Copy,
  options: { showAdminDetails?: boolean } = {}
): string | null {
  if (!error) return null;
  switch (error) {
    case "Prompt did not pass content safety review; modify the prompt and retry":
      return copy(
        "Prompt did not pass content safety review; modify the prompt and retry",
        "提示词未通过内容安全审核，请修改提示词后重试。"
      );
    case "Content moderation blocked this generation":
      return copy(
        "Content moderation blocked this generation",
        "内容审核阻止了本次生成"
      );
    case "Insufficient credits":
      return copy("Insufficient credits", "积分不足");
    case "Generation timed out":
      return copy("Generation timed out", "生成超时");
    case "Generation service is temporarily unavailable":
      return copy(
        "Generation service is temporarily unavailable",
        "生成服务暂时不可用"
      );
    default:
      return options.showAdminDetails
        ? error
        : copy("Generation failed", "生成失败");
  }
}
