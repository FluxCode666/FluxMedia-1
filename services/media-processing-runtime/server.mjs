import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processImage } from "./processor.mjs";

const maxLineBytes = 720 * 1024 * 1024;
const maxImageBytes = 512 * 1024 * 1024;
const authToken = process.env.MEDIA_PROCESSING_TOKEN || "";
let busy = false;
function authorized(req) {
  if (!authToken) return true;
  const actual = Buffer.from(req.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${authToken}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function* readLines(stream) {
  let buffers = [], size = 0;
  for await (const chunk of stream) {
    let start = 0;
    for (let offset = 0; offset < chunk.length; offset++) {
      if (chunk[offset] !== 10) continue;
      const part = chunk.subarray(start, offset); buffers.push(part); size += part.length;
      if (size > maxLineBytes) throw new Error("Media message is too large");
      const line = Buffer.concat(buffers, size).toString("utf8"); buffers = []; size = 0; start = offset + 1;
      yield JSON.parse(line);
    }
    const rest = chunk.subarray(start); buffers.push(rest); size += rest.length;
    if (size > maxLineBytes) throw new Error("Media message is too large");
  }
  if (size > 0) throw new Error("Incomplete media message");
}
function imageBytes(value) {
  if (typeof value !== "string" || value.length > Math.ceil(maxImageBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("Invalid media bytes");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > maxImageBytes) throw new Error("Invalid media size");
  return bytes;
}
export function createMediaServer(processor = processImage) {
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") { res.writeHead(200); res.end("ok"); return; }
    if (req.method !== "POST" || req.url !== "/process") { res.writeHead(404); res.end(); return; }
    if (!authorized(req)) { res.writeHead(401); res.end(); return; }
    if (busy) { res.writeHead(503, { "Retry-After": "2" }); res.end(); return; }
    busy = true;
    const lines = readLines(req)[Symbol.asyncIterator]();
    let cancelled = false;
    res.once("close", () => { cancelled = true; });
    const send = (value) => {
      if (cancelled) throw new Error("Media processing cancelled");
      res.write(`${JSON.stringify(value)}\n`);
    };
    try {
      const { value: input, done } = await lines.next();
      if (done || !input || typeof input !== "object") throw new Error("Missing media request");
      imageBytes(input.imageBase64);
      if (typeof input.requestedSize !== "string" || input.requestedSize.length > 64 || typeof input.repairPrompt !== "string" || input.repairPrompt.length > 32000) throw new Error("Invalid media options");
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" }); res.flushHeaders();
      let edits = 0;
      const output = await processor(input, async (edit) => {
        if (++edits > 16) throw new Error("Repair edit limit exceeded");
        send({ type: "edit", ...edit });
        const { value: reply, done } = await lines.next();
        if (done || cancelled || !reply || reply.type !== "editResult" || reply.index !== edit.index) throw new Error("Invalid repair response");
        if (reply.error) throw new Error("Repair provider failed");
        return imageBytes(reply.imageBase64);
      });
      if (!Buffer.isBuffer(output) || !output.length || output.length > maxImageBytes) throw new Error("Invalid processed image");
      send({ type: "result", imageBase64: output.toString("base64") });
    } catch (error) {
      if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/x-ndjson" });
      if (!cancelled) res.write(`${JSON.stringify({ type: "error", message: "Image processing failed" })}\n`);
      console.warn("Media processing failed:", error instanceof Error ? error.message : String(error));
    } finally { busy = false; res.end(); req.resume(); }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  return server;
}

export function closeMediaServer(server, { timeoutMs = 5_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    return Promise.reject(new Error("invalid media shutdown timeout"));
  }
  return new Promise((resolveClose, rejectClose) => {
    let settled = false;
    let timer;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectClose(error);
      else resolveClose();
    };
    try {
      server.close((error) => settle(error));
      server.closeIdleConnections?.();
      timer = setTimeout(() => {
        settle(new Error("media server shutdown timed out"));
        try {
          server.closeAllConnections?.();
        } catch {
          // Timeout is already reported; allow the parent supervisor to kill
          // the process if Node cannot forcibly close its remaining sockets.
        }
      }, timeoutMs);
      if (settled) clearTimeout(timer);
    } catch (error) {
      settle(error);
    }
  });
}

export function registerMediaShutdown(
  server,
  {
    signalSource = process,
    logger = console,
    setExitCode = (code) => { process.exitCode = code; },
    timeoutMs = 5_000,
  } = {}
) {
  let shutdownPromise;
  const shutdown = () => {
    if (!shutdownPromise) {
      shutdownPromise = closeMediaServer(server, { timeoutMs }).catch(() => {
        logger.error?.("media processing runtime shutdown failed");
        setExitCode(1);
      });
    }
    return shutdownPromise;
  };
  signalSource.once("SIGTERM", () => { void shutdown(); });
  signalSource.once("SIGINT", () => { void shutdown(); });
  return shutdown;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MEDIA_PROCESSING_PORT || 8091);
  const host = process.env.MEDIA_PROCESSING_HOST || "127.0.0.1";
  const server = createMediaServer();
  server.listen(port, host, () => console.log(`Media processing runtime listening on ${host}:${port}`));
  registerMediaShutdown(server);
}
