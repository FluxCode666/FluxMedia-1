/**
 * UOL Invoke Gateway - 操作调用网关
 *
 * 职责：作为所有操作调用的单一入口，顺序执行：
 * 1. 操作查找（registry）
 * 2. 访问控制（assertAccess）
 * 3. 输入校验（Zod safeParse）
 * 4. 幂等键结构校验（非 DB 层）
 * 5. 构建执行上下文
 * 6. 执行业务逻辑
 * 7. 错误统一映射
 *
 * 使用方：传输层（server-action / api-route / cron / webhook / MCP adapter）
 * 均通过 invokeOperation(name, input, principal) 调用。
 *
 * 关键依赖：registry.ts、access.ts、errors.ts、principal.ts、nanoid
 *
 * 设计决策：
 * - 传输无关：不感知 HTTP/RPC/进程内调用差异
 * - 错误映射：将已知领域异常（如 "Insufficient credits"）转为 OperationError
 * - 未知异常：统一包装为 internal_error，防止内部细节泄露
 */
import { isPostgresTimeoutError } from "@repo/database/pool";
import { logError } from "@repo/shared/logger";
import { nanoid } from "nanoid";
import { z } from "zod";
import { assertAccess } from "./access";
import { OperationError } from "./errors";
import type { Principal } from "./principal";
import { getOperation, isOperationBound } from "./registry";
import type { OperationContext } from "./types";

/** invokeOperation 的可选配置 */
export interface InvokeOptions {
  /**
   * 服务端权威请求标识；仅受信进程内调用可显式指定，用于同一执行链路的日志关联。
   * HTTP 传入的 X-Request-Id 必须使用 externalRequestId，不能覆盖此字段。
   */
  requestId?: string;
  /** 已校验长度的外部关联标识；仅供 operation 读取或受控持久化，不能作为审计主键。 */
  externalRequestId?: string;
  /** 可选回调集合（未来扩展 SSE / webhook 通知） */
  callbacks?: Record<string, unknown>;
}

const externalRequestIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[\x20-\x7E]+$/);

/**
 * 调用一个已注册的操作。
 *
 * 这是 UOL 的核心网关函数 - 所有传输层最终都调用此函数。
 * 完整执行链路：查找 → 鉴权 → 校验 → 幂等检查 → 执行 → 错误映射
 *
 * @param name - 操作名称（如 "credits.consume"）
 * @param rawInput - 未校验的原始输入
 * @param principal - 调用者身份
 * @param opts - 可选配置（服务端 requestId、外部关联 ID、callbacks）
 * @returns 操作输出（经 Zod output schema 类型保证）
 * @throws OperationError 任何阶段失败时
 */
export async function invokeOperation<TOutput = unknown>(
  name: string,
  rawInput: unknown,
  principal: Principal,
  opts?: InvokeOptions
): Promise<TOutput> {
  const def = getOperation(name);
  if (!def) {
    throw new OperationError(
      "not_found",
      `Unknown operation: ${name}`,
      undefined,
      404
    );
  }

  // 1. 访问控制
  assertAccess(def.access, principal);

  // 2. 输入校验���Zod safeParse 不抛异��，手动转 OperationError）
  const parseResult = def.input.safeParse(rawInput);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    }));
    throw new OperationError("validation_error", "Input validation failed", {
      issues,
    });
  }
  const input = parseResult.data;

  // 3. 幂等键结构校验（仅校验 keyField 非空，实际去重在 execute/DB 层）
  if (def.idempotency.kind === "required") {
    const keyValue = (input as Record<string, unknown>)[
      def.idempotency.keyField
    ];
    if (!keyValue || (typeof keyValue === "string" && keyValue.trim() === "")) {
      throw new OperationError(
        "validation_error",
        `Idempotency key field "${def.idempotency.keyField}" is required for operation ${name}`
      );
    }
  }

  // 4. 构建执行上下文
  const externalRequestId = opts?.externalRequestId
    ? externalRequestIdSchema.safeParse(opts.externalRequestId)
    : null;
  const ctx: OperationContext = {
    requestId: opts?.requestId ?? nanoid(),
    ...(externalRequestId?.success
      ? { externalRequestId: externalRequestId.data }
      : {}),
    callbacks: opts?.callbacks,
    assertOwnership(resource: string, ownerId: string) {
      const principalUserId =
        principal.type === "user"
          ? principal.userId
          : principal.type === "apiKey"
            ? principal.userId
            : null;
      // system Principal 始终放行
      if (principal.type === "system") return;
      if (!principalUserId || principalUserId !== ownerId) {
        throw new OperationError(
          "ownership_violation",
          `You do not own this ${resource}`,
          { resource }
        );
      }
    },
  };

  // 6. 检查操作是否已绑定真实实现（非 stub）
  if (!isOperationBound(name)) {
    throw new OperationError(
      "not_implemented",
      `Operation "${name}" is registered but not yet bound to an implementation`,
      undefined,
      501
    );
  }

  // 7. 执行业务逻辑
  try {
    const output = await def.execute(input, principal, ctx);
    const outputResult = def.output.safeParse(output);
    if (!outputResult.success) {
      logError(
        new Error("Operation output validation failed"),
        {
          source: "uol-output-validation",
          operation: name,
          issues: outputResult.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            code: issue.code,
            message: issue.message,
          })),
          outputKeys:
            output && typeof output === "object" && !Array.isArray(output)
              ? Object.keys(output)
              : [],
        }
      );
      // WHY：执行结果可能包含数据库脏值或 binding 漂移。只暴露 operation 名称，
      // 不把输出值或 Zod issues 带入外部错误，避免意外泄露业务数据。
      throw new OperationError(
        "internal_error",
        "Operation output validation failed",
        { operation: name }
      );
    }
    return outputResult.data as TOutput;
  } catch (e) {
    // OperationError 直接透传
    if (e instanceof OperationError) throw e;

    // 数据库超时只暴露稳定错误码；原始 SQL、参数与连接信息不得穿透接口层。
    if (isPostgresTimeoutError(e)) {
      throw new OperationError("timeout", "Database query timed out", {
        source: "postgres",
        retryable: true,
      });
    }

    // 将已知领域异常映射为 OperationError
    if (e instanceof Error) {
      if (
        e.message.includes("Insufficient credits") ||
        e.message.includes("insufficient_credits")
      ) {
        throw new OperationError("insufficient_credits", e.message);
      }
      if (
        e.message.includes("frozen") ||
        e.message.includes("Account is frozen")
      ) {
        throw new OperationError("account_frozen", e.message);
      }
      if (
        e.message.includes("rate limit") ||
        e.message.includes("Rate limit")
      ) {
        throw new OperationError("rate_limited", e.message);
      }
    }

    // 未知异常：包装为 internal_error 防止内部细节泄露
    logError(e, {
      source: "uol-operation-failure",
      operation: name,
    });
    throw new OperationError(
      "internal_error",
      "An unexpected error occurred",
      undefined,
      500
    );
  }
}
