/**
 * 视频创建重试的账号选择策略。
 *
 * 使用方：视频持久状态机在恢复 retrying 任务时构造统一账号池会话。
 * 关键约束：已绑定账号的重试必须粘住原账号；已切号但因容量等待而暂未获租的任务，
 * 必须排除所有已实际外呼过的账号，避免恢复时回退到已耗尽账号。
 */

/** 视频恢复时传给统一账号池的账号约束。 */
export type VideoSubmissionRetryAccountSelection = Readonly<{
  requiredMemberId?: string;
  excludedMemberIds?: readonly string[];
}>;

/**
 * 解析视频创建重试的账号约束。
 *
 * @param input 当前任务的重试阶段、已绑定账号和不可重复使用的尝试账号。
 * @returns 同账号重试的固定账号，或切号后恢复时的排除账号集合。
 * @sideEffects 无。
 * @failure 调用方必须传入已由账本校验过的账号 ID；空集合表示没有可排除账号。
 */
export function resolveVideoSubmissionRetryAccountSelection(input: {
  isSubmissionRetry: boolean;
  backendMemberId: string | null;
  attemptedMemberIds: readonly string[];
}): VideoSubmissionRetryAccountSelection {
  if (!input.isSubmissionRetry) return {};

  if (input.backendMemberId) {
    return { requiredMemberId: input.backendMemberId };
  }

  const excludedMemberIds = Array.from(new Set(input.attemptedMemberIds));
  return excludedMemberIds.length > 0 ? { excludedMemberIds } : {};
}
