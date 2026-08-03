/**
 * Adobe direct 成员级双 Profile 凭据健康评估器。
 *
 * 职责：在数据库事务外用同一 Cookie 验证 Express 与 Firefly，检查非访客、
 * client ID 和稳定 Adobe 账号一致性，再把不含 Cookie/Token 的整轮结果交给
 * claim/revision CAS 提交边界。使用方是后续 cron、被动检查和管理员立即检查。
 */
import {
  ADOBE_WEB_APP_PROFILES,
  decodeJwtPayload,
  type FireflyTransport,
  refreshAccessTokenFromCookie,
} from "@repo/shared/adobe/firefly-direct";

import {
  ADOBE_CREDENTIAL_PROFILES,
  type AdobeCredentialDiagnostic,
  type AdobeCredentialEvaluationOutcome,
  type AdobeCredentialFailureCategory,
  type AdobeCredentialHealthState,
  type AdobeCredentialProfile,
  classifyAdobeCredentialFailure,
  reduceAdobeCredentialHealth,
} from "./adobe-credential-health-policy";

export type AdobeCredentialProfileResult =
  | { profile: AdobeCredentialProfile; ok: true }
  | {
      profile: AdobeCredentialProfile;
      ok: false;
      category: AdobeCredentialFailureCategory;
      diagnostic: AdobeCredentialDiagnostic | null;
    };

export type AdobeCredentialProfileEvaluation = {
  outcome: AdobeCredentialEvaluationOutcome;
  profiles: AdobeCredentialProfileResult[];
};

type InternalProfileVerification =
  | {
      profile: AdobeCredentialProfile;
      ok: true;
      accountUserId: string;
    }
  | {
      profile: AdobeCredentialProfile;
      ok: false;
      kind: "member_failure" | "platform_failure";
      category: AdobeCredentialFailureCategory;
      diagnostic: AdobeCredentialDiagnostic | null;
    };

/**
 * 从 IMS Token 与 Profile 返回值提取稳定 Adobe 账号 ID。
 *
 * @param accessToken 当前 Profile 的短期 Token。
 * @param profileAccountUserId IMS profile/v1 返回的 userId。
 * @returns 一致且非 Guest 的稳定 ID；字段缺失、互相冲突或访客身份返回 null。
 */
function resolveStableAdobeAccountUserId(
  accessToken: string,
  profileAccountUserId: string | null
): string | null {
  const claims = decodeJwtPayload(accessToken);
  const tokenUserId = String(claims.user_id || claims.userId || "").trim();
  const subject = String(claims.sub || "").trim();
  const profileUserId = String(profileAccountUserId || "").trim();
  if (
    subject.toLowerCase().includes("guestid") ||
    tokenUserId.toLowerCase().includes("guestid") ||
    profileUserId.toLowerCase().includes("guestid")
  ) {
    return null;
  }
  if (tokenUserId && profileUserId && tokenUserId !== profileUserId) {
    return null;
  }
  const stableId = profileUserId || tokenUserId || subject;
  return stableId && stableId.length <= 512 ? stableId : null;
}

/**
 * 构造不包含上游原文的账号身份失败结果。
 *
 * @param profile 失败的网页 Profile。
 * @param code 可持久化的稳定内部错误码。
 * @returns 计入成员失败的一条 Profile 结果。
 */
function identityFailure(
  profile: AdobeCredentialProfile,
  code: "identity_missing" | "identity_mismatch" | "profile_client_mismatch"
): InternalProfileVerification {
  return {
    profile,
    ok: false,
    kind: "member_failure",
    category: "identity_invalid",
    diagnostic: { adobeErrorCode: code },
  };
}

/**
 * 验证一个 Adobe 网页 Profile，不把 Cookie 或短期 Token带出函数。
 *
 * @param input transport、Cookie、Profile、可选 scope/信号和代理配置状态。
 * @returns 仅稳定账号 ID 或严格分类后的安全失败。
 * @sideEffects 发起 Cookie 换 Token 和 profile/v1 请求，不写数据库或日志。
 */
async function verifyAdobeCredentialProfile(input: {
  transport: FireflyTransport;
  cookie: string;
  profile: AdobeCredentialProfile;
  scope?: string | null;
  signal?: AbortSignal;
  proxyConfigured: boolean;
}): Promise<InternalProfileVerification> {
  try {
    const result = await refreshAccessTokenFromCookie(
      input.transport,
      input.cookie,
      {
        profile: input.profile,
        ...(input.profile === "express" && input.scope
          ? { scope: input.scope }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        fetchAccount: true,
      }
    );
    const claims = decodeJwtPayload(result.accessToken);
    const expectedClientId = ADOBE_WEB_APP_PROFILES[input.profile].imsClientId;
    if (String(claims.client_id || "").trim() !== expectedClientId) {
      return identityFailure(input.profile, "profile_client_mismatch");
    }
    if (result.expiresIn !== null && result.expiresIn <= 0) {
      return {
        profile: input.profile,
        ok: false,
        kind: "member_failure",
        category: "auth_rejected",
        diagnostic: { adobeErrorCode: "expired_token" },
      };
    }
    const accountUserId = resolveStableAdobeAccountUserId(
      result.accessToken,
      result.account?.userId ?? null
    );
    if (!accountUserId) {
      return identityFailure(input.profile, "identity_missing");
    }
    return { profile: input.profile, ok: true, accountUserId };
  } catch (error) {
    const failure = classifyAdobeCredentialFailure(error, {
      proxyConfigured: input.proxyConfigured,
    });
    return { profile: input.profile, ok: false, ...failure };
  }
}

/**
 * 将内部 Profile 身份结果转换为可持久化的安全摘要。
 *
 * @param result 内部结果，成功分支包含仅供本轮比较的账号 ID。
 * @returns 不含账号 ID、Cookie 或 Token 的 Profile 结果。
 */
function toSafeProfileResult(
  result: InternalProfileVerification
): AdobeCredentialProfileResult {
  return result.ok
    ? { profile: result.profile, ok: true }
    : {
        profile: result.profile,
        ok: false,
        category: result.category,
        diagnostic: result.diagnostic,
      };
}

/**
 * 对成员执行一整轮 Express/Firefly 凭据验证。
 *
 * @param input 同一 direct 成员的 transport、Cookie、已有账号 ID 和可选 scope/信号。
 * @returns 一个成员级 outcome 与两个安全 Profile 摘要；两个 Profile 同时失败也只
 * 产生一次成员结果。平台故障优先，避免不完整评估推进成员失败计数。
 * @sideEffects 并行发起两套 IMS Token/Profile 请求，不发起图片、视频、上传或余额请求。
 */
export async function evaluateAdobeCredentialProfiles(input: {
  transport: FireflyTransport;
  cookie: string;
  expectedAccountUserId: string | null;
  scope?: string | null;
  signal?: AbortSignal;
  proxyConfigured?: boolean;
}): Promise<AdobeCredentialProfileEvaluation> {
  const proxyConfigured = input.proxyConfigured ?? true;
  let internal = await Promise.all(
    ADOBE_CREDENTIAL_PROFILES.map((profile) =>
      verifyAdobeCredentialProfile({
        transport: input.transport,
        cookie: input.cookie,
        profile,
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        proxyConfigured,
      })
    )
  );

  const successful = internal.filter(
    (result): result is Extract<InternalProfileVerification, { ok: true }> =>
      result.ok
  );
  const stableIds = new Set(successful.map((result) => result.accountUserId));
  const identityMismatch =
    stableIds.size > 1 ||
    (input.expectedAccountUserId !== null &&
      successful.some(
        (result) => result.accountUserId !== input.expectedAccountUserId
      ));
  if (identityMismatch) {
    internal = internal.map((result) =>
      result.ok ? identityFailure(result.profile, "identity_mismatch") : result
    );
  }

  const failed = internal.filter(
    (result): result is Extract<InternalProfileVerification, { ok: false }> =>
      !result.ok
  );
  const failureProfiles = failed.map((result) => result.profile);
  const diagnostic =
    failed.find((result) => result.diagnostic)?.diagnostic ?? null;
  const outcomeKind = failed.some(
    (result) => result.kind === "platform_failure"
  )
    ? "platform_failure"
    : failed.length > 0
      ? "member_failure"
      : "success";
  return {
    outcome: {
      kind: outcomeKind,
      failureProfiles,
      diagnostic,
    },
    profiles: internal.map(toSafeProfileResult),
  };
}

export type AdobeCredentialEvaluationSubmission = {
  evaluationId: string;
  memberId: string;
  memberName: string;
  expected: {
    claimToken: string;
    credentialRevision: number;
    memberEnableRevision: number;
    completedAt: Date;
  };
  startedAt: Date;
  outcome: AdobeCredentialEvaluationOutcome;
  nextState: AdobeCredentialHealthState;
};

/**
 * 执行已认领成员的一整轮外部评估，并在网络结束后调用一次 CAS 提交边界。
 *
 * @param input claim/revision 快照、当前状态、仅本函数可见的凭据、transport、时钟
 * 和事务提交回调。
 * @returns 安全评估结果、推导状态与提交回调结果。
 * @sideEffects 先执行 Adobe 网络请求，再调用一次 commit；commit 输入不含 Cookie、
 * scope、Token 或稳定账号 ID。数据库事务和 accepted/stale/discarded 判定由回调完成。
 */
export async function runClaimedAdobeCredentialHealthEvaluation<
  TCommit,
>(input: {
  claim: {
    evaluationId: string;
    claimToken: string;
    memberId: string;
    memberName: string;
    credentialRevision: number;
    memberEnableRevision: number;
  };
  credential: {
    cookie: string;
    scope: string | null;
    expectedAccountUserId: string | null;
  };
  state: AdobeCredentialHealthState;
  transport: FireflyTransport;
  signal?: AbortSignal;
  proxyConfigured?: boolean;
  now?: () => Date;
  commit: (submission: AdobeCredentialEvaluationSubmission) => Promise<TCommit>;
}): Promise<{
  evaluation: AdobeCredentialProfileEvaluation;
  nextState: AdobeCredentialHealthState;
  commitResult: TCommit;
}> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const evaluation = await evaluateAdobeCredentialProfiles({
    transport: input.transport,
    cookie: input.credential.cookie,
    expectedAccountUserId: input.credential.expectedAccountUserId,
    ...(input.credential.scope ? { scope: input.credential.scope } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.proxyConfigured !== undefined
      ? { proxyConfigured: input.proxyConfigured }
      : {}),
  });
  const completedAt = now();
  const nextState = reduceAdobeCredentialHealth({
    state: input.state,
    now: completedAt,
    outcome: evaluation.outcome,
  });
  const commitResult = await input.commit({
    evaluationId: input.claim.evaluationId,
    memberId: input.claim.memberId,
    memberName: input.claim.memberName,
    expected: {
      claimToken: input.claim.claimToken,
      credentialRevision: input.claim.credentialRevision,
      memberEnableRevision: input.claim.memberEnableRevision,
      completedAt,
    },
    startedAt,
    outcome: evaluation.outcome,
    nextState,
  });
  return { evaluation, nextState, commitResult };
}
