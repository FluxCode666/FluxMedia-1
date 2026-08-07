import { db, user as userTable } from "@repo/database";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { eq } from "drizzle-orm";
import { logError } from "../logger";
import {
  createReferralRelationshipFromCode,
  readReferralCodeFromAuthContext,
} from "../referrals";
import {
  getAllowedRegistrationEmailMessage,
  isAllowedRegistrationEmail,
  normalizeEmail,
} from "./email-domain";
import {
  isRegistrationEmailTaken,
  markRegistrationIdentityDeleted,
  recordRegistrationIdentity,
} from "./registration-identity";
import { verifyRegistrationCode } from "./registration-verification";
import { isSelfUseModeEnabled } from "./self-use-mode";

function isPublicRegistrationPath(path?: string) {
  return (
    path === "/sign-up/email" ||
    path === "/sign-in/social" ||
    Boolean(path?.startsWith("/callback/"))
  );
}

async function assertRegistrationOpen() {
  if (await isSelfUseModeEnabled()) {
    throw new APIError("FORBIDDEN", {
      message: "Registration is disabled in self-use mode",
      code: "REGISTRATION_DISABLED",
    });
  }
}

function assertAllowedRegistrationEmail(email: string) {
  if (!isAllowedRegistrationEmail(email)) {
    throw new APIError("BAD_REQUEST", {
      message: getAllowedRegistrationEmailMessage(),
      code: "EMAIL_DOMAIN_NOT_ALLOWED",
    });
  }
}

async function assertEmailNotRegistered(email: string) {
  const normalizedEmail = normalizeEmail(email);

  if (await isRegistrationEmailTaken(normalizedEmail)) {
    throw new APIError("BAD_REQUEST", {
      message: "Email already registered",
      code: "EMAIL_ALREADY_REGISTERED",
    });
  }
}

async function assertUserCanAuthenticate(userId: string) {
  const [existingUser] = await db
    .select({
      id: userTable.id,
      banned: userTable.banned,
      bannedReason: userTable.bannedReason,
    })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);

  if (!existingUser?.banned) return;

  // 任意 banned=true 都拒绝创建会话/账户，不再只拦 account_deleted。
  // 否则管理员的普通封禁（banUserAction 写入的 banned=true + 普通原因）在 Web 通道形同摆设，
  // 被封用户重新登录即可创建新会话照常调用受保护操作（生图/扣费/工单/设置）。
  if (existingUser.bannedReason === "account_deleted") {
    throw new APIError("FORBIDDEN", {
      message: "Account has been deleted",
      code: "ACCOUNT_DELETED",
    });
  }

  throw new APIError("FORBIDDEN", {
    message: "Account has been banned",
    code: "ACCOUNT_BANNED",
  });
}

export const registrationVerificationPlugin = (): BetterAuthPlugin => ({
  id: "registration-verification",
  hooks: {
    before: [
      {
        matcher: (context) => context.path === "/sign-up/email",
        handler: createAuthMiddleware(async (ctx) => {
          await assertRegistrationOpen();

          const email =
            typeof ctx.body.email === "string" ? ctx.body.email : "";
          const verificationCode =
            typeof ctx.body.verificationCode === "string"
              ? ctx.body.verificationCode
              : "";
          const normalizedEmail = normalizeEmail(email);

          assertAllowedRegistrationEmail(normalizedEmail);
          await assertEmailNotRegistered(normalizedEmail);

          if (!verificationCode) {
            throw new APIError("BAD_REQUEST", {
              message: "Verification code is required",
              code: "VERIFICATION_CODE_REQUIRED",
            });
          }

          const valid = await verifyRegistrationCode(
            normalizedEmail,
            verificationCode
          );

          if (!valid) {
            throw new APIError("BAD_REQUEST", {
              message: "Invalid or expired verification code",
              code: "INVALID_VERIFICATION_CODE",
            });
          }

          delete ctx.body.verificationCode;
          ctx.body.email = normalizedEmail;
          ctx.body.emailVerified = true;
        }),
      },
    ],
  },
  init: () => ({
    options: {
      databaseHooks: {
        user: {
          create: {
            before: async (user, context) => {
              if (isPublicRegistrationPath(context?.path)) {
                await assertRegistrationOpen();
              }

              const normalizedEmail = normalizeEmail(user.email);

              assertAllowedRegistrationEmail(normalizedEmail);
              await assertEmailNotRegistered(normalizedEmail);

              if (context?.path === "/sign-up/email") {
                return {
                  data: {
                    ...user,
                    email: normalizedEmail,
                    emailVerified: true,
                  },
                };
              }

              return {
                data: {
                  ...user,
                  email: normalizedEmail,
                },
              };
            },
            after: async (user, context) => {
              await recordRegistrationIdentity(user.email, user.id);
              // 推广归因只读取服务端请求上下文，客户端不能直接指定 inviterUserId。
              // 无效码、自邀请和重复归因均安全忽略，不阻断注册主流程。
              try {
                const referralCode = readReferralCodeFromAuthContext(context);
                if (!referralCode) return;
                await createReferralRelationshipFromCode(user.id, referralCode);
              } catch (error) {
                // Better Auth 已完成用户写入；归因失败不能让注册客户端误判失败，
                // 但必须保留结构化日志，供运营按用户 ID 做补偿处理。
                logError(error, {
                  source: "referral-attribution",
                  stage: "registration-after-hook",
                  userId: user.id,
                });
              }
            },
          },
          delete: {
            after: async (user) => {
              await markRegistrationIdentityDeleted(user.email, user.id);
            },
          },
        },
        account: {
          create: {
            before: async (account) => {
              await assertUserCanAuthenticate(account.userId);
              return { data: account };
            },
          },
        },
        session: {
          create: {
            before: async (session) => {
              await assertUserCanAuthenticate(session.userId);
              return { data: session };
            },
          },
        },
      },
    },
  }),
});
