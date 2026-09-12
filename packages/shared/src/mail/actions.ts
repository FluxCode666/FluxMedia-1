"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import { actionClient } from "../safe-action";

async function requestGo<T>(path: string, body: unknown): Promise<T> {
  const base = (process.env.GO_BACKEND_URL || process.env.BETTER_AUTH_URL || "http://127.0.0.1:8080").replace(/\/$/u, "");
  const cookieHeader = (await cookies()).getAll().map((c) => `${c.name}=${c.value}`).join("; ");
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(cookieHeader ? { cookie: cookieHeader } : {}) }, body: JSON.stringify(body), cache: "no-store" });
  const payload = (await response.json().catch(() => null)) as T & { message?: string; error?: { message?: string } };
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "请求失败，请稍后重试");
  return payload;
}

const withMailAction = (name: string) => actionClient.metadata({ action: `mail.${name}` });
const emailSchema = z.object({ email: z.string().email("请输入有效的邮箱地址") });

export const subscribeNewsletter = withMailAction("subscribeNewsletter").schema(emailSchema).action(async ({ parsedInput }) => requestGo("/api/newsletter/subscribe", parsedInput));
export const unsubscribeNewsletter = withMailAction("unsubscribeNewsletter").schema(emailSchema).action(async ({ parsedInput }) => requestGo("/api/newsletter/unsubscribe", parsedInput));
export const checkSubscriptionStatus = withMailAction("checkSubscriptionStatus").schema(emailSchema).action(async ({ parsedInput }) => requestGo("/api/newsletter/status", parsedInput));
