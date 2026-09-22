/** External API UOL reads and admin key status, backed by Go HTTP routes. */
import { bindExecute, OperationError, type Principal } from "@repo/shared/uol";
import { requestGoJson, requestGoJsonForPrincipal } from "@/server/go-backend-client";

type ExternalTaskResponse = {
  taskId?: string;
  id?: string;
  status?: string;
  result?: { url?: string };
  imageUrl?: string;
  error?: string | { message?: string };
  created?: number | string;
  completed_at?: string;
};

type ExternalCreditsResponse = {
  account?: {
    balance?: number;
    total_spent?: number;
    total_earned?: number;
  };
  credits?: number;
  used?: number;
  total?: number;
};

function apiPrincipal(p: Principal): Extract<Principal, { type: "apiKey" }> {
  if (p.type !== "apiKey" || p.credentialKind !== "external") throw new OperationError("unauthenticated", "API key authentication required");
  return p;
}
function userPrincipal(p: Principal) {
  if (p.type !== "user") throw new OperationError("unauthenticated", "User session authentication required");
  return p;
}
function parseTask(raw: ExternalTaskResponse, taskId: string) {
  const result = raw.result ?? (raw.imageUrl ? { url: raw.imageUrl } : undefined);
  const error =
    typeof raw.error === "string" ? raw.error : raw.error?.message;
  return {
    taskId: raw.taskId ?? raw.id ?? taskId,
    status: raw.status === "processing" ? "processing" : raw.status,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
    ...(raw.created != null ? { createdAt: Number(raw.created) } : {}),
    ...(raw.completed_at ? { completedAt: Math.floor(new Date(raw.completed_at).getTime() / 1000) } : {}),
  };
}

bindExecute("externalApi.getCredits", async (_input, principal) => {
  const p = apiPrincipal(principal);
  const raw = await requestGoJsonForPrincipal<ExternalCreditsResponse>(
    p,
    "/v1/credits"
  );
  return {
    credits: Number(raw.account?.balance ?? raw.credits ?? 0),
    used: Number(raw.account?.total_spent ?? raw.used ?? 0),
    total: Number(raw.account?.total_earned ?? raw.total ?? 0),
  };
});
bindExecute("externalApi.getTask", async (input: { taskId: string }, principal) => {
  const p = apiPrincipal(principal);
  return parseTask(await requestGoJsonForPrincipal(p, `/v1/images/${encodeURIComponent(input.taskId)}`), input.taskId);
});
// This operation has the same API-key scope as GET /v1/models. The Go route
// remains authoritative for visibility and provider availability.
bindExecute("externalApi.getModels", async (_input, principal) => {
  const p = apiPrincipal(principal);
  return requestGoJsonForPrincipal(p, "/v1/models");
});

bindExecute("externalApi.adminSetKeyStatus", async (
  input: {
    keyId: string;
    status: "active" | "disabled" | "revoked";
    reason?: string;
  },
  principal
) => {
  userPrincipal(principal);
  const raw = await requestGoJson<{
    success: boolean;
    previousStatus: string;
    newStatus: string;
    updatedAt: string;
  }>(`/api/admin/api-keys/${encodeURIComponent(input.keyId)}/status`, {
      method: "POST",
      body: JSON.stringify({
        isActive: input.status === "active",
        reason: input.reason,
      }),
    });
  return {
    success: raw.success,
    previousStatus: raw.previousStatus,
    newStatus: raw.newStatus,
    updatedAt: raw.updatedAt,
  };
  }
);
