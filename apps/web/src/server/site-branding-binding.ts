/**
 * UOL late binding for site logo upload.
 *
 * Validation, object storage, idempotency and settings persistence are owned by
 * the Go backend. This adapter only translates the UOL byte payload to the
 * multipart HTTP contract while preserving the current Better Auth cookie.
 */
import "server-only";

import type {
  SiteLogoUploadInput,
  SiteLogoUploadOutput,
} from "@repo/shared/system-settings/site-branding";
import { bindExecute, OperationError, type OperationContext, type Principal } from "@repo/shared/uol";
import { cookies } from "next/headers";

async function uploadLogoToGo(input: SiteLogoUploadInput): Promise<SiteLogoUploadOutput> {
  const base = (process.env.GO_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/$/u, "");
  const form = new FormData();
  form.append("clientRequestId", input.clientRequestId);
  form.append("file", new Blob([Buffer.from(input.bytes)], { type: input.contentType }), input.fileName);
  const cookieHeader = (await cookies()).getAll().map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const headers = new Headers();
  if (cookieHeader) headers.set("cookie", cookieHeader);
  const response = await fetch(`${base}/api/admin/site-branding/logo`, {
    method: "POST",
    headers,
    body: form,
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as SiteLogoUploadOutput & { error?: { message?: string; code?: string } };
  if (!response.ok) {
    const code = payload?.error?.code === "FORBIDDEN" ? "forbidden" : payload?.error?.code === "IDEMPOTENCY_CONFLICT" ? "idempotency_conflict" : payload?.error?.code === "INVALID_REQUEST" ? "validation_error" : "internal_error";
    throw new OperationError(code, payload?.error?.message || "网站 Logo 上传失败");
  }
  return payload;
}

/** Bind settings.uploadSiteLogo to the Go multipart endpoint. */
bindExecute(
  "settings.uploadSiteLogo",
  async (input: SiteLogoUploadInput, principal: Principal, _ctx: OperationContext): Promise<SiteLogoUploadOutput> => {
    if (principal.type !== "user") {
      throw new OperationError("forbidden", "仅超级管理员用户可以上传网站 Logo");
    }
    return uploadLogoToGo(input);
  }
);
