/**
 * 浏览器端 Action 构建器。
 *
 * 使用方：features 与 shared 下的 actions 模块。保留原 next-safe-action 的
 * `.metadata().schema().action()` 写法和 `{ data, serverError, validationErrors }` 返回结构；
 * 会话与角色检查只用于前端尽早给出提示，真正的鉴权由 Go 端点负责。
 */
import type { z } from "zod";

import { getServerSession } from "./auth/server";
import {
  type AppUserRole,
  canAccessAdminArea,
  canManageUserPermissions,
  canViewGlobalUsageRecords,
  canViewImageBackendPool,
  normalizeUserRole,
} from "./auth/roles";
import { GoBackendHttpError } from "./http/go-backend";
import { logError } from "./logger/index";
import { captureError } from "./monitoring/index";
import { NotFoundSignal, RedirectSignal } from "./platform/navigation";

type ActionMetadata = { action: string };

/** 与 next-safe-action formatted 形态一致的校验错误树。 */
export type ValidationErrorTree = {
  _errors?: string[];
  [key: string]: ValidationErrorTree | string[] | undefined;
};

export type SafeActionResult<Data> = {
  data?: Data;
  serverError?: string;
  validationErrors?: ValidationErrorTree;
};

type AnySchema = z.ZodType;

type SafeAction<S extends AnySchema | undefined, Data> = S extends AnySchema
  ? undefined extends z.input<S>
    ? (input?: z.input<S>) => Promise<SafeActionResult<Data>>
    : (input: z.input<S>) => Promise<SafeActionResult<Data>>
  : () => Promise<SafeActionResult<Data>>;

type ActionHandler<Ctx, S extends AnySchema | undefined, Data> = (args: {
  parsedInput: S extends AnySchema ? z.output<S> : undefined;
  ctx: Ctx;
  metadata: ActionMetadata | undefined;
}) => Promise<Data> | Data;

class ActionAuthError extends Error {
  constructor() {
    super("登录已失效，请重新登录");
    this.name = "ActionAuthError";
  }
}

class ActionBannedError extends Error {
  constructor() {
    super("账号已被封禁");
    this.name = "ActionBannedError";
  }
}

class ActionPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionPermissionError";
  }
}

/**
 * 面向用户的已知错误:用于校验类/可预期失败(如积分包未配置、余额不足),其 message 即便在生产环境
 * 也原样回传前端展示,而不是被统一替换成"服务器错误"。仅放可安全展示给用户的提示,勿带内部细节。
 */
export class ActionUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionUserError";
  }
}

/** 把未预期异常转换为可展示文案；Go 返回的 4xx 文案是面向用户的业务提示，原样透出。 */
function toServerError(error: unknown, metadata: ActionMetadata | undefined): string {
  if (
    error instanceof ActionAuthError ||
    error instanceof ActionBannedError ||
    error instanceof ActionPermissionError ||
    error instanceof ActionUserError
  ) {
    return error.message;
  }
  if (error instanceof GoBackendHttpError && error.status < 500) return error.message;
  const context = { source: "action", action: metadata?.action ?? "action" };
  logError(error, context);
  captureError(error, context);
  if (error instanceof TypeError) return "网络请求失败，请稍后重试";
  if (process.env.NODE_ENV === "production") return "服务器错误，请稍后重试";
  return error instanceof Error ? error.message : String(error);
}

/** 按 zod issue 路径构建嵌套错误树。 */
function formatValidationErrors(issues: readonly z.core.$ZodIssue[]): ValidationErrorTree {
  const root: ValidationErrorTree = {};
  for (const issue of issues) {
    let node = root;
    for (const segment of issue.path) {
      const key = String(segment);
      const child = node[key];
      if (child && !Array.isArray(child)) {
        node = child;
      } else {
        const next: ValidationErrorTree = {};
        node[key] = next;
        node = next;
      }
    }
    node._errors = [...(node._errors ?? []), issue.message];
  }
  return root;
}

type BuilderConfig<Ctx, S extends AnySchema | undefined> = {
  resolveCtx: () => Promise<Ctx>;
  metadata?: ActionMetadata;
  schema?: S;
};

class ActionBuilder<Ctx, S extends AnySchema | undefined = undefined> {
  constructor(private readonly config: BuilderConfig<Ctx, S>) {}

  /** 在现有上下文上叠加检查或派生字段；抛错即中止 Action。 */
  use<Next>(middleware: (args: { ctx: Ctx }) => Promise<Next>): ActionBuilder<Next, S> {
    const resolveCtx = this.config.resolveCtx;
    return new ActionBuilder<Next, S>({
      ...this.config,
      resolveCtx: async () => middleware({ ctx: await resolveCtx() }),
    });
  }

  metadata(metadata: ActionMetadata): ActionBuilder<Ctx, S> {
    return new ActionBuilder<Ctx, S>({ ...this.config, metadata });
  }

  schema<Next extends AnySchema>(schema: Next): ActionBuilder<Ctx, Next> {
    return new ActionBuilder<Ctx, Next>({ ...this.config, schema });
  }

  inputSchema<Next extends AnySchema>(schema: Next): ActionBuilder<Ctx, Next> {
    return this.schema(schema);
  }

  action<Data>(handler: ActionHandler<Ctx, S, Data>): SafeAction<S, Data> {
    const { resolveCtx, metadata, schema } = this.config;
    const run = async (input?: unknown): Promise<SafeActionResult<Data>> => {
      try {
        let parsedInput: unknown;
        if (schema) {
          const parsed = await schema.safeParseAsync(input);
          if (!parsed.success) {
            return { validationErrors: formatValidationErrors(parsed.error.issues) };
          }
          parsedInput = parsed.data;
        }
        const ctx = await resolveCtx();
        const data = await handler({
          parsedInput: parsedInput as S extends AnySchema ? z.output<S> : undefined,
          ctx,
          metadata,
        });
        return { data };
      } catch (error) {
        // 跳转与 404 信号交给路由运行时处理，不当作 Action 失败。
        if (error instanceof RedirectSignal || error instanceof NotFoundSignal) throw error;
        return { serverError: toServerError(error, metadata) };
      }
    };
    return run as SafeAction<S, Data>;
  }
}

/**
 * 基础 Action 客户端
 *
 * 用于不需要登录的 Action。
 */
export const actionClient = new ActionBuilder<Record<never, never>>({
  resolveCtx: async () => ({}),
});

type ProtectedCtx = {
  userId: string;
  user: NonNullable<Awaited<ReturnType<typeof getServerSession>>>["user"];
  role: AppUserRole;
};

/**
 * 受保护的 Action 客户端
 *
 * 读取当前会话并把用户信息放入 ctx；未登录或已封禁时直接返回错误。
 */
export const protectedAction = actionClient.use(async (): Promise<ProtectedCtx> => {
  const session = await getServerSession();
  if (!session?.user) throw new ActionAuthError();
  if (session.user.banned) throw new ActionBannedError();
  return {
    userId: session.user.id,
    user: session.user,
    role: normalizeUserRole(session.user.role),
  };
});

/**
 * 管理员 Action 客户端
 */
export const adminAction = protectedAction.use(async ({ ctx }) => {
  if (!canAccessAdminArea(ctx.role)) throw new ActionPermissionError("此操作需要管理员权限");
  return { ...ctx, isAdmin: true as const };
});

export const superAdminAction = protectedAction.use(async ({ ctx }) => {
  if (!canManageUserPermissions(ctx.role)) throw new ActionPermissionError("此操作需要超管权限");
  return { ...ctx, isAdmin: true as const, isSuperAdmin: true as const };
});

export const imageBackendPoolViewerAction = protectedAction.use(async ({ ctx }) => {
  if (!canViewImageBackendPool(ctx.role)) throw new ActionPermissionError("此操作需要账号池查看权限");
  return { ...ctx, canViewImageBackendPool: true as const };
});

/** 为现有三档管理员提供只读全局使用记录 Action 边界。 */
export const globalUsageRecordsViewerAction = protectedAction.use(async ({ ctx }) => {
  if (!canViewGlobalUsageRecords(ctx.role)) {
    throw new ActionPermissionError("此操作需要全局使用记录查看权限");
  }
  return { ...ctx, canViewGlobalUsageRecords: true as const };
});
