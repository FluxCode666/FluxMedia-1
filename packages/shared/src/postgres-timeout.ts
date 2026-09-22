/** Recognize stable PostgreSQL timeout errors without importing a driver or connection pool. */
export function isPostgresTimeoutError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    const candidate = current as Error & { cause?: unknown; code?: unknown };
    const message = current.message.toLowerCase();
    const isDrizzleQueryWrapper = message.startsWith("failed query:");
    if (candidate.code === "ETIMEDOUT") return true;
    if (
      !isDrizzleQueryWrapper &&
      (message === "query read timeout" ||
        message === "connection terminated due to connection timeout" ||
        message === "timeout exceeded when trying to connect" ||
        message === "timeout expired" ||
        message.includes("canceling statement due to statement timeout"))
    ) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}
