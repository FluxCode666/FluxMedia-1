/** The Go gateway atomically bootstraps the first self-use administrator. */
import { requestGoBackendInternalJson } from "../http/go-backend";

export function bootstrapSelfUseSuperAdmin() {
  return requestGoBackendInternalJson<{ userId: string; success: boolean; reason?: string }>(
    "/api/internal/auth/bootstrap", { method: "POST" }
  );
}
