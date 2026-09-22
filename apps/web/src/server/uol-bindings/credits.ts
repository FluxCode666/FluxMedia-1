/** Credits UOL bindings backed by the Go account API. */
import { walletBalanceSnapshotSchema } from "@repo/shared/credits/wallet-contract";
import { bindExecute, OperationError } from "@repo/shared/uol";
import { requestGoJson } from "@/server/go-backend-client";

type GoBalanceResponse = {
  balance: number;
  totalSpent: number;
  totalRefunded: number;
  totalNetSpent: number;
  status: "active" | "frozen";
  asOf: string;
};

/** credits.getMyBalance uses the authenticated Go session and never accepts a user id. */
bindExecute(
  "credits.getMyBalance",
  async (_input, principal) => {
    if (principal.type !== "user") {
      throw new OperationError(
        "unauthenticated",
        "User session authentication required"
      );
    }
    const raw = await requestGoJson<GoBalanceResponse>("/api/credits/balance?registrationBonus=1");
    return walletBalanceSnapshotSchema.parse({
      ...raw,
      // Keep the shared contract's non-negative invariant even if historical
      // refund data exceeds spent data in a legacy account.
      totalNetSpent: Math.max(0, raw.totalSpent - raw.totalRefunded),
      asOf: new Date(raw.asOf).toISOString(),
    });
  }
);
