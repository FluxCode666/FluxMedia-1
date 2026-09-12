"use server";

/**
 * 用户展示时区 Server Action 薄适配器。
 *
 * 使用方是账户设置页；本文件只校验输入、构造登录用户 Principal、调用 UOL，并刷新
 * Dashboard 布局。时区校验与持久化由 user.updateMyTimeZone 单点负责。
 */
import { protectedAction } from "@repo/shared/safe-action";
import { userTimeZoneSchema } from "@repo/shared/time-zone";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requestGoJson } from "@/server/go-backend-client";

const updateTimeZoneSchema = z.object({
  timeZone: userTimeZoneSchema,
});

/** 保存或清除当前登录用户的展示时区偏好。 */
export const updateTimeZoneAction = protectedAction
  .metadata({ action: "settings.updateTimeZone" })
  .schema(updateTimeZoneSchema)
  .action(async ({ parsedInput }) => {
    const result = await requestGoJson<{
      timeZone: string | null;
      defaultTimeZone: string;
      effectiveTimeZone: string;
    }>("/api/user/time-zone", {
      method: "POST",
      body: JSON.stringify(parsedInput),
    });
    revalidatePath("/dashboard", "layout");
    return result;
  });
