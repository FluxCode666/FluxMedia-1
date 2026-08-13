/**
 * UOL Operations - user-auth 领域
 *
 * 职责：注册用户与认证相关的所有操作定义（用户管理、会话、注册验证、系统引导）。
 * 使用方：invoke 网关、MCP 适配器、站内 agent 通过 registry 查询并执行。
 * 关键依赖：../registry（defineOperation）、zod（schema 校验）
 *
 * 接线状态：
 * - user.bootstrap: 已接线 -> bootstrapSelfUseSuperAdmin (auth/bootstrap-super-admin)
 * - user.sendVerificationCode: 已接线 -> sendRegistrationVerificationCode (auth/registration-verification)
 * - user.verifyCode: 已接线 -> verifyRegistrationCode (auth/registration-verification)
 * - user.getMyTimeZone / user.updateMyTimeZone: 已接线 -> time-zone/server
 * - user.getCurrentSession: stub（依赖 next/headers，在 app 层绑定）
 * - user.list: 已接线 -> support/admin-user-list-service
 * - 其余 admin 操作（getDetail/ban/updateRole/create/updateProfile/setPassword/setCreditsStatus/setExternalApiKeyStatus）:
 *   stub（业务逻辑仍内联于 admin-users.ts server-action 闭包）
 */
import { z } from "zod";

import { bootstrapSelfUseSuperAdmin as bootstrapSelfUseSuperAdminService } from "../../auth/bootstrap-super-admin";
import {
  sendRegistrationVerificationCode as sendRegistrationVerificationCodeService,
  verifyRegistrationCode as verifyRegistrationCodeService,
} from "../../auth/registration-verification";
import {
  adminUserListInputSchema,
  adminUserListOutputSchema,
} from "../../support/admin-user-list-contract";
import { listAdminUsers } from "../../support/admin-user-list-service";
import { userTimeZoneSchema } from "../../time-zone";
import {
  getUserTimeZoneSettings,
  setUserTimeZone,
} from "../../time-zone/server";
import { OperationError } from "../errors";
import { defineOperation } from "../registry";

const userTimeZoneSettingsOutputSchema = z.object({
  timeZone: z.string().nullable(),
  defaultTimeZone: z.string(),
  effectiveTimeZone: z.string(),
});

export const updateMyTimeZoneInputSchema = z.object({
  timeZone: userTimeZoneSchema,
});

// ---------------------------------------------------------------------------
// 1. user.list - 列出所有用户（管理员）
// ---------------------------------------------------------------------------
export const listUsers = defineOperation({
  name: "user.list",
  domain: "user-auth",
  title: "List Users",
  description: "列出系统中的用户列表，支持分页与过滤。仅管理员可调用。",
  input: adminUserListInputSchema,
  output: adminUserListOutputSchema,
  access: { kind: "roles", roles: ["admin", "super_admin"] },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: listAdminUsers,
});

// ---------------------------------------------------------------------------
// 2. user.getDetail - 获取用户详情（管理员）
// ---------------------------------------------------------------------------
export const getUserDetail = defineOperation({
  name: "user.getDetail",
  domain: "user-auth",
  title: "Get User Detail",
  description: "获取指定用户的详细信息（含角色、积分等）。仅管理员可调用。",
  input: z.object({
    userId: z.string().min(1),
  }),
  output: z.record(z.string(), z.unknown()),
  access: { kind: "admin" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  // Bound at app level - admin-users.ts server-action logic
  execute: async () => {
    throw new Error("Not yet wired: user.getDetail");
  },
});

// ---------------------------------------------------------------------------
// 3. user.updateRole - 更新用户角色（超级管理员）
// ---------------------------------------------------------------------------
export const updateUserRole = defineOperation({
  name: "user.updateRole",
  domain: "user-auth",
  title: "Update User Role",
  description: "变更指定用户的角色。仅超级管理员可调用。破坏性操作需二次确认。",
  input: z.object({
    userId: z.string().min(1),
    role: z.enum(["user", "admin", "super_admin"]),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  access: { kind: "superAdmin" },
  readOnly: false,
  destructive: true,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  // Bound at app level - admin-users.ts server-action logic
  execute: async () => {
    throw new Error("Not yet wired: user.updateRole");
  },
});

// ---------------------------------------------------------------------------
// 4. user.ban - 封禁/解封用户（管理员）
// ---------------------------------------------------------------------------
export const banUser = defineOperation({
  name: "user.ban",
  domain: "user-auth",
  title: "Ban User",
  description:
    "封禁或解封指定用户。封禁后用户无法登录或使用服务。仅管理员可调用。",
  input: z.object({
    userId: z.string().min(1),
    banned: z.boolean(),
    reason: z.string().optional(),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  access: { kind: "admin" },
  readOnly: false,
  destructive: true,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  // Bound at app level - admin-users.ts server-action logic
  execute: async () => {
    throw new Error("Not yet wired: user.ban");
  },
});

// ---------------------------------------------------------------------------
// 5. user.setCreditsStatus - 设置用户积分状态（管理员）
// ---------------------------------------------------------------------------
export const setUserCreditsStatus = defineOperation({
  name: "user.setCreditsStatus",
  domain: "user-auth",
  title: "Set User Credits Status",
  description: "启用或禁用指定用户的积分功能。仅管理员可调用。",
  input: z.object({
    userId: z.string().min(1),
    creditsEnabled: z.boolean(),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  access: { kind: "admin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  // Bound at app level - admin-users.ts server-action logic
  execute: async () => {
    throw new Error("Not yet wired: user.setCreditsStatus");
  },
});

// ---------------------------------------------------------------------------
// 6. user.setExternalApiKeyStatus - 设置用户外部 API Key 状态（管理员）
// ---------------------------------------------------------------------------
export const setExternalApiKeyStatus = defineOperation({
  name: "user.setExternalApiKeyStatus",
  domain: "user-auth",
  title: "Set External API Key Status",
  description: "启用或禁用指定用户的外部 API Key 功能。仅管理员可调用。",
  input: z.object({
    userId: z.string().min(1),
    externalApiKeyEnabled: z.boolean(),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  access: { kind: "admin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  // Bound at app level - admin-users.ts server-action logic
  execute: async () => {
    throw new Error("Not yet wired: user.setExternalApiKeyStatus");
  },
});

// ---------------------------------------------------------------------------
// 7. user.create - 创建用户（超级管理员）
// ---------------------------------------------------------------------------
export const createUser = defineOperation({
  name: "user.create",
  domain: "user-auth",
  title: "Create User",
  description: "手动创建新用户（含邮箱、密码、角色）。仅超级管理员可调用。",
  input: z.object({
    email: z.string().email(),
    password: z.string().min(6),
    name: z.string().min(1),
    role: z.enum(["user", "admin", "super_admin"]).default("user"),
  }),
  output: z.object({
    userId: z.string(),
    success: z.boolean(),
  }),
  access: { kind: "superAdmin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  // Bound at app level - admin-users.ts server-action logic
  execute: async () => {
    throw new Error("Not yet wired: user.create");
  },
});

// ---------------------------------------------------------------------------
// 8. user.updateProfile - 更新用户资料（超级管理员）
// ---------------------------------------------------------------------------
export const updateUserProfile = defineOperation({
  name: "user.updateProfile",
  domain: "user-auth",
  title: "Update User Profile",
  description: "更新指定用户的资料信息（名称、头像等）。仅超级管理员可调用。",
  input: z.object({
    userId: z.string().min(1),
    name: z.string().min(1).optional(),
    image: z.string().url().optional(),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  access: { kind: "superAdmin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  // Bound at app level - admin-users.ts server-action logic
  execute: async () => {
    throw new Error("Not yet wired: user.updateProfile");
  },
});

// ---------------------------------------------------------------------------
// 9. user.setPassword - 设置用户密码（超级管理员）
// ---------------------------------------------------------------------------
export const setUserPassword = defineOperation({
  name: "user.setPassword",
  domain: "user-auth",
  title: "Set User Password",
  description: "重置指定用户的密码。仅超级管理员可调用。破坏性操作。",
  input: z.object({
    userId: z.string().min(1),
    newPassword: z.string().min(6),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  access: { kind: "superAdmin" },
  readOnly: false,
  destructive: true,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  // Bound at app level - admin-users.ts server-action logic
  execute: async () => {
    throw new Error("Not yet wired: user.setPassword");
  },
});

// ---------------------------------------------------------------------------
// 10. user.getCurrentSession - 获取当前会话（公开，通过 cookie 鉴权）
// ---------------------------------------------------------------------------
export const getCurrentSession = defineOperation({
  name: "user.getCurrentSession",
  domain: "user-auth",
  title: "Get Current Session",
  description: "获取当前登录用户的会话信息。公开接口，通过 cookie 识别身份。",
  input: z.object({}),
  output: z.object({
    user: z.record(z.string(), z.unknown()).nullable(),
    session: z.record(z.string(), z.unknown()).nullable(),
  }),
  access: { kind: "public" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  // Bound at app level - depends on next/headers for cookie-based session
  execute: async () => {
    throw new Error("Not yet wired: user.getCurrentSession");
  },
});

// ---------------------------------------------------------------------------
// 12. user.sendVerificationCode - 发送注册验证码（公开）
// ---------------------------------------------------------------------------
export const sendRegistrationVerificationCode = defineOperation({
  name: "user.sendVerificationCode",
  domain: "user-auth",
  title: "Send Registration Verification Code",
  description: "向指定邮箱发送注册验证码。公开接口，受频率限制。",
  input: z.object({
    email: z.string().email(),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  access: { kind: "public" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["email"],
  execute: async (input) => {
    await sendRegistrationVerificationCodeService(input.email);
    return { success: true };
  },
});

// ---------------------------------------------------------------------------
// 13. user.verifyCode - 验证注册验证码（公开）
// ---------------------------------------------------------------------------
export const verifyRegistrationCode = defineOperation({
  name: "user.verifyCode",
  domain: "user-auth",
  title: "Verify Registration Code",
  description: "验证注册验证码是否正确。公开接口。",
  input: z.object({
    email: z.string().email(),
    code: z.string().min(1),
  }),
  output: z.object({
    valid: z.boolean(),
  }),
  access: { kind: "public" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input) => {
    const valid = await verifyRegistrationCodeService(input.email, input.code);
    return { valid };
  },
});

// ---------------------------------------------------------------------------
// 14. user.bootstrap - 引导超级管理员（仅系统内部，永远不可外部暴露）
// ---------------------------------------------------------------------------
export const bootstrapSelfUseSuperAdmin = defineOperation({
  name: "user.bootstrap",
  domain: "user-auth",
  title: "Bootstrap Self-Use Super Admin",
  description:
    "系统初始化时创建首个超级管理员。仅系统内部调用，永远不可通过任何外部传输暴露。",
  input: z.object({}),
  output: z.object({
    userId: z.string(),
    success: z.boolean(),
  }),
  access: { kind: "system" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  processLocalState: true,
  hasMaintenanceWrite: true,
  execute: async () => {
    // 服务内部从环境变量读取凭据，避免任何调用方传入或记录明文密码。
    await bootstrapSelfUseSuperAdminService();
    // 服务不返回 userId（void）；此处返回占位值，
    // 调用方应通过 user.list 或 DB 查实际创建结果。
    return { userId: "bootstrapped", success: true };
  },
});

// ---------------------------------------------------------------------------
// 15. user.getMyTimeZone - 获取本人展示时区
// ---------------------------------------------------------------------------
export const getMyTimeZone = defineOperation({
  name: "user.getMyTimeZone",
  domain: "user-auth",
  title: "Get My Time Zone",
  description:
    "获取当前登录用户的时区偏好、部署环境默认时区与最终生效展示时区。",
  input: z.object({}),
  output: userTimeZoneSettingsOutputSchema,
  access: { kind: "user" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (_input, principal) => {
    if (principal.type !== "user") {
      throw new OperationError(
        "unauthenticated",
        "User session authentication required"
      );
    }
    return getUserTimeZoneSettings(principal.userId);
  },
});

// ---------------------------------------------------------------------------
// 16. user.updateMyTimeZone - 更新本人展示时区
// ---------------------------------------------------------------------------
export const updateMyTimeZone = defineOperation({
  name: "user.updateMyTimeZone",
  domain: "user-auth",
  title: "Update My Time Zone",
  description:
    "保存当前登录用户的 IANA 展示时区；传 null 时恢复继承部署环境 APP_TIME_ZONE。",
  input: updateMyTimeZoneInputSchema,
  output: userTimeZoneSettingsOutputSchema,
  access: { kind: "user" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input, principal) => {
    if (principal.type !== "user") {
      throw new OperationError(
        "unauthenticated",
        "User session authentication required"
      );
    }
    const timeZone = await setUserTimeZone(principal.userId, input.timeZone);
    const settings = await getUserTimeZoneSettings(principal.userId);
    return { ...settings, timeZone };
  },
});
