/** Referral attribution and rewards are persisted and settled atomically by Go. */
import { requestGoBackendInternalJson } from "../http/go-backend";
import type { ReferralRewardConfig } from "./config";
import { normalizeReferralCode } from "./contract";
import { REFERRAL_CODE_COOKIE } from "./cookie";
import type {
  ReferralRelationshipListInput,
  ReferralRelationshipListOutput,
} from "./relationship-contract";

/** 从原始 Cookie 请求头读取单个值；解析失败时返回空值。 */
function readCookieValue(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;
  const item = cookieHeader.split(";").find((part) => {
    const [key] = part.trim().split("=");
    return key === name;
  });
  if (!item) return null;
  const [, ...value] = item.trim().split("=");
  try {
    return decodeURIComponent(value.join("="));
  } catch {
    return null;
  }
}

/** 从 Better Auth 创建请求中提取显式字段或推广 cookie。 */
export function readReferralCodeFromAuthContext(
  context:
    | {
        body?: unknown;
        request?: Request | undefined;
      }
    | null
    | undefined
) {
  const body =
    context?.body && typeof context.body === "object"
      ? (context.body as Record<string, unknown>)
      : null;
  const explicit = normalizeReferralCode(body?.referralCode);
  if (explicit) return explicit;
  return normalizeReferralCode(
    readCookieValue(
      context?.request?.headers.get("cookie") ?? null,
      REFERRAL_CODE_COOKIE
    )
  );
}
export type ReferralDashboard = {
  code: string;
  inviteUrl: string;
  invitedCount: number;
  rewardedCount: number;
  totalRewardCredits: number;
  rewardConfig: ReferralRewardConfig;
};
type ReferralProfile = {
  userId: string;
  code: string;
  createdAt: Date;
  updatedAt: Date;
};
type ReferralLinkResult =
  | { linked: true; relationshipId: string }
  | {
      linked: false;
      reason: "invalid_code" | "invalid_or_self" | "already_linked";
    };
type ReferralFulfillmentResult =
  | {
      rewarded: true;
      inviterRewardCredits: number;
      inviteeRewardCredits: number;
    }
  | { rewarded: false; reason: "no_referral" | "already_used" | "disabled" };

export async function ensureReferralProfile(userId: string): Promise<ReferralProfile> {
  const raw = await requestGoBackendInternalJson<
    Omit<ReferralProfile, "createdAt" | "updatedAt"> & {
      createdAt: string;
      updatedAt: string;
    }
  >("/api/internal/referrals/profile", {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
  return {
    ...raw,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
  };
}

export async function createReferralRelationshipFromCode(
  inviteeUserId: string,
  rawCode: unknown
): Promise<ReferralLinkResult> {
  const code = normalizeReferralCode(rawCode);
  if (!code) return { linked: false, reason: "invalid_code" };
  return requestGoBackendInternalJson<ReferralLinkResult>("/api/internal/referrals/link", {
    method: "POST",
    body: JSON.stringify({ inviteeUserId, code }),
  });
}

export async function getReferralDashboard(input: {
  userId: string;
  appUrl: string;
}): Promise<ReferralDashboard> {
  const result = await requestGoBackendInternalJson<ReferralDashboard>("/api/internal/referrals/dashboard", {
    method: "POST",
    body: JSON.stringify({ userId: input.userId }),
  });
  return { ...result, inviteUrl: `${input.appUrl.replace(/\/$/u, "")}/r/${result.code}` };
}

export async function listReferralRelationships(
  userId: string,
  _input: ReferralRelationshipListInput
): Promise<ReferralRelationshipListOutput> {
  return requestGoBackendInternalJson<ReferralRelationshipListOutput>("/api/internal/referrals/relationships", {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

export async function fulfillReferralFirstPayment(input: {
  orderId: string;
  inviteeUserId: string;
  firstPaymentCredits: number;
  paymentProvider: "alipay" | "alipay_f2f" | "epay" | "creem";
}): Promise<ReferralFulfillmentResult> {
  return requestGoBackendInternalJson<ReferralFulfillmentResult>("/api/internal/referrals/fulfill-first-payment", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
