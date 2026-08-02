/**
 * API 上游响应脚本宿主边界测试。
 *
 * 职责：用真实 QuickJS Worker 验证大 Base64 图片不进入普通 JSON 预算，且响应
 * 脚本只能移动宿主令牌；测试不访问数据库、网络或真实供应商。
 */
import { afterAll, describe, expect, it } from "vitest";

import { ApiUpstreamOpaqueValueError } from "./api-upstream-opaque-values";
import { parseApiUpstreamScriptedResponse } from "./api-upstream-response";
import { shutdownApiUpstreamScriptPool } from "./api-upstream-script-pool";
import { reserveApiUpstreamResponsePermit } from "./api-upstream-script-runtime";

const responseContext = {
  operation: "images.generate",
  stage: "response",
  contentType: "application/json",
  platformModelId: "gpt-image-2",
  upstreamModelId: "vendor-image",
} as const;

describe("API upstream scripted response", () => {
  afterAll(async () => {
    await shutdownApiUpstreamScriptPool();
  });

  it("在 Worker 外令牌化超过 2 MiB 的嵌套 Base64 图片", async () => {
    const firstImage = "A".repeat(2 * 1024 * 1024 + 1);
    const secondImage = `data:image/png;base64,${"B".repeat(1024)}`;
    const thirdImage = Buffer.from(
      "89504e470d0a1a0a0000000d49484452",
      "hex"
    ).toString("base64");
    const permit = await reserveApiUpstreamResponsePermit();

    const parsed = await parseApiUpstreamScriptedResponse({
      operation: "images.generate",
      permit,
      response: new Response(
        JSON.stringify({
          result: {
            images: [
              { b64_json: firstImage },
              { payload: secondImage },
              { unknown_vendor_field: thirdImage },
            ],
          },
        }),
        { headers: { "Content-Type": "application/json" } }
      ),
      script: `
        return {
          status: "completed",
          outputs: response.body.result.images.map((image) => ({
            kind: "image",
            base64: image.b64_json ?? image.payload ?? image.unknown_vendor_field,
            mediaType: "image/png"
          }))
        };
      `,
      context: responseContext,
    });

    expect(parsed.result).toEqual({
      status: "completed",
      outputs: [
        { kind: "image", base64: firstImage, mediaType: "image/png" },
        { kind: "image", base64: secondImage, mediaType: "image/png" },
        { kind: "image", base64: thirdImage, mediaType: "image/png" },
      ],
    });
  });

  it.each([
    {
      name: "丢失",
      script: `return { status: "completed", outputs: [{
        kind: "image", url: "https://example.com/result.png"
      }] };`,
    },
    {
      name: "复制",
      script: `const media = response.body.b64_json;
        return { status: "completed", outputs: [
          { kind: "image", base64: media },
          { kind: "image", base64: media }
        ] };`,
    },
    {
      name: "伪造",
      script: `return { status: "completed", outputs: [{
        kind: "image", base64: "__fluxmedia_opaque_forged"
      }] };`,
    },
  ])("拒绝响应脚本令牌$name", async ({ script }) => {
    const permit = await reserveApiUpstreamResponsePermit();

    await expect(
      parseApiUpstreamScriptedResponse({
        operation: "images.generate",
        permit,
        response: new Response('{"b64_json":"c2FmZQ=="}', {
          headers: { "Content-Type": "application/json" },
        }),
        script,
        context: responseContext,
      })
    ).rejects.toBeInstanceOf(ApiUpstreamOpaqueValueError);
  });
});
