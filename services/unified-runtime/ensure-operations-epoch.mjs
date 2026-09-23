import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const endpoint =
  "http://127.0.0.1:8080/api/operations/ensure-epoch";

function required(environment, name) {
  let value = environment[name]?.trim();
  if (
    value &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function ensureOperationsEpoch({
  environment = process.env,
  fetchImpl = fetch,
  requestURL = endpoint,
} = {}) {
  const secret = required(environment, "CRON_SECRET");
  const initializedBy = required(
    environment,
    "OPERATIONS_EPOCH_INITIALIZED_BY"
  );
  if (initializedBy.length > 200) {
    throw new Error("OPERATIONS_EPOCH_INITIALIZED_BY is too long");
  }

  let response;
  try {
    response = await fetchImpl(requestURL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ initializedBy }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("operations epoch request failed");
  }
  if (!response.ok) {
    throw new Error(`operations epoch request failed (${response.status})`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("operations epoch response was invalid");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await ensureOperationsEpoch();
    console.log(
      JSON.stringify({
        status: "ok",
        initialized: result?.initialized === true,
        appDate: result?.appDate,
      })
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "operations epoch request failed"
    );
    process.exitCode = 1;
  }
}
