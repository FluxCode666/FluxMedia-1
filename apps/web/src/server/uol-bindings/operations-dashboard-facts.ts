/** Web visit and epoch writes terminate in Go; identities remain at the UOL boundary. */
import { requestGoJson } from "@/server/go-backend-client";
import { bindOperationExecute, OperationError } from "@repo/shared/uol";
import { ensureCurrentOperationsEpoch, recordWebVisit } from "@repo/shared/uol/operations/operations-dashboard-facts";

bindOperationExecute(recordWebVisit, async (_input, principal) => {
  if (principal.type !== "user") throw new OperationError("unauthenticated", "User session authentication required");
  return requestGoJson("/api/operations/web-visit", { method: "POST", body: "{}" });
});
bindOperationExecute(ensureCurrentOperationsEpoch, async (input, principal) => {
  if (principal.type !== "system") throw new OperationError("forbidden", "System access required");
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) throw new OperationError("validation_error", "CRON_SECRET 未配置");
  return requestGoJson("/api/operations/ensure-epoch", {
    method: "POST", headers: { authorization: `Bearer ${cronSecret}` },
    body: JSON.stringify({ initializedBy: input.initializedBy }),
  });
});
