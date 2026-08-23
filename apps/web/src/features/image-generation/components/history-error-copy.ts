/**
 * 历史记录安全错误的本地化映射。
 *
 * 使用方：图片/视频历史列表与详情弹层。服务端先把错误收敛为固定安全文案或脱敏
 * 诊断摘要，本模块再把固定文案转换为当前界面语言。
 */

type Copy = (en: string, zh: string) => string;

/**
 * 本地化服务端安全错误。
 *
 * @param error 历史 UOL 返回的安全错误文案或已脱敏诊断摘要。
 * @param copy 当前语言的二选一文案函数。
 * @param options 是否显示服务端已脱敏的具体错误摘要；关闭时回退到通用文案。
 * @returns 当前语言的错误展示文案；空值保持 `null`。
 */
export function formatHistoryError(
  error: string | null,
  copy: Copy,
  options: { showDetails?: boolean } = {}
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
      return options.showDetails !== false
        ? error
        : copy("Generation failed", "生成失败");
  }
}
