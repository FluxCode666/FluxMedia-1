"use server";

import { updateProfileSchema } from "@/features/settings/schemas";
import { protectedAction } from "@repo/shared/safe-action";
import { requestGoJson } from "@/server/go-backend-client";

/**
 * 更新用户资料 Server Action
 *
 * 功能:
 * - 验证用户已登录 (通过 protectedAction 中间件)
 * - 更新数据库中的用户名称和头像
 * - 刷新设置页面缓存
 *
 * @param data - 包含 name 和/或 image 字段的对象
 * @returns 成功消息
 */
export const updateProfileAction = protectedAction
  .metadata({ action: "settings.updateProfile" })
  .schema(updateProfileSchema)
  .action(async ({ parsedInput: data }) => {
    return requestGoJson<{message:string}>("/api/user/profile", {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  });
