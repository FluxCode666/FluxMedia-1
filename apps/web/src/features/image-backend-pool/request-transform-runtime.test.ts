/**
 * API 请求处理 QuickJS 沙箱测试。
 *
 * 锁定同步转换、脱敏上下文、CPU/输出限制、非法返回和宿主媒体令牌完整性。
 */
import { describe, expect, it } from "vitest";

import {
  ApiRequestTransformError,
  applyApiRequestTransformScript,
  createApiRequestOpaqueToken,
  validateApiRequestTransformScript,
} from "./request-transform-runtime";

const context = {
  operation: "videos.generate",
  contentType: "application/json",
  platformModelId: "seedance2",
  upstreamModelId: "seedande-2.0",
} as const;

describe("API request transform runtime", () => {
  it("转换请求字段且只能读取脱敏上下文", async () => {
    await expect(
      applyApiRequestTransformScript(
        { model: "seedande-2.0", aspect_ratio: "16:9" },
        `request.ratio = request.aspect_ratio;
delete request.aspect_ratio;
request.operation = context.operation;
request.hostAccess = [typeof process, typeof require, typeof fetch];
return request;`,
        context
      )
    ).resolves.toEqual({
      model: "seedande-2.0",
      ratio: "16:9",
      operation: "videos.generate",
      hostAccess: ["undefined", "undefined", "undefined"],
    });
  });

  it("支持 Skill 推荐的 Object.hasOwn 枚举判断", async () => {
    await expect(
      applyApiRequestTransformScript(
        { resolution: "720p" },
        `const resolutionMap = { "720p": "hd" };
if (Object.hasOwn(resolutionMap, request.resolution)) {
  request.resolution = resolutionMap[request.resolution];
}
return request;`,
        context
      )
    ).resolves.toEqual({ resolution: "hd" });
  });

  it("执行 Skill 生成的视频映射并保留十二张嵌套参考图", async () => {
    const tokens = Array.from({ length: 12 }, () =>
      createApiRequestOpaqueToken()
    );
    const referenceImages = tokens.map(
      (_token, index) => `data:image/png;base64,cmVmZXJlbmNlLTI${index}`
    );
    const opaqueValues = new Map(
      tokens.map((token, index) => [token, referenceImages[index]])
    );
    const script = `if (context.operation === "videos.generate") {
  request.duration_ms = Math.round(request.duration * 1000);
  delete request.duration;
  const ratioMap = { "16:9": "16x9" };
  if (!Object.hasOwn(ratioMap, request.aspect_ratio)) {
    throw new Error("Unsupported aspect ratio");
  }
  request.ratio = ratioMap[request.aspect_ratio];
  delete request.aspect_ratio;
  const qualityMap = { "1080p": "fhd" };
  if (!Object.hasOwn(qualityMap, request.resolution)) {
    throw new Error("Unsupported resolution");
  }
  request.quality = qualityMap[request.resolution];
  delete request.resolution;
  request.audio = { enabled: request.generate_audio };
  delete request.generate_audio;
  request.inputs = { references: request.reference_images };
  delete request.reference_images;
}
return request;`;

    await expect(
      applyApiRequestTransformScript(
        {
          client_request_id: "request-1",
          prompt: "ocean",
          model: "seedande-2.0",
          duration: 10,
          aspect_ratio: "16:9",
          resolution: "1080p",
          generate_audio: true,
          reference_images: tokens,
        },
        script,
        context,
        opaqueValues
      )
    ).resolves.toEqual({
      client_request_id: "request-1",
      prompt: "ocean",
      model: "seedande-2.0",
      duration_ms: 10_000,
      ratio: "16x9",
      quality: "fhd",
      audio: { enabled: true },
      inputs: { references: referenceImages },
    });
  });

  it("保存前拒绝语法非法脚本", async () => {
    await expect(
      validateApiRequestTransformScript("if (")
    ).rejects.toBeInstanceOf(ApiRequestTransformError);
  });

  it("中断无限循环并返回稳定错误", async () => {
    await expect(
      applyApiRequestTransformScript(
        { model: "seedande-2.0" },
        "while (true) {}",
        context
      )
    ).rejects.toMatchObject({
      code: "execution_failed",
      message: "API 账号请求处理脚本执行失败",
    });
  });

  it.each([
    "return null;",
    "return [];",
    "return Promise;",
  ])("拒绝非法脚本输出：%s", async (script) => {
    await expect(
      applyApiRequestTransformScript({ model: "seedande-2.0" }, script, context)
    ).rejects.toBeInstanceOf(ApiRequestTransformError);
  });

  it("拒绝异步返回和通过构造器恢复动态代码执行", async () => {
    await expect(
      applyApiRequestTransformScript(
        { model: "seedande-2.0" },
        "return (async () => request)();",
        context
      )
    ).rejects.toMatchObject({ code: "execution_failed" });
    await expect(
      applyApiRequestTransformScript(
        { model: "seedande-2.0" },
        "request.dynamicCode = (() => {}).constructor; return request;",
        context
      )
    ).resolves.toEqual({
      model: "seedande-2.0",
    });
  });

  it("移除时间与随机数等非确定性能力", async () => {
    await expect(
      applyApiRequestTransformScript(
        { model: "seedande-2.0" },
        `request.hostAccess = [typeof Date, typeof Math.random];
return request;`,
        context
      )
    ).resolves.toEqual({
      model: "seedande-2.0",
      hostAccess: ["undefined", "undefined"],
    });
  });

  it("允许移动宿主媒体令牌并在返回前恢复真实值", async () => {
    const token = createApiRequestOpaqueToken();
    const opaqueValues = new Map<string, unknown>([
      [token, "data:image/png;base64,c2FmZQ=="],
    ]);
    await expect(
      applyApiRequestTransformScript(
        { first_frame: token },
        `request.start_image = request.first_frame;
delete request.first_frame;
return request;`,
        context,
        opaqueValues
      )
    ).resolves.toEqual({
      start_image: "data:image/png;base64,c2FmZQ==",
    });
  });

  it.each([
    "delete request.first_frame; return request;",
    "request.copy = request.first_frame; return request;",
    'request.first_frame = "__fluxmedia_opaque_forged"; return request;',
  ])("拒绝丢失、复制或伪造媒体令牌", async (script) => {
    const token = createApiRequestOpaqueToken();
    await expect(
      applyApiRequestTransformScript(
        { first_frame: token },
        script,
        context,
        new Map([[token, "data:image/png;base64,c2FmZQ=="]])
      )
    ).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("没有宿主媒体时允许请求正文包含令牌前缀普通文本", async () => {
    await expect(
      applyApiRequestTransformScript(
        { prompt: "__fluxmedia_opaque_literal" },
        "return request;",
        context
      )
    ).resolves.toEqual({ prompt: "__fluxmedia_opaque_literal" });
  });
});
