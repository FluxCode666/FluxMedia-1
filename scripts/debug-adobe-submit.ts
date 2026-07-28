import { db } from "@repo/database";
import { adobeToken } from "@repo/database/schema";
import {
  AdobeFireflyClient,
  buildFireflyImagePayloadCandidates,
  decodeJwtPayload,
  ProxyFireflyTransport,
  resolveFireflyImageModel,
} from "@repo/shared/adobe/firefly-direct";

async function main() {
  const transport = new ProxyFireflyTransport({
    proxyUrl: process.env.CHATGPT_WEB_PROXY_URL || "http://127.0.0.1:3021",
    sessionKey: "debug-submit",
    secret: process.env.CHATGPT_WEB_PROXY_SECRET?.trim() || "",
  });
  const [row] = await db
    .select()
    .from(adobeToken)
    .orderBy(adobeToken.createdAt)
    .limit(1);
  if (!row?.value) throw new Error("no token in db");
  const token = row.value;
  const claims = decodeJwtPayload(token);
  console.log("jwt claims keys:", Object.keys(claims));
  console.log("user_id:", claims.user_id || claims.sub || claims.aa_id);

  const model = resolveFireflyImageModel("gpt-image-2-2k-1x1");
  if (!model) throw new Error("model missing");
  const prompt = "a red apple on white background";
  const payloads = buildFireflyImagePayloadCandidates({
    prompt,
    aspectRatio: model.aspectRatio,
    outputResolution: model.outputResolution,
    upstreamModelId: model.upstreamModelId,
    upstreamModelVersion: model.upstreamModelVersion,
  });
  const client = new AdobeFireflyClient({ transport });
  const headers = (
    client as unknown as { submitHeaders: (t: string, p: string) => Record<string, string> }
  ).submitHeaders(token, prompt);
  console.log("x-nonce:", headers["x-nonce"] || "(empty)");
  console.log("payload keys:", Object.keys(payloads[0] || {}));

  const resp = await transport.request({
    method: "POST",
    url: "https://firefly-3p.ff.adobe.io/v2/3p-images/generate-async",
    headers,
    body: JSON.stringify(payloads[0]),
    timeoutMs: 60_000,
  });
  const text = await resp.text();
  console.log("status:", resp.status);
  console.log("x-access-error:", resp.headers["x-access-error"] || "(none)");
  console.log("body:", text.slice(0, 1000));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
