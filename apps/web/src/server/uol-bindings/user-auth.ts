/** User administration UOL bindings backed by the Go admin API. */
import { listUsers as registeredUserListOperation } from "@repo/shared/uol/operations";
import {
  adminUserListOutputSchema,
} from "@repo/shared/support/admin-user-list-contract";
import { bindExecute, OperationError, type Principal } from "@repo/shared/uol";
import { requestGoJson } from "@/server/go-backend-client";

void registeredUserListOperation;

type AdminUserListResponse = Record<string, unknown> & {
  users?: Array<
    Record<string, unknown> & {
      createdAt: string | Date;
      updatedAt: string | Date;
    }
  >;
};

function requireUser(principal: Principal): Extract<Principal, { type: "user" }> {
  if (principal.type !== "user") {
    throw new OperationError("unauthenticated", "User session authentication required");
  }
  return principal;
}

function requireAdmin(principal: Principal) {
  const user = requireUser(principal);
  if (user.role !== "admin" && user.role !== "super_admin") {
    throw new OperationError("forbidden", "Administrator access required");
  }
  return user;
}

function requireSuperAdmin(principal: Principal) {
  const user = requireUser(principal);
  if (user.role !== "super_admin") {
    throw new OperationError("forbidden", "Super administrator access required");
  }
  return user;
}

function parseAdminUserList(raw: AdminUserListResponse) {
  return adminUserListOutputSchema.parse({
    ...raw,
    users: (raw.users ?? []).map((user) => ({
      ...user,
      createdAt: new Date(user.createdAt),
      updatedAt: new Date(user.updatedAt),
    })),
  });
}

bindExecute("user.list", async (input, principal) => {
  requireAdmin(principal);
  const parsed = input as {
    query?: string;
    page?: number;
    pageSize?: number;
    status?: string;
    creditsStatus?: string;
  };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed ?? {})) {
    if (value !== undefined) query.set(key, String(value));
  }
  return parseAdminUserList(
    await requestGoJson<AdminUserListResponse>(
      `/api/admin/users?${query.toString()}`
    )
  );
});

bindExecute("user.getDetail", async (input, principal) => {
  requireAdmin(principal);
  const { userId } = input as { userId: string };
  return requestGoJson(`/api/admin/users/${encodeURIComponent(userId)}`);
});

bindExecute("user.updateRole", async (input, principal) => {
  requireSuperAdmin(principal);
  const { userId, role } = input as { userId: string; role: string };
  await requestGoJson(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
  return { success: true };
});

bindExecute("user.ban", async (input, principal) => {
  requireAdmin(principal);
  const { userId, banned, reason } = input as {
    userId: string;
    banned: boolean;
    reason?: string;
  };
  await requestGoJson(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ banned, reason }),
  });
  return { success: true };
});

bindExecute("user.setCreditsStatus", async (input, principal) => {
  requireAdmin(principal);
  const { userId, creditsEnabled } = input as {
    userId: string;
    creditsEnabled: boolean;
  };
  await requestGoJson(`/api/admin/users/${encodeURIComponent(userId)}/credits/status`, {
    method: "POST",
    body: JSON.stringify({ status: creditsEnabled ? "active" : "frozen" }),
  });
  return { success: true };
});

bindExecute("user.setExternalApiKeyStatus", async (input, principal) => {
  requireAdmin(principal);
  const { userId, externalApiKeyEnabled } = input as {
    userId: string;
    externalApiKeyEnabled: boolean;
  };
  await requestGoJson(
    `/api/admin/users/${encodeURIComponent(userId)}/external-api-key-status`,
    {
      method: "POST",
      body: JSON.stringify({ externalApiKeyEnabled }),
    }
  );
  return { success: true };
});

bindExecute("user.create", async (input, principal) => {
  requireSuperAdmin(principal);
  const raw = await requestGoJson<{ userId: string }>("/api/admin/users", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return { userId: raw.userId, success: true };
});

bindExecute("user.updateProfile", async (input, principal) => {
  requireSuperAdmin(principal);
  const parsed = input as { userId: string; name?: string; image?: string };
  await requestGoJson(`/api/admin/users/${encodeURIComponent(parsed.userId)}`, {
    method: "PATCH",
    body: JSON.stringify(parsed),
  });
  return { success: true };
});

bindExecute("user.setPassword", async (input, principal) => {
  requireSuperAdmin(principal);
  const parsed = input as { userId: string; newPassword: string };
  await requestGoJson(`/api/admin/users/${encodeURIComponent(parsed.userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ password: parsed.newPassword }),
  });
  return { success: true };
});

bindExecute("user.getCurrentSession", async () =>
  requestGoJson("/api/session/current")
);

// Authentication and timezone operations use the same Go session boundary as
// the page server actions. Keeping these bindings here prevents shared
// operation stubs from importing the legacy Better Auth/Drizzle services.
bindExecute("user.sendVerificationCode", async (input: { email: string }) => {
  await requestGoJson("/api/auth/registration-verification", {
    method: "POST",
    body: JSON.stringify({ email: input.email }),
  });
  return { success: true };
});

bindExecute("user.verifyCode", async (input: { email: string; code: string }) => {
  // Go consumes a successful code verification atomically, matching the
  // registration verification operation contract.
  const raw = await requestGoJson<{ valid?: boolean }>("/api/auth/registration-verification/verify", {
    method: "POST",
    body: JSON.stringify({ email: input.email, code: input.code }),
  });
  return { valid: Boolean(raw.valid) };
});

bindExecute("user.getMyTimeZone", async (_input, principal) => {
  requireUser(principal);
  const profile = await requestGoJson<{
    timeZone?: string | null;
    defaultTimeZone?: string;
  }>("/api/user/profile");
  const timeZone = profile.timeZone ?? null;
  const defaultTimeZone = profile.defaultTimeZone || process.env.APP_TIME_ZONE || "UTC";
  return { timeZone, defaultTimeZone, effectiveTimeZone: timeZone || defaultTimeZone };
});

bindExecute("user.updateMyTimeZone", async (
  input: { timeZone: string | null },
  principal
) => {
  requireUser(principal);
  type TimeZoneResponse = {
    timeZone?: string | null;
    defaultTimeZone?: string;
    effectiveTimeZone?: string;
  };
  const raw = await requestGoJson<
    TimeZoneResponse & { data?: TimeZoneResponse }
  >("/api/user/time-zone", {
    method: "POST",
    body: JSON.stringify({ timeZone: input.timeZone }),
  });
  const data = raw.data ?? raw;
  const timeZone = data.timeZone ?? null;
  return {
    timeZone,
    defaultTimeZone: data.defaultTimeZone || process.env.APP_TIME_ZONE || "UTC",
    effectiveTimeZone: data.effectiveTimeZone || timeZone || data.defaultTimeZone || process.env.APP_TIME_ZONE || "UTC",
  };
  });

bindExecute("user.bootstrap", async () => {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) throw new OperationError("internal_error", "Bootstrap service is not configured");
  const raw = await requestGoJson<{ userId: string; success: boolean }>("/api/internal/auth/bootstrap", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  return { userId: raw.userId, success: raw.success };
});
