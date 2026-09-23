import { access, constants } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const defaultHealthEndpoints = Object.freeze([
  {
    name: "web",
    url: "http://127.0.0.1:3000/",
    accepts: (response) => response.status < 500,
  },
  {
    name: "backend",
    url: "http://127.0.0.1:8080/readyz",
    accepts: (response) => response.ok,
  },
  {
    name: "script-runtime",
    url: "http://127.0.0.1:8090/healthz",
    accepts: (response) => response.ok,
  },
  {
    name: "media-processing",
    url: "http://127.0.0.1:8091/healthz",
    accepts: (response) => response.ok,
  },
]);

export function defaultModelFiles(environment = process.env) {
  const modelDirectory =
    environment.MEDIA_PROCESSING_MODELS_PATH || "/app/apps/web/models";
  return [
    "isnet.onnx",
    "realesr-general-x4v3.onnx",
    "scunet-color-real-gan.onnx",
  ].map((name) => resolve(modelDirectory, name));
}

function timeoutFrom(environment) {
  const raw = environment.UNIFIED_HEALTHCHECK_TIMEOUT_MS || "5000";
  if (!/^[0-9]+$/.test(raw)) throw new Error("invalid healthcheck timeout");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new Error("invalid healthcheck timeout");
  }
  return value;
}

export async function checkUnifiedHealth({
  fetchImpl = fetch,
  endpoints = defaultHealthEndpoints,
  modelFiles = defaultModelFiles(),
  accessImpl = access,
  timeoutMs = timeoutFrom(process.env),
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await Promise.all([
      ...endpoints.map(async (endpoint) => {
        let response;
        try {
          response = await fetchImpl(endpoint.url, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
          });
        } catch {
          throw new Error(`${endpoint.name} healthcheck failed`);
        }
        if (!endpoint.accepts(response)) {
          throw new Error(
            `${endpoint.name} healthcheck failed (${response.status})`
          );
        }
      }),
      ...modelFiles.map(async (modelFile) => {
        try {
          await accessImpl(modelFile, constants.R_OK);
        } catch {
          throw new Error("media model healthcheck failed");
        }
      }),
    ]);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await checkUnifiedHealth();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "healthcheck failed");
    process.exitCode = 1;
  }
}
