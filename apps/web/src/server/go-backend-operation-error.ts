import { OperationError } from "@repo/shared/uol";

import { GoBackendRequestError } from "./go-backend-client";

/** Keep Go failures compatible with the existing safe action error contract. */
export function toGoOperationError(error: unknown): unknown {
  if (!(error instanceof GoBackendRequestError)) return error;
  const code = error.status === 400 ? "validation_error"
    : error.status === 401 ? "unauthenticated"
    : error.status === 403 ? "forbidden"
    : error.status === 429 ? "rate_limited"
    : error.status === 408 || error.status === 504 || error.code === "TIMEOUT" ? "timeout"
    : error.status === 503 || error.code === "NOT_READY" ? "not_ready"
    : "internal_error";
  return new OperationError(code, error.message, undefined, error.status);
}
