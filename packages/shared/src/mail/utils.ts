/**
 * 统一邮件发送工具。
 *
 * 使用方包括认证、注册验证与工单通知；依赖 React Email 渲染器及动态邮件
 * 客户端工厂。每次真实发送都使用同一份运行时配置快照。
 */
import { render } from "@react-email/render";
import type { ReactElement } from "react";
import { getDefaultFromEmail, getEmailDeliveryClient } from "./client";

/**
 * 邮件发送工具
 *
 * 提供统一的邮件发送接口，支持开发环境模拟和生产环境发送
 */

// ============================================
// 类型定义
// ============================================

/**
 * 发送邮件参数
 */
export interface SendEmailParams {
  /** 收件人邮箱 (单个或数组) */
  to: string | string[];
  /** 邮件主题 */
  subject: string;
  /** React Email 组件 */
  react: ReactElement;
  /** 发件人地址 (可选，默认使用 DEFAULT_FROM_EMAIL) */
  from?: string;
  /** 抄送地址 */
  cc?: string | string[];
  /** 密送地址 */
  bcc?: string | string[];
  /** 回复地址 */
  replyTo?: string | string[];
  /** 强制发送 (开发环境下也发送真实邮件) */
  force?: boolean;
  /** 可选稳定幂等键；Resend 使用原生 Idempotency-Key，SMTP 写入自定义 header。 */
  idempotencyKey?: string;
}

/**
 * 邮件发送结果
 */
export interface SendEmailResult {
  /** 是否成功 */
  success: boolean;
  /** 邮件服务返回的 ID (生产环境) */
  id?: string;
  /** 错误信息 */
  error?: string;
  /** 是否为模拟发送 (开发环境) */
  simulated?: boolean;
  /** 实际使用的发送通道 */
  provider?: "smtp" | "resend";
}

// ============================================
// 工具函数
// ============================================

/**
 * 判断是否为开发环境
 */
function isDevelopment(): boolean {
  return process.env.NODE_ENV === "development";
}

/**
 * 在控制台输出邮件预览信息 (开发环境)
 */
function logEmailPreview(params: SendEmailParams, effectiveFrom: string): void {
  const recipients = Array.isArray(params.to)
    ? params.to.join(", ")
    : params.to;

  console.log(`\n${"=".repeat(60)}`);
  console.log("EMAIL PREVIEW (Development Mode)");
  console.log("=".repeat(60));
  console.log(`To:      ${recipients}`);
  console.log(`From:    ${effectiveFrom}`);
  console.log(`Subject: ${params.subject}`);
  if (params.cc) {
    console.log(
      `CC:      ${Array.isArray(params.cc) ? params.cc.join(", ") : params.cc}`
    );
  }
  if (params.bcc) {
    console.log(
      `BCC:     ${Array.isArray(params.bcc) ? params.bcc.join(", ") : params.bcc}`
    );
  }
  if (params.replyTo) {
    console.log(
      `Reply:   ${Array.isArray(params.replyTo) ? params.replyTo.join(", ") : params.replyTo}`
    );
  }
  console.log("-".repeat(60));
  console.log("Set force: true to send real email in development");
  console.log(`${"=".repeat(60)}\n`);
}

// ============================================
// 核心函数
// ============================================

/**
 * 发送邮件
 *
 * 主要特性:
 * - 开发环境默认只输出日志，不发送真实邮件
 * - 通过 force: true 可在开发环境发送真实邮件
 * - 生产环境始终发送真实邮件
 * - 完善的错误处理
 *
 * @example
 * ```ts
 * // 发送欢迎邮件
 * await sendEmail({
 *   to: "user@example.com",
 *   subject: "Welcome to FluxMedia!",
 *   react: <WelcomeEmail name="John" dashboardUrl="..." />,
 * });
 *
 * // 开发环境强制发送
 * await sendEmail({
 *   to: "user@example.com",
 *   subject: "Test Email",
 *   react: <TestEmail />,
 *   force: true,
 * });
 * ```
 */
export async function sendEmail(
  params: SendEmailParams
): Promise<SendEmailResult> {
  const {
    to,
    subject,
    react,
    from,
    cc,
    bcc,
    replyTo,
    force = false,
    idempotencyKey,
  } = params;

  // 开发环境且未强制发送 -> 模拟发送
  if (isDevelopment() && !force) {
    const effectiveFrom = from ?? (await getDefaultFromEmail());
    logEmailPreview(params, effectiveFrom);
    return {
      success: true,
      simulated: true,
    };
  }

  // 真实发送邮件
  try {
    const deliveryClient = await getEmailDeliveryClient();
    const provider = deliveryClient.provider;
    const effectiveFrom = from ?? deliveryClient.from;

    if (provider === "smtp") {
      const html = await render(react);
      const text = await render(react, { plainText: true });

      const info = await deliveryClient.transporter.sendMail({
        from: effectiveFrom,
        to,
        subject,
        html,
        text,
        ...(idempotencyKey
          ? { headers: { "X-FluxMedia-Idempotency-Key": idempotencyKey } }
          : {}),
        ...(cc ? { cc } : {}),
        ...(bcc ? { bcc } : {}),
        ...(replyTo ? { replyTo } : {}),
      });

      return {
        success: true,
        id: info.messageId,
        provider,
      };
    }

    const resend = deliveryClient.resend;
    // 构建邮件选项 (避免传递 undefined 值以满足 exactOptionalPropertyTypes)
    const emailOptions: Parameters<typeof resend.emails.send>[0] = {
      from: effectiveFrom,
      to: Array.isArray(to) ? to : [to],
      subject,
      react,
    };

    // 仅在有值时添加可选字段
    if (cc) {
      emailOptions.cc = Array.isArray(cc) ? cc : [cc];
    }
    if (bcc) {
      emailOptions.bcc = Array.isArray(bcc) ? bcc : [bcc];
    }
    if (replyTo) {
      emailOptions.replyTo = Array.isArray(replyTo) ? replyTo : [replyTo];
    }

    const { data, error } = await resend.emails.send(
      emailOptions,
      idempotencyKey ? { idempotencyKey } : undefined
    );

    if (error) {
      console.error("Failed to send email:", error);
      return {
        success: false,
        error: error.message,
      };
    }

    return {
      success: true,
      id: data?.id,
      provider,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Email sending error:", errorMessage);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * 批量发送邮件
 *
 * 向多个收件人发送相同内容的邮件
 * 每个收件人会收到独立的邮件
 *
 * @example
 * ```ts
 * const results = await sendBulkEmail({
 *   recipients: ["a@example.com", "b@example.com"],
 *   subject: "Newsletter",
 *   react: <NewsletterEmail />,
 * });
 * ```
 */
export async function sendBulkEmail(params: {
  recipients: string[];
  subject: string;
  react: ReactElement;
  from?: string;
  force?: boolean;
}): Promise<{ sent: number; failed: number; results: SendEmailResult[] }> {
  const { recipients, ...emailParams } = params;

  const results: SendEmailResult[] = [];
  let sent = 0;
  let failed = 0;

  for (const recipient of recipients) {
    const result = await sendEmail({
      to: recipient,
      ...emailParams,
    });

    results.push(result);

    if (result.success) {
      sent++;
    } else {
      failed++;
    }
  }

  return { sent, failed, results };
}
