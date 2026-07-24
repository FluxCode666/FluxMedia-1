import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeSettingMock = vi.hoisted(() => vi.fn());
const storageMocks = vi.hoisted(() => {
  const putObject = vi.fn();
  const getSignedUrl = vi.fn();
  return {
    putObject,
    getSignedUrl,
    getStorageProvider: vi.fn(async () => ({
      putObject,
      getSignedUrl,
    })),
  };
});

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingString: runtimeSettingMock,
}));

vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: storageMocks.getStorageProvider,
}));

import {
  uploadTemporaryImageUrls,
  validateImageFile,
  validateMaskMatchesSourceImage,
} from "./request-utils";

/** 生成可供上传校验使用的最小测试图片。 */
async function createImageFile(
  width: number,
  height: number,
  name: string,
  type: "image/png" | "image/jpeg" = "image/png"
) {
  const image = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 30, g: 80, b: 140, alpha: 1 },
    },
  });
  const data =
    type === "image/png"
      ? await image.png().toBuffer()
      : await image.jpeg().toBuffer();
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);

  return new File([bytes], name, { type });
}

beforeEach(() => {
  storageMocks.putObject.mockReset();
  storageMocks.getSignedUrl.mockReset();
  storageMocks.getStorageProvider.mockClear();
  runtimeSettingMock.mockReset();
});

describe("uploadTemporaryImageUrls", () => {
  it("returns absolute signed URLs for temporary images", async () => {
    runtimeSettingMock.mockImplementation(async (key: string) => {
      if (key === "CONTENT_MODERATION_PUBLIC_BASE_URL") {
        return "https://app.example.test";
      }
      if (key === "NEXT_PUBLIC_GENERATIONS_BUCKET_NAME") {
        return "generations";
      }
      return "";
    });
    storageMocks.getSignedUrl.mockResolvedValue(
      "/api/storage/generations/user-1/requests/gen-1-0.png?sig=abc&exp=123"
    );

    const result = await uploadTemporaryImageUrls("user-1", "gen-1", [
      new File([new Uint8Array([1, 2, 3])], "source.png", {
        type: "image/png",
      }),
    ]);

    expect(storageMocks.putObject).toHaveBeenCalledWith(
      "user-1/requests/gen-1-0.png",
      "generations",
      Buffer.from([1, 2, 3]),
      "image/png"
    );
    expect(storageMocks.getSignedUrl).toHaveBeenCalledWith(
      "user-1/requests/gen-1-0.png",
      "generations",
      15 * 60
    );
    expect(result).toEqual([
      {
        bucket: "generations",
        key: "user-1/requests/gen-1-0.png",
        url: "https://app.example.test/api/storage/generations/user-1/requests/gen-1-0.png?sig=abc&exp=123",
      },
    ]);
  });

  it("keeps external presigned storage URLs unchanged", async () => {
    runtimeSettingMock.mockImplementation(async (key: string) => {
      if (key === "STORAGE_ENDPOINT") return "https://r2.example.test";
      if (key === "NEXT_PUBLIC_GENERATIONS_BUCKET_NAME") {
        return "generations";
      }
      return "";
    });
    storageMocks.getSignedUrl.mockResolvedValue(
      "https://r2.example.test/generations/user-1/requests/gen-1-0.jpg?X-Amz-Signature=abc"
    );

    const result = await uploadTemporaryImageUrls("user-1", "gen-1", [
      new File([new Uint8Array([1])], "source.jpg", {
        type: "image/jpeg",
      }),
    ]);

    expect(result?.[0]?.url).toBe(
      "https://r2.example.test/generations/user-1/requests/gen-1-0.jpg?X-Amz-Signature=abc"
    );
  });
});

describe("validateMaskMatchesSourceImage", () => {
  it("接受可解码且与第一张源图尺寸一致的 PNG 蒙版", async () => {
    const source = await createImageFile(64, 48, "source.jpg", "image/jpeg");
    const mask = await createImageFile(64, 48, "mask.png");

    await expect(validateMaskMatchesSourceImage(source, mask)).resolves.toBe(
      undefined
    );
  });

  it("拒绝 MIME 伪装为 PNG 的不可解码蒙版", async () => {
    const source = await createImageFile(64, 48, "source.png");
    const mask = new File(["not a png"], "mask.png", {
      type: "image/png",
    });

    await expect(validateMaskMatchesSourceImage(source, mask)).rejects.toThrow(
      "Mask must be a decodable image file."
    );
  });

  it("拒绝带有有效 PNG 元数据但像素数据损坏的蒙版", async () => {
    const source = await createImageFile(64, 48, "source.png");
    const validMask = await createImageFile(64, 48, "mask.png");
    const bytes = new Uint8Array(await validMask.arrayBuffer());
    bytes[70] = (bytes[70] ?? 0) ^ 0xff;
    const mask = new File([bytes], "mask.png", { type: "image/png" });

    await expect(validateMaskMatchesSourceImage(source, mask)).rejects.toThrow(
      "Mask must be a decodable image file."
    );
  });

  it("拒绝与第一张源图尺寸不同的蒙版", async () => {
    const source = await createImageFile(64, 48, "source.png");
    const mask = await createImageFile(48, 64, "mask.png");

    await expect(validateMaskMatchesSourceImage(source, mask)).rejects.toThrow(
      "Mask dimensions must match the first source image."
    );
  });

  it("蒙版仍然只接受 PNG MIME 类型", () => {
    const mask = new File([new Uint8Array([1])], "mask.jpg", {
      type: "image/jpeg",
    });

    expect(() => validateImageFile(mask, { mask: true })).toThrow(
      "Mask must be a PNG file."
    );
  });
});
