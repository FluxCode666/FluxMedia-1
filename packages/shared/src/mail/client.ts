/**
 * 邮件运行时配置与客户端工厂。
 *
 * 使用方是统一邮件发送工具；依赖系统设置运行时读取器、Nodemailer 与 Resend。
 * 配置每次按当前快照解析，客户端仅在凭据指纹未变化时复用，避免后台改动后
 * 继续使用进程启动时的旧凭据。
 */
import { createHash } from "node:crypto";

import type { Transporter } from "nodemailer";
import { createTransport } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { Resend } from "resend";

import {
  getRuntimeSettingBoolean,
  getRuntimeSettingString,
} from "../system-settings";

export type EmailProvider = "smtp" | "resend";

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

interface EmailRuntimeConfig {
  provider: EmailProvider;
  from: string;
  smtp: SmtpConfig | null;
  resendApiKey: string | undefined;
}

interface FingerprintedClient<T> {
  fingerprint: string;
  client: T;
}

export type EmailDeliveryClient =
  | {
      provider: "smtp";
      from: string;
      transporter: Transporter<SMTPTransport.SentMessageInfo>;
    }
  | {
      provider: "resend";
      from: string;
      resend: Resend;
    };

/** 当前邮件配置的非机密可用性快照。 */
export type EmailDeliveryConfigurationSnapshot = {
  configured: boolean;
  provider: EmailProvider;
  from: string;
  /** 只用于 outbox 配置 revision，不可逆且不包含凭据明文。 */
  configurationFingerprint: string;
};

/** 未配置发件人时使用的安全默认值。 */
export const DEFAULT_FROM_EMAIL = "FluxMedia <support@media.flux-code.cc>";

let resendClientCache: FingerprintedClient<Resend> | undefined;
let smtpTransporterCache:
  | FingerprintedClient<Transporter<SMTPTransport.SentMessageInfo>>
  | undefined;

/**
 * 解析 SMTP 端口。
 *
 * @param value 系统设置或环境变量中的原始文本。
 * @returns 合法端口；缺失或越界时返回 465。
 */
function parseSmtpPort(value: string | undefined): number {
  if (!value) return 465;

  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 465;
}

/**
 * 为客户端有效配置生成不可逆指纹。
 *
 * @param values 会影响客户端连接行为的配置值。
 * @returns SHA-256 指纹；不会把密码或 API Key 写入缓存键、日志或错误。
 */
function createConfigFingerprint(
  values: ReadonlyArray<string | number | boolean>
): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

/**
 * 计算邮件配置的非机密 revision。
 *
 * @param config 当前运行时配置。
 * @returns 供持久 outbox 比较的 SHA-256 指纹；不会记录输入值。
 */
function getEmailConfigurationFingerprint(config: EmailRuntimeConfig): string {
  return createConfigFingerprint([
    config.provider,
    config.from,
    config.smtp?.host ?? "",
    config.smtp?.port ?? 0,
    config.smtp?.secure ?? false,
    config.smtp?.user ?? "",
    config.smtp?.pass ?? "",
    config.resendApiKey ?? "",
  ]);
}

/**
 * 读取一份内部一致的邮件运行时配置快照。
 *
 * @returns 当前 provider、发件人和两种通道凭据。
 * @remarks 系统设置读取失败时显式上抛；不会回退到旧客户端配置。
 */
async function getEmailRuntimeConfig(): Promise<EmailRuntimeConfig> {
  const [
    configuredProvider,
    from,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    resendApiKey,
  ] = await Promise.all([
    getRuntimeSettingString("EMAIL_PROVIDER"),
    getRuntimeSettingString("EMAIL_FROM"),
    getRuntimeSettingString("SMTP_HOST"),
    getRuntimeSettingString("SMTP_PORT"),
    getRuntimeSettingString("SMTP_USER"),
    getRuntimeSettingString("SMTP_PASS"),
    getRuntimeSettingString("RESEND_API_KEY"),
  ]);

  const port = parseSmtpPort(smtpPort);
  const secure = await getRuntimeSettingBoolean("SMTP_SECURE", port === 465);
  const smtp =
    smtpHost && smtpUser && smtpPass
      ? {
          host: smtpHost,
          port,
          secure,
          user: smtpUser,
          pass: smtpPass,
        }
      : null;
  const normalizedProvider = configuredProvider?.toLowerCase();
  const provider =
    normalizedProvider === "smtp" || normalizedProvider === "resend"
      ? normalizedProvider
      : smtp
        ? "smtp"
        : "resend";

  return {
    provider,
    from: from ?? DEFAULT_FROM_EMAIL,
    smtp,
    resendApiKey,
  };
}

/**
 * 按 API Key 指纹获取或创建 Resend 客户端。
 *
 * @param apiKey 当前运行时 API Key。
 * @returns 与当前凭据绑定的 Resend 客户端。
 * @throws API Key 缺失时抛出不含敏感信息的配置错误。
 */
function getOrCreateResendClient(apiKey: string | undefined): Resend {
  if (!apiKey) {
    throw new Error("RESEND_API_KEY 未配置");
  }

  const fingerprint = createConfigFingerprint(["resend", apiKey]);
  if (resendClientCache?.fingerprint === fingerprint) {
    return resendClientCache.client;
  }

  const client = new Resend(apiKey);
  resendClientCache = { fingerprint, client };
  return client;
}

/**
 * 按 SMTP 连接参数指纹获取或创建 Transporter。
 *
 * @param config 当前运行时 SMTP 配置。
 * @returns 与当前凭据绑定的 Nodemailer Transporter。
 * @throws 必需配置缺失时抛出不含敏感信息的配置错误。
 */
function getOrCreateSmtpTransporter(
  config: SmtpConfig | null
): Transporter<SMTPTransport.SentMessageInfo> {
  if (!config) {
    throw new Error(
      "SMTP 未配置，请设置 SMTP_HOST、SMTP_PORT、SMTP_USER、SMTP_PASS 和 SMTP_SECURE"
    );
  }

  const fingerprint = createConfigFingerprint([
    "smtp",
    config.host,
    config.port,
    config.secure,
    config.user,
    config.pass,
  ]);
  if (smtpTransporterCache?.fingerprint === fingerprint) {
    return smtpTransporterCache.client;
  }

  // WHY：配置轮换后旧连接池不再会被复用，显式关闭以释放 SMTP socket；
  // 新 transporter 只在完整配置校验通过后创建，轮换失败不会泄露凭据。
  smtpTransporterCache?.client.close();
  const options: SMTPTransport.Options = {
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  };
  const client = createTransport(options);
  smtpTransporterCache = { fingerprint, client };
  return client;
}

/**
 * 判断 SMTP 当前是否具备完整凭据。
 *
 * @returns 配置完整时为 true；系统设置读取失败时上抛。
 */
export async function isSmtpConfigured(): Promise<boolean> {
  return Boolean((await getEmailRuntimeConfig()).smtp);
}

/**
 * 判断 Resend 当前是否具备 API Key。
 *
 * @returns 已配置时为 true；系统设置读取失败时上抛。
 */
export async function isResendConfigured(): Promise<boolean> {
  return Boolean((await getEmailRuntimeConfig()).resendApiKey);
}

/**
 * 判断任一邮件通道当前是否可用。
 *
 * @returns SMTP 或 Resend 至少一个配置完整时为 true。
 */
export async function isEmailConfigured(): Promise<boolean> {
  const config = await getEmailRuntimeConfig();
  return Boolean(config.smtp || config.resendApiKey);
}

/**
 * 判断当前选中的邮件供应商是否完整可用，并返回非机密配置 revision。
 *
 * @returns 发送 outbox 前使用的配置状态；不会返回 SMTP 密码或 Resend Key。
 */
export async function getEmailConfigurationSnapshot(): Promise<EmailDeliveryConfigurationSnapshot> {
  const config = await getEmailRuntimeConfig();
  const configured =
    config.provider === "smtp"
      ? Boolean(config.smtp)
      : Boolean(config.resendApiKey);
  return {
    configured,
    provider: config.provider,
    from: config.from,
    configurationFingerprint: getEmailConfigurationFingerprint(config),
  };
}

/**
 * 获取当前生效的邮件通道。
 *
 * @returns 显式选择的通道；未选择时优先使用已配置的 SMTP。
 */
export async function getEmailProvider(): Promise<EmailProvider> {
  return (await getEmailRuntimeConfig()).provider;
}

/**
 * 获取当前生效的默认发件人。
 *
 * @returns 后台配置的 EMAIL_FROM，未配置时返回项目默认值。
 */
export async function getDefaultFromEmail(): Promise<string> {
  return (await getEmailRuntimeConfig()).from;
}

/**
 * 获取与当前 API Key 匹配的 Resend 客户端。
 *
 * @returns 可发送邮件的 Resend 客户端。
 */
export async function getResendClient(): Promise<Resend> {
  const config = await getEmailRuntimeConfig();
  return getOrCreateResendClient(config.resendApiKey);
}

/**
 * 获取与当前 SMTP 凭据匹配的 Transporter。
 *
 * @returns 可发送邮件的 Nodemailer Transporter。
 */
export async function getSmtpTransporter(): Promise<
  Transporter<SMTPTransport.SentMessageInfo>
> {
  const config = await getEmailRuntimeConfig();
  return getOrCreateSmtpTransporter(config.smtp);
}

/**
 * 获取真实发送所需的一致运行时快照和客户端。
 *
 * @returns 当前通道、发件人与对应客户端。
 * @throws 所选通道的凭据不完整时显式失败。
 */
export async function getEmailDeliveryClient(): Promise<EmailDeliveryClient> {
  const config = await getEmailRuntimeConfig();

  if (config.provider === "smtp") {
    return {
      provider: "smtp",
      from: config.from,
      transporter: getOrCreateSmtpTransporter(config.smtp),
    };
  }

  return {
    provider: "resend",
    from: config.from,
    resend: getOrCreateResendClient(config.resendApiKey),
  };
}
