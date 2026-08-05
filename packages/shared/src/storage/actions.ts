"use server";

/**
 * 存储系统 Server Actions
 *
 * 提供文件上传和管理的服务端操作接口
 */

import { z } from "zod";

import { getMediaLimitDefaults } from "../image-generation/media-limit-service";
import { protectedAction } from "../safe-action";
import { getRuntimeStorageBucketConfig } from "../system-settings";

import { getStorageProvider } from "./providers";
import { ALLOWED_IMAGE_TYPES, type AllowedImageType } from "./types";
import {
  isBucketAllowed,
  keyBelongsToUser,
  parseAvatarStorageBucketName,
} from "./utils";

const withStorageAction = (name: string) =>
  protectedAction.metadata({ action: `storage.${name}` });

// ============================================
// 存储配置
// ============================================

/**
 * 获取已与生成内容隔离的头像存储桶名称。
 *
 * @returns 当前运行时头像 bucket。
 * @sideEffects 并发读取头像和生成内容两项系统设置。
 * @failure 设置缺失、为空或两个安全域同名时拒绝，不签发存储权限。
 */
async function getAvatarsBucket(): Promise<string> {
  const { systemAssets, generations } = await getRuntimeStorageBucketConfig();
  return parseAvatarStorageBucketName(systemAssets, generations);
}

// ============================================
// 上传 URL Actions
// ============================================

/**
 * 获取签名上传 URL
 *
 * 受保护的 Action - 需要用户登录
 * 客户端使用此 URL 直接上传文件到存储
 */
export const getSignedUploadUrlAction = withStorageAction("getSignedUploadUrl")
  .schema(
    z.object({
      /** 文件键名 (完整路径，如 avatars/user-123.jpg) */
      key: z
        .string()
        .min(1, "文件键名不能为空")
        .max(255, "文件键名过长")
        .regex(/^[a-zA-Z0-9\-_/.]+$/, "文件键名包含非法字符"),
      /** 文件 MIME 类型 */
      contentType: z.enum(
        ["image/jpeg", "image/png", "image/gif", "image/webp"],
        {
          message: `只支持以下文件类型: ${ALLOWED_IMAGE_TYPES.join(", ")}`,
        }
      ),
      /** 存储桶名称 (可选，默认使用头像桶) */
      bucket: z.string().optional(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const { key, contentType, bucket: inputBucket } = parsedInput;
    const { userId } = ctx;

    // 确定使用的存储桶
    const avatarsBucket = await getAvatarsBucket();
    const bucket = inputBucket ?? avatarsBucket;

    // 安全检查：验证存储桶在白名单中
    if (!isBucketAllowed(bucket, [avatarsBucket])) {
      throw new Error("不允许访问该存储桶");
    }

    // 安全检查：确保用户只能上传自己的文件
    // 文件键名必须锚定在用户 ID 边界上（前缀匹配，而非子串）
    if (!keyBelongsToUser(key, userId)) {
      throw new Error("文件路径无效：必须以用户 ID 为前缀");
    }

    const mediaLimits = await getMediaLimitDefaults();

    // 获取签名上传 URL
    const provider = await getStorageProvider();
    const uploadUrl = await provider.getSignedUploadUrl(
      key,
      bucket,
      contentType as AllowedImageType
    );

    return {
      uploadUrl,
      key,
      bucket,
      maxFileSizeBytes: mediaLimits.maxFileSizeBytes,
    };
  });

/**
 * 删除文件
 *
 * 受保护的 Action - 需要用户登录
 * 用户只能删除自己的文件
 */
export const deleteFileAction = withStorageAction("deleteFile")
  .schema(
    z.object({
      /** 文件键名 */
      key: z.string().min(1, "文件键名不能为空"),
      /** 存储桶名称 (可选，默认使用头像桶) */
      bucket: z.string().optional(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const { key, bucket: inputBucket } = parsedInput;
    const { userId } = ctx;

    // 确定使用的存储桶
    const avatarsBucket = await getAvatarsBucket();
    const bucket = inputBucket ?? avatarsBucket;

    // 安全检查：验证存储桶在白名单中
    if (!isBucketAllowed(bucket, [avatarsBucket])) {
      throw new Error("不允许访问该存储桶");
    }

    // 安全检查：确保用户只能删除自己的文件（前缀匹配，而非子串）
    if (!keyBelongsToUser(key, userId)) {
      throw new Error("无权删除此文件");
    }

    // 删除文件
    const provider = await getStorageProvider();
    await provider.deleteObject(key, bucket);

    return {
      success: true,
      key,
    };
  });
