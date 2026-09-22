/** Go-backed late bindings for the remaining settings, storage, media-limit and
 * moderation operations. Keeping these adapters in one file makes the UOL
 * registry audit explicit: no operation in these domains falls back to the
 * legacy Next/Drizzle implementation at runtime. */
import type { OperationContext, Principal } from "@repo/shared/uol";
import { bindExecute, OperationError } from "@repo/shared/uol";
import { requestGoJson, requestGoJsonForPrincipal } from "@/server/go-backend-client";

type PresignedUploadResponse = {
  url?: string;
  presignedUrl?: string;
  uploadUrl?: string;
  key?: string;
  fileKey?: string;
};

type DatedResponse = Record<string, unknown> & {
  updatedAt?: string | Date;
};

function internalInit(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  return { ...init, headers };
}

async function call<T>(principal: Principal, path: string, init: RequestInit = {}, system = false): Promise<T> {
  if (system) return requestGoJson<T>(path, internalInit(init));
  if (principal.type === "apiKey") return requestGoJsonForPrincipal<T>(principal, path, init);
  return requestGoJson<T>(path, init);
}

function asDate<T extends { updatedAt?: string | Date }>(value: T): T {
  if (typeof value.updatedAt === "string") return { ...value, updatedAt: new Date(value.updatedAt) };
  return value;
}

bindExecute("settings.getHomepageSlaVisibility", async () => requestGoJson("/api/marketing/sla-visibility"));
bindExecute("settings.getPaginationConfig", async () => requestGoJson("/api/pagination/config"));
bindExecute("settings.getSiteBranding", async () => requestGoJson("/api/system-settings/site-branding"));
bindExecute("settings.setMarketingSlaVisibility", async (input: { enabled: boolean }, principal: Principal) => {
  if (principal.type !== "user") throw new OperationError("forbidden", "需要管理员身份");
  return requestGoJson("/api/marketing/sla-visibility", { method: "PUT", body: JSON.stringify(input) });
});
bindExecute("settings.setSiteLogo", async (input: { logoUrl: string | null }, principal: Principal) => {
  if (principal.type !== "user") throw new OperationError("forbidden", "需要管理员身份");
  return requestGoJson("/api/system-settings/site-logo", { method: "PUT", body: JSON.stringify(input) });
});
bindExecute("settings.getSnapshot", async (_input: unknown, principal: Principal) => call(principal, "/api/system-settings"));
bindExecute("settings.update", async (input: { updates: unknown[] }, principal: Principal) => call(principal, "/api/system-settings", { method: "PUT", body: JSON.stringify({ settings: input.updates }) }));
bindExecute("settings.getModelPricing", async (_input: unknown, principal: Principal) => call(principal, "/api/system-settings/model-pricing"));
bindExecute("settings.importFromEnv", async (input: { overwriteExisting?: boolean }, principal: Principal) => call(principal, "/api/system-settings/import-env", { method: "POST", body: JSON.stringify({ overwrite: input.overwriteExisting }) }));
bindExecute("settings.initializeDefaults", async (_input: unknown, principal: Principal) => call(principal, "/api/system-settings/initialize-defaults", { method: "POST", body: "{}" }, true));
bindExecute("settings.syncToEnv", async (input: unknown, principal: Principal) => call(principal, "/api/system-settings/sync-env", { method: "POST", body: JSON.stringify(input) }, true));
bindExecute("settings.bootstrap", async (_input: unknown, principal: Principal) => call(principal, "/api/system-settings/bootstrap", {}, true));
bindExecute("settings.getValue", async (input: { key: string }, principal: Principal) => call(principal, `/api/system-settings/value?key=${encodeURIComponent(input.key)}`, {}, true));

bindExecute("storage.getSignedUploadUrl", async (input: unknown, principal: Principal) => {
  const raw = await call<PresignedUploadResponse>(principal, "/api/upload/presigned", { method: "POST", body: JSON.stringify(input) });
  return { url: raw.url ?? raw.presignedUrl ?? raw.uploadUrl, key: raw.key ?? raw.fileKey };
});
bindExecute("storage.deleteFile", async (input: unknown, principal: Principal) => call(principal, "/api/storage/delete", { method: "POST", body: JSON.stringify(input) }));
bindExecute("storage.createPresignedUpload", async (input: unknown, principal: Principal) => {
  const raw = await call<PresignedUploadResponse>(principal, "/api/upload/presigned", { method: "POST", body: JSON.stringify(input) });
  return { url: raw.url ?? raw.presignedUrl ?? raw.uploadUrl, fileKey: raw.fileKey ?? raw.key };
});
async function readStorage(input: { bucket: string; key: string }, principal: Principal, internal: boolean) {
  const raw = await call<{ data: string; contentType?: string; contentLength?: number }>(principal, "/api/storage/object", { method: "POST", body: JSON.stringify(input) }, internal);
  return { ...raw, data: Buffer.from(raw.data, "base64") };
}
bindExecute("storage.readObject", async (input: { bucket: string; key: string }, principal: Principal) => readStorage(input, principal, false));
bindExecute("storage.getObject", async (input: { bucket: string; key: string }, principal: Principal) => readStorage(input, principal, true));
bindExecute("storage.putObject", async (input: { bucket: string; key: string; data: unknown; contentType?: string }, principal: Principal) => {
  const data = typeof input.data === "string"
    ? Buffer.from(input.data, "utf8").toString("base64")
    : Buffer.from(input.data as Uint8Array).toString("base64");
  return call(principal, "/api/storage/object", { method: "PUT", body: JSON.stringify({ ...input, data }) }, true);
});
bindExecute("storage.deleteObject", async (input: unknown, principal: Principal) => call(principal, "/api/storage/object", { method: "DELETE", body: JSON.stringify(input) }, true));
bindExecute("storage.getSignedReadUrl", async (input: unknown, principal: Principal) => call(principal, "/api/storage/signed-read-url", { method: "POST", body: JSON.stringify(input) }, true));

bindExecute("mediaLimits.getEffective", async (input: { userId?: string }, principal: Principal) => {
  const q = input.userId ? `?userId=${encodeURIComponent(input.userId)}` : "";
  return call(principal, `/api/image-generation/media-limits${q}`, {}, principal.type === "system");
});
bindExecute("mediaLimits.setUserConcurrencyOverride", async (input: unknown, principal: Principal, ctx: OperationContext) => {
  const value = await call<DatedResponse>(principal, `/api/admin/users/${encodeURIComponent((input as { userId: string }).userId)}/concurrency`, { method: "POST", headers: { "X-Request-ID": ctx.requestId }, body: JSON.stringify(input) });
  return asDate(value);
});

bindExecute("moderation.getGlobalRiskPolicy", async (_input: unknown, principal: Principal) => {
  const raw = await call<{ policy: unknown }>(principal, "/api/system-settings/moderation-policy");
  return raw.policy;
});
bindExecute("moderation.setGlobalRiskLevel", async (input: unknown, principal: Principal, ctx: OperationContext) => {
  const raw = await call<{ changed: boolean; previousLevel: unknown; level: unknown; auditLogId: string; updatedAt: string | Date }>(principal, "/api/system-settings/moderation-policy", { method: "PUT", headers: { "X-Request-ID": ctx.requestId }, body: JSON.stringify(input) });
  return asDate({ changed: raw.changed, before: raw.previousLevel, after: raw.level, auditLogId: raw.auditLogId, updatedAt: raw.updatedAt });
});
bindExecute("moderation.getUserRiskPolicy", async (input: { userId: string }, principal: Principal) => call(principal, `/api/moderation/users/${encodeURIComponent(input.userId)}/policy`));
bindExecute("moderation.setUserRiskLevelOverride", async (input: { userId: string }, principal: Principal, ctx: OperationContext) => asDate(await call<DatedResponse>(principal, `/api/moderation/users/${encodeURIComponent(input.userId)}/policy`, { method: "POST", headers: { "X-Request-ID": ctx.requestId }, body: JSON.stringify(input) })));
bindExecute("moderation.resolveEffectiveRiskLevel", async (input: { userId: string }, principal: Principal) => call(principal, `/api/moderation/users/${encodeURIComponent(input.userId)}/policy`, {}, true));
bindExecute("moderation.getProviders", async (_input: unknown, principal: Principal) => call(principal, "/api/moderation/providers", {}, true));
bindExecute("moderation.isEnabled", async () => requestGoJson("/api/moderation/enabled"));
bindExecute("moderation.moderateContent", async (input: unknown, principal: Principal) => call(principal, "/api/moderation/check", { method: "POST", body: JSON.stringify(input) }, true));
bindExecute("moderation.proxyModerate", async (input: unknown) => {
  const secret = process.env.CONTENT_MODERATION_PROXY_SECRET?.trim() || process.env.CONTENT_MODERATION_PROXY_GATEWAY_SECRET?.trim();
  if (!secret) throw new OperationError("internal_error", "审核代理未配置");
  return requestGoJson("/moderate", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(input) });
});
