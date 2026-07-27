/**
 * 简易生图页请求契约测试。
 *
 * 职责：锁定文生图与图生图的 SSE、单图和输出默认参数，不执行真实媒体请求。
 */

import { describe, expect, it } from "vitest";

import {
  buildImageEditRequestBody,
  buildImageGenerateRequestBody,
} from "./image-create-request";

const common = {
  generationId: "generation-1",
  prompt: "一只猫",
  size: "1024x1024",
  model: "gpt-image-2",
  backendGroupId: "group-1",
  quality: "auto",
  background: "auto",
};

describe("image create request", () => {
  it("文生图恢复旧版 SSE 与稳定默认参数", () => {
    expect(buildImageGenerateRequestBody(common)).toEqual({
      ...common,
      stream: true,
      count: 1,
      moderation: "auto",
      output_format: "png",
      hd_repair: false,
      block_repair: false,
    });
  });

  it("图生图携带同一组默认参数、来源图和蒙版", () => {
    const image = new File(["image"], "image.png", { type: "image/png" });
    const mask = new File(["mask"], "mask.png", { type: "image/png" });
    const body = buildImageEditRequestBody({ ...common, images: [image], mask });

    expect(Object.fromEntries(body.entries())).toMatchObject({
      generationId: "generation-1",
      prompt: "一只猫",
      size: "1024x1024",
      model: "gpt-image-2",
      backendGroupId: "group-1",
      quality: "auto",
      background: "auto",
      moderation: "auto",
      output_format: "png",
      hd_repair: "false",
      block_repair: "false",
      count: "1",
      stream: "true",
      "image[]": image,
      mask,
    });
  });
});
