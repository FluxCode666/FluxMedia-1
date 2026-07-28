/**
 * 网站 Logo 上传保存服务。
 *
 * 职责：编排真实文件校验、专用对象存储、内容寻址 URL、数据库幂等回执与缓存失效。
 * 使用方：settings.uploadSiteLogo 的 Web late binding；Route 不直接调用本模块。
 * 关键边界：文件先写入不可变对象，再在单层数据库事务中写设置和审计；事务失败不删除
 * 可能已被其他并发请求引用的内容寻址对象，孤儿对象可由后续生命周期任务清理。
 */
import { createHash } from "node:crypto";

import { adminAuditLog, systemSetting } from "@repo/database/schema";
import { logError } from "@repo/shared/logger";
import type { StorageProvider } from "@repo/shared/storage";
import { getStorageProvider } from "@repo/shared/storage/providers";
import {
  getRuntimeSettingString,
  invalidateSystemSettingsCache,
} from "@repo/shared/system-settings";
import {
  type SiteLogoUploadInput,
  type SiteLogoUploadOutput,
  siteLogoUploadInputSchema,
  siteLogoUploadOutputSchema,
} from "@repo/shared/system-settings/site-branding";
import { and, eq } from "drizzle-orm";
import { parseModelMarketplaceAssetBucketName } from "@/features/model-marketplace/asset-reference";

import {
  buildSiteLogoAssetUrl,
  buildSiteLogoObjectKey,
  parseSiteAssetsBucketName,
  type SiteLogoAssetReference,
} from "./asset-reference";
import {
  type ValidatedSiteLogoFile,
  validateSiteLogoFile,
} from "./site-logo-file";

const SITE_LOGO_URL_SETTING_KEY = "SITE_LOGO_URL";
const SITE_LOGO_UPLOAD_AUDIT_ACTION = "system-settings.site-logo.upload";

/** 网站 Logo 保存服务的稳定领域错误码。 */
export type SiteLogoUploadServiceErrorCode =
  | "idempotency_conflict"
  | "invalid_dependency_result";

/** 表示幂等回执或运行时依赖结果不满足服务契约。 */
export class SiteLogoUploadServiceError extends Error {
  readonly code: SiteLogoUploadServiceErrorCode;

  /** 创建不含文件字节的服务错误。 */
  constructor(code: SiteLogoUploadServiceErrorCode, message: string) {
    super(message);
    this.name = "SiteLogoUploadServiceError";
    this.code = code;
  }
}

/** 上传服务可替换依赖；生产默认值只在真正执行时加载。 */
export type SiteLogoUploadServiceDependencies = {
  loadBucket: () => Promise<string>;
  loadStorage: () => Promise<StorageProvider>;
  validate: (
    input: Pick<SiteLogoUploadInput, "bytes">
  ) => Promise<ValidatedSiteLogoFile>;
  commit: (input: {
    actorUserId: string;
    clientRequestId: string;
    requestHash: string;
    logoUrl: string;
    reference: SiteLogoAssetReference;
    contentType: ValidatedSiteLogoFile["contentType"];
  }) => Promise<{ logoUrl: string; replayed: boolean }>;
  invalidateCache: () => Promise<void>;
  createRequestHash: (bytes: Uint8Array) => string;
};

/** 读取并校验网站资产 bucket；缺失时使用定义中的稳定默认值。 */
async function loadProductionBucket(): Promise<string> {
  const [siteRaw, avatarsRaw, generationsRaw, modelRaw] = await Promise.all([
    getRuntimeSettingString("SITE_ASSETS_BUCKET_NAME"),
    getRuntimeSettingString("NEXT_PUBLIC_AVATARS_BUCKET_NAME"),
    getRuntimeSettingString("NEXT_PUBLIC_GENERATIONS_BUCKET_NAME"),
    getRuntimeSettingString("MODEL_MARKETPLACE_ASSETS_BUCKET_NAME"),
  ]);
  const site = parseSiteAssetsBucketName(siteRaw);
  const avatars = avatarsRaw?.trim() || "avatars";
  const generations = generationsRaw?.trim() || "generations";
  let model: string;
  try {
    model = parseModelMarketplaceAssetBucketName(modelRaw);
  } catch {
    throw new SiteLogoUploadServiceError(
      "invalid_dependency_result",
      "网站资产存储桶配置无效"
    );
  }
  if (new Set([site, avatars, generations, model]).size !== 4) {
    throw new SiteLogoUploadServiceError(
      "invalid_dependency_result",
      "网站资产存储桶必须与其他业务存储桶隔离"
    );
  }
  return site;
}

/** 创建内容寻址上传服务的生产依赖。 */
const productionDependencies: SiteLogoUploadServiceDependencies = {
  loadBucket: loadProductionBucket,
  loadStorage: getStorageProvider,
  validate: validateSiteLogoFile,
  commit: commitSiteLogoUpload,
  invalidateCache: invalidateSystemSettingsCache,
  createRequestHash(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
  },
};

/**
 * 创建网站 Logo 上传服务。
 *
 * @param overrides - 测试或运行时替换的端口；缺省使用生产依赖。
 * @returns 只接受 UOL 已解析输入并返回严格公开 DTO 的保存函数。
 * @sideEffects 校验后写入对象存储、数据库审计和系统设置，并失效设置缓存。
 * @failure 文件非法、对象存储失败、数据库失败或缓存失效失败时显式抛错。
 */
export function createSiteLogoUploadService(
  overrides: Partial<SiteLogoUploadServiceDependencies> = {}
): (
  input: SiteLogoUploadInput,
  actorUserId: string
) => Promise<SiteLogoUploadOutput> {
  const dependencies = { ...productionDependencies, ...overrides };
  return async (rawInput, actorUserId) => {
    const input = siteLogoUploadInputSchema.parse(rawInput);
    const actor = actorUserId.trim();
    if (!actor || actor.length > 255) {
      throw new SiteLogoUploadServiceError(
        "invalid_dependency_result",
        "管理员用户标识无效"
      );
    }

    const validated = await dependencies.validate({ bytes: input.bytes });
    const bucket = await dependencies.loadBucket();
    const key = buildSiteLogoObjectKey(validated.sha256, validated.extension);
    const reference = { bucket, key };
    const logoUrl = buildSiteLogoAssetUrl(reference, bucket);

    // 内容寻址 key 使相同文件的网络重试只覆盖同一不可变对象，不会产生版本混淆。
    const storage = await dependencies.loadStorage();
    await storage.putObject(
      key,
      bucket,
      Buffer.from(validated.bytes),
      validated.contentType
    );

    let result: { logoUrl: string; replayed: boolean };
    try {
      result = await dependencies.commit({
        actorUserId: actor,
        clientRequestId: input.clientRequestId,
        requestHash: dependencies.createRequestHash(input.bytes),
        logoUrl,
        reference,
        contentType: validated.contentType,
      });
    } catch (error) {
      // 不删除新对象：并发管理员可能已经提交同一内容寻址 key，删除会破坏当前引用。
      logError(error, {
        source: "site-logo-upload.commit",
        bucket,
        key,
        clientRequestId: input.clientRequestId,
      });
      throw error;
    }

    // replay 也必须失效缓存：上一请求可能在 DB 提交后尚未完成缓存失效即断开。
    await dependencies.invalidateCache();
    return siteLogoUploadOutputSchema.parse({
      logoUrl: result.logoUrl,
      replayed: result.replayed,
    });
  };
}

/** 生产网站 Logo 上传服务。 */
export const siteLogoUploadService = createSiteLogoUploadService();

type LogoUploadCommitInput = Parameters<
  SiteLogoUploadServiceDependencies["commit"]
>[0];

/** 从审计 metadata 中读取幂等请求哈希。 */
function parseReceiptRequestHash(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const metadata = value as Record<string, unknown>;
  const requestHash = metadata.requestHash;
  if (typeof requestHash !== "string" || !/^[a-f0-9]{64}$/.test(requestHash)) {
    return null;
  }
  return requestHash;
}

/**
 * 在一层数据库事务中写入幂等审计回执和 Logo URL。
 *
 * @param input - 已由文件服务构造的内容寻址结果。
 * @returns 当前 Logo URL 与是否重放既有回执。
 * @sideEffects 使用 adminAuditLog.id 的确定性回执进行去重，并更新 SITE_LOGO_URL。
 * @failure 同请求 ID 的载荷不同会拒绝；任一写入失败会回滚整个事务。
 */
export async function commitSiteLogoUpload(
  input: LogoUploadCommitInput
): Promise<{ logoUrl: string; replayed: boolean }> {
  const receiptId =
    "site-logo-upload:" +
    createHash("sha256")
      .update(`${input.actorUserId}:${input.clientRequestId}`)
      .digest("hex");
  const { db } = await import("@repo/database");

  return db.transaction(async (transaction) => {
    const inserted = await transaction
      .insert(adminAuditLog)
      .values({
        id: receiptId,
        adminUserId: input.actorUserId,
        targetUserId: null,
        action: SITE_LOGO_UPLOAD_AUDIT_ACTION,
        reason: "管理员上传网站 Logo",
        before: null,
        after: { logoUrl: input.logoUrl },
        metadata: {
          requestHash: input.requestHash,
          sha256: input.reference.key.slice(5, 69),
          contentType: input.contentType,
        },
      })
      .onConflictDoNothing({ target: adminAuditLog.id })
      .returning({ id: adminAuditLog.id });

    if (inserted.length === 0) {
      const rows = await transaction
        .select({
          metadata: adminAuditLog.metadata,
          after: adminAuditLog.after,
        })
        .from(adminAuditLog)
        .where(
          and(
            eq(adminAuditLog.id, receiptId),
            eq(adminAuditLog.action, SITE_LOGO_UPLOAD_AUDIT_ACTION)
          )
        )
        .limit(1);
      const receipt = rows[0];
      const parsedRequestHash = receipt
        ? parseReceiptRequestHash(receipt.metadata)
        : null;
      const afterUrl =
        receipt && typeof receipt.after?.logoUrl === "string"
          ? receipt.after.logoUrl
          : null;
      if (!parsedRequestHash || !afterUrl) {
        throw new SiteLogoUploadServiceError(
          "invalid_dependency_result",
          "Logo 上传幂等回执无效"
        );
      }
      if (parsedRequestHash !== input.requestHash) {
        throw new SiteLogoUploadServiceError(
          "idempotency_conflict",
          "该上传请求标识已用于另一份 Logo"
        );
      }
      return { logoUrl: afterUrl, replayed: true };
    }

    await transaction
      .insert(systemSetting)
      .values({
        key: SITE_LOGO_URL_SETTING_KEY,
        value: input.logoUrl,
        isSecret: false,
        updatedBy: input.actorUserId,
      })
      .onConflictDoUpdate({
        target: systemSetting.key,
        set: {
          value: input.logoUrl,
          isSecret: false,
          updatedBy: input.actorUserId,
          updatedAt: new Date(),
        },
      });
    return { logoUrl: input.logoUrl, replayed: false };
  });
}
