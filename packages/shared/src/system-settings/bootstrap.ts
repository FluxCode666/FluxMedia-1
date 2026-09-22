import { requestGoBackendInternalJson } from "../http/go-backend";

let bootstrap: Promise<unknown> | undefined;

/** Go owns default initialization, legacy setting conversion, and persistence. */
export async function bootstrapSystemSettingsEnv() {
  bootstrap ??= requestGoBackendInternalJson("/api/system-settings/bootstrap").catch((error) => {
    bootstrap = undefined;
    throw error;
  });
  await bootstrap;
}
