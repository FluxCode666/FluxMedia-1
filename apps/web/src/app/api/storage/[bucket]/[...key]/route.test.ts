/**
 * 存储对象读取路由的 DB-free 单测
 *
 * 覆盖：桶白名单、路径穿越拒绝、正常读取、404/502 错误映射、
 * 签名验证（generations 桶需要 sig+exp，三个严格公共资产域允许匿名访问）。
 */

import type { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// 模拟存储 provider，使该路由测试保持 DB-free（不触达 @repo/database / runtime settings）。
const getObject = vi.fn();
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: vi.fn(async () => ({ getObject })),
}));

// 静音日志，避免 502 路径打印噪声，同时验证基础设施故障会被记录。
const logError = vi.hoisted(() => vi.fn());
vi.mock("@repo/shared/logger", () => ({ logError }));

// 第一方会话回退鉴权的依赖:getCurrentUser(会话)与 db(按 storage_key 查归属)。
// 保持 DB-free:getCurrentUser/db 均被 mock;正常签名校验通过的用例不会触达它们。
const {
  getCurrentUser,
  dbState,
  runtimeSettings,
  getRuntimeStorageBucketConfig,
} = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  dbState: { rows: [] as Array<{ userId: string | null }> },
  runtimeSettings: new Map<string, string>(),
  getRuntimeStorageBucketConfig: vi.fn(async () => {
    const systemAssets =
      runtimeSettings.get("SYSTEM_ASSETS_BUCKET_NAME") ?? "system";
    const generations =
      runtimeSettings.get("GENERATIONS_BUCKET_NAME") ?? "generations";
    const isValidBucket = (bucket: string) =>
      /^[A-Za-z0-9._-]{1,255}$/.test(bucket) &&
      bucket !== "." &&
      bucket !== ".." &&
      bucket !== "_avatars";
    if (
      !isValidBucket(systemAssets) ||
      !isValidBucket(generations) ||
      systemAssets === generations
    ) {
      throw new Error("Storage bucket configuration invalid");
    }
    return { systemAssets, generations };
  }),
}));
vi.mock("@repo/shared/auth/server", () => ({ getCurrentUser }));
vi.mock("@repo/database", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => dbState.rows }),
      }),
    }),
  },
}));
vi.mock("@repo/database/schema", () => ({
  generation: { userId: "userId", storageKey: "storageKey" },
  videoGeneration: { userId: "userId", storageKey: "storageKey" },
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeStorageBucketConfig,
}));

import { generateSignedImageParams } from "@repo/shared/storage/signed-url";
import { GET } from "./route";

const TEST_SECRET = "test-secret-for-storage-route-tests";
const SYSTEM_ASSET_BUCKET = "system-assets";
const MODEL_ASSET_BUCKET = SYSTEM_ASSET_BUCKET;
const MODEL_CONFIG_HASH = "a".repeat(64);
const MODEL_CONTENT_HASH = "b".repeat(64);
const MODEL_IMAGE_KEY = `image/${MODEL_CONFIG_HASH}/${MODEL_CONTENT_HASH}.webp`;
const SITE_ASSET_BUCKET = SYSTEM_ASSET_BUCKET;
const SITE_LOGO_HASH = "c".repeat(64);
const SITE_LOGO_KEY = `logo/${SITE_LOGO_HASH}.png`;

// 构造 Next.js App Router 动态路由约定的 params Promise。
function makeParams(bucket: string, key: string[]) {
  return { params: Promise.resolve({ bucket, key }) };
}

/**
 * 构造带 nextUrl.searchParams 的 NextRequest 模拟对象。
 * avatars 桶不需要签名；generations 桶需要 sig+exp。
 *
 * @param searchParams - 可选查询参数。
 * @param pathname - 用于验证重定向 Location 的请求路径。
 * @returns 满足读取 Route 所需字段的 NextRequest 测试替身。
 */
function makeRequest(
  searchParams?: Record<string, string>,
  pathname = "/api/storage/avatars/test.png"
): NextRequest {
  const params = new URLSearchParams(searchParams);
  return {
    url: `http://localhost${pathname}${params.size > 0 ? `?${params}` : ""}`,
    nextUrl: {
      searchParams: params,
    },
    // 读取路由会把 request.signal 透传给 getObject(取消传播),并在缩略图路径读取
    // signal.aborted;提供一个未中止的 AbortSignal 占位,避免读取 undefined.aborted。
    signal: { aborted: false } as AbortSignal,
  } as unknown as NextRequest;
}

/**
 * 构造带有效签名参数的请求。
 */
function makeSignedRequest(bucket: string, key: string): NextRequest {
  const { sig, exp } = generateSignedImageParams(bucket, key);
  return makeRequest({ sig, exp: String(exp) });
}

describe("GET /api/storage/[bucket]/[...key]", () => {
  const originalSecret = process.env.BETTER_AUTH_SECRET;

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = TEST_SECRET;
    getObject.mockReset();
    logError.mockReset();
    // 默认:无会话(签名失败即 403),归属查询返回空。各用例按需覆盖。
    getCurrentUser.mockReset();
    getCurrentUser.mockResolvedValue(null);
    dbState.rows = [];
    runtimeSettings.clear();
    runtimeSettings.set("SYSTEM_ASSETS_BUCKET_NAME", SYSTEM_ASSET_BUCKET);
    runtimeSettings.set("GENERATIONS_BUCKET_NAME", "generations");
    getRuntimeStorageBucketConfig.mockClear();
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env.BETTER_AUTH_SECRET;
    } else {
      process.env.BETTER_AUTH_SECRET = originalSecret;
    }
  });

  it("拒绝非白名单桶（403 且不访问对象）", async () => {
    const res = await GET(makeRequest(), makeParams("secrets", ["a.png"]));
    expect(res.status).toBe(403);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("允许读取运行时设置中的自定义 generations 桶", async () => {
    runtimeSettings.set("GENERATIONS_BUCKET_NAME", "minio-generations");
    getObject.mockResolvedValue(Buffer.from("png-bytes"));

    const res = await GET(
      makeSignedRequest("minio-generations", "user-123/abc.png"),
      makeParams("minio-generations", ["user-123", "abc.png"])
    );

    expect(res.status).toBe(200);
    expect(getObject).toHaveBeenCalledWith(
      "user-123/abc.png",
      "minio-generations",
      { signal: expect.anything() }
    );
  });

  it("拒绝路径穿越的 key（400）", async () => {
    const res = await GET(
      makeSignedRequest("generations", "../etc/passwd"),
      makeParams("generations", ["..", "etc", "passwd"])
    );
    expect(res.status).toBe(400);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("拒绝含反斜杠的 key（400）", async () => {
    const res = await GET(
      makeSignedRequest("generations", "a\\b.png"),
      makeParams("generations", ["a\\b.png"])
    );
    expect(res.status).toBe(400);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("拒绝以斜杠开头的 key（400）", async () => {
    const res = await GET(
      makeSignedRequest("generations", "/abs.png"),
      makeParams("generations", ["", "abs.png"])
    );
    expect(res.status).toBe(400);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("拒绝空 key（400）", async () => {
    const res = await GET(
      makeSignedRequest("generations", ""),
      makeParams("generations", [""])
    );
    expect(res.status).toBe(400);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("generations 桶缺少签名返回 403", async () => {
    const res = await GET(
      makeRequest(),
      makeParams("generations", ["user-123", "abc.png"])
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Missing signature");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(getObject).not.toHaveBeenCalled();
  });

  it("generations 桶签名过期返回 403", async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 100;
    const { sig } = generateSignedImageParams(
      "generations",
      "user-123/abc.png"
    );
    const res = await GET(
      makeRequest({ sig, exp: String(pastExp) }),
      makeParams("generations", ["user-123", "abc.png"])
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Signature expired");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(getObject).not.toHaveBeenCalled();
  });

  it("generations 桶签名无效返回 403", async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const res = await GET(
      makeRequest({ sig: "a".repeat(64), exp: String(futureExp) }),
      makeParams("generations", ["user-123", "abc.png"])
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Invalid signature");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(getObject).not.toHaveBeenCalled();
  });

  it("generations 桶有效签名返回图片字节、正确 content-type 与长缓存", async () => {
    getObject.mockResolvedValue(Buffer.from("png-bytes"));
    const res = await GET(
      makeSignedRequest("generations", "user-123/abc.png"),
      makeParams("generations", ["user-123", "abc.png"])
    );
    expect(res.status).toBe(200);
    expect(getObject).toHaveBeenCalledWith("user-123/abc.png", "generations", {
      signal: expect.anything(),
    });
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(res.headers.get("Content-Length")).toBe("9");
    // 图片白名单扩展不应被强制下载。
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("png-bytes");
  });

  it("签名缺失但第一方会话且归属本人 → 放行(回退鉴权,200)", async () => {
    // 浏览器同源请求带 cookie:即便没有/过期签名,拥有该图的登录用户也能读自己的图。
    getCurrentUser.mockResolvedValue({ id: "user-123" });
    dbState.rows = [{ userId: "user-123" }];
    getObject.mockResolvedValue(Buffer.from("png-bytes"));
    const res = await GET(
      makeRequest(),
      makeParams("generations", ["user-123", "abc.png"])
    );
    expect(res.status).toBe(200);
    expect(getObject).toHaveBeenCalledWith("user-123/abc.png", "generations", {
      signal: expect.anything(),
    });
  });

  it("签名缺失且会话用户非归属人 → 403(杜绝越权 IDOR)", async () => {
    getCurrentUser.mockResolvedValue({ id: "intruder" });
    dbState.rows = [{ userId: "owner-1" }];
    const res = await GET(
      makeRequest(),
      makeParams("generations", ["owner-1", "abc.png"])
    );
    expect(res.status).toBe(403);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("avatars 桶无需签名即可公开访问", async () => {
    getObject.mockResolvedValue(Buffer.from("avatar-bytes"));
    const res = await GET(
      makeRequest(),
      makeParams(SYSTEM_ASSET_BUCKET, ["avatars", "user-9-profile.jpg"])
    );
    expect(res.status).toBe(200);
    expect(getObject).toHaveBeenCalledWith(
      "avatars/user-9-profile.jpg",
      SYSTEM_ASSET_BUCKET,
      { signal: expect.anything() }
    );
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("头像、模型封面和网站 Logo 可共用系统公开资产 bucket", async () => {
    runtimeSettings.set("SYSTEM_ASSETS_BUCKET_NAME", SYSTEM_ASSET_BUCKET);
    getObject.mockResolvedValue(Buffer.from("public-asset"));

    const avatarResponse = await GET(
      makeRequest(),
      makeParams(SYSTEM_ASSET_BUCKET, ["avatars", "user-9-123.jpg"])
    );
    const avatarAliasResponse = await GET(
      makeRequest(undefined, "/api/storage/_avatars/avatars/user-10-456.jpg"),
      makeParams("_avatars", ["avatars", "user-10-456.jpg"])
    );
    const modelResponse = await GET(
      makeRequest(),
      makeParams(SYSTEM_ASSET_BUCKET, MODEL_IMAGE_KEY.split("/"))
    );
    const logoResponse = await GET(
      makeRequest(),
      makeParams(SYSTEM_ASSET_BUCKET, SITE_LOGO_KEY.split("/"))
    );
    const legacyAvatarResponse = await GET(
      makeRequest(),
      makeParams(SYSTEM_ASSET_BUCKET, ["user-9-123.jpg"])
    );
    const unknownResponse = await GET(
      makeRequest(),
      makeParams(SYSTEM_ASSET_BUCKET, ["uploads", "private.json"])
    );
    const aliasUnknownResponse = await GET(
      makeRequest(),
      makeParams("_avatars", ["uploads", "private.json"])
    );
    const aliasModelResponse = await GET(
      makeRequest(),
      makeParams("_avatars", MODEL_IMAGE_KEY.split("/"))
    );
    const modelThumbResponse = await GET(
      makeRequest({ w: "128" }),
      makeParams(SYSTEM_ASSET_BUCKET, MODEL_IMAGE_KEY.split("/"))
    );

    expect(avatarResponse.status).toBe(200);
    expect(avatarResponse.headers.get("Content-Type")).toBe("image/jpeg");
    expect(avatarAliasResponse.status).toBe(307);
    expect(avatarAliasResponse.headers.get("Location")).toBe(
      `http://localhost/api/storage/${SYSTEM_ASSET_BUCKET}/avatars/user-10-456.jpg`
    );
    expect(avatarAliasResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(modelResponse.status).toBe(200);
    expect(modelResponse.headers.get("Content-Type")).toBe("image/webp");
    expect(logoResponse.status).toBe(200);
    expect(logoResponse.headers.get("Content-Type")).toBe("image/png");
    expect(legacyAvatarResponse.status).toBe(200);
    expect(unknownResponse.status).toBe(400);
    expect(aliasUnknownResponse.status).toBe(400);
    expect(aliasModelResponse.status).toBe(400);
    expect(modelThumbResponse.status).toBe(400);
    expect(getObject).toHaveBeenNthCalledWith(
      1,
      "avatars/user-9-123.jpg",
      SYSTEM_ASSET_BUCKET,
      { signal: expect.anything() }
    );
    expect(getObject).toHaveBeenNthCalledWith(
      2,
      MODEL_IMAGE_KEY,
      SYSTEM_ASSET_BUCKET,
      { signal: expect.anything() }
    );
    expect(getObject).toHaveBeenNthCalledWith(
      3,
      SITE_LOGO_KEY,
      SYSTEM_ASSET_BUCKET,
      { signal: expect.anything() }
    );
    expect(getObject).toHaveBeenNthCalledWith(
      4,
      "user-9-123.jpg",
      SYSTEM_ASSET_BUCKET,
      { signal: expect.anything() }
    );
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(getObject).toHaveBeenCalledTimes(4);
  });

  it("头像逻辑别名在同一进程内跟随运行时 bucket 切换", async () => {
    runtimeSettings.set("SYSTEM_ASSETS_BUCKET_NAME", "assets-before");

    const beforeResponse = await GET(
      makeRequest(undefined, "/api/storage/_avatars/user-10-456.jpg"),
      makeParams("_avatars", ["user-10-456.jpg"])
    );

    runtimeSettings.set("SYSTEM_ASSETS_BUCKET_NAME", "assets-after");
    const afterResponse = await GET(
      makeRequest(undefined, "/api/storage/_avatars/user-10-456.jpg"),
      makeParams("_avatars", ["user-10-456.jpg"])
    );

    expect(beforeResponse.status).toBe(307);
    expect(beforeResponse.headers.get("Location")).toBe(
      "http://localhost/api/storage/assets-before/user-10-456.jpg"
    );
    expect(afterResponse.status).toBe(307);
    expect(afterResponse.headers.get("Location")).toBe(
      "http://localhost/api/storage/assets-after/user-10-456.jpg"
    );
    expect(beforeResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(afterResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(getObject).not.toHaveBeenCalled();
  });

  it("模型与网站资产共桶时按 key 命名空间选择唯一校验器", async () => {
    runtimeSettings.set("SYSTEM_ASSETS_BUCKET_NAME", SYSTEM_ASSET_BUCKET);
    getObject.mockResolvedValue(Buffer.from("public-asset"));

    const modelResponse = await GET(
      makeRequest(),
      makeParams(SYSTEM_ASSET_BUCKET, MODEL_IMAGE_KEY.split("/"))
    );
    const logoResponse = await GET(
      makeRequest(),
      makeParams(SYSTEM_ASSET_BUCKET, SITE_LOGO_KEY.split("/"))
    );
    const unknownResponse = await GET(
      makeRequest(),
      makeParams(SYSTEM_ASSET_BUCKET, ["unknown", "asset.png"])
    );

    expect(modelResponse.status).toBe(200);
    expect(logoResponse.status).toBe(200);
    expect(unknownResponse.status).toBe(400);
    expect(getObject).toHaveBeenCalledTimes(2);
  });

  it("模型资产桶无需签名即可读取严格内容寻址 WebP", async () => {
    getObject.mockResolvedValue(Buffer.from("model-cover"));

    const res = await GET(
      makeRequest(),
      makeParams(MODEL_ASSET_BUCKET, MODEL_IMAGE_KEY.split("/"))
    );

    expect(res.status).toBe(200);
    expect(getObject).toHaveBeenCalledWith(
      MODEL_IMAGE_KEY,
      MODEL_ASSET_BUCKET,
      { signal: expect.anything() }
    );
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(res.headers.get("CDN-Cache-Control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });

  it("每次读取加载统一运行时 bucket 配置", async () => {
    getObject.mockResolvedValue(Buffer.from("avatar"));

    await GET(
      makeRequest(),
      makeParams(SYSTEM_ASSET_BUCKET, ["avatars", "user-avatar.jpg"])
    );

    expect(getRuntimeStorageBucketConfig).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["非 WebP", `image/${MODEL_CONFIG_HASH}/${MODEL_CONTENT_HASH}.png`],
    ["非哈希", "image/custom/cover.webp"],
    ["额外层级", `${MODEL_IMAGE_KEY}/extra`],
    [
      "大写哈希",
      `image/${MODEL_CONFIG_HASH.toUpperCase()}/${MODEL_CONTENT_HASH}.webp`,
    ],
    ["未知类别", `audio/${MODEL_CONFIG_HASH}/${MODEL_CONTENT_HASH}.webp`],
  ])("模型资产桶拒绝%s key", async (_label, fileKey) => {
    const res = await GET(
      makeRequest(),
      makeParams(MODEL_ASSET_BUCKET, fileKey.split("/"))
    );

    expect(res.status).toBe(400);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("模型资产桶拒绝路径段与查询参数两种缩略图请求", async () => {
    const pathResponse = await GET(
      makeRequest(),
      makeParams(MODEL_ASSET_BUCKET, ["w128", ...MODEL_IMAGE_KEY.split("/")])
    );
    const queryResponse = await GET(
      makeRequest({ w: "128" }),
      makeParams(MODEL_ASSET_BUCKET, MODEL_IMAGE_KEY.split("/"))
    );

    expect(pathResponse.status).toBe(400);
    expect(queryResponse.status).toBe(400);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("网站资产设置缺失时从默认 bucket 匿名读取严格 Logo PNG", async () => {
    runtimeSettings.delete("SYSTEM_ASSETS_BUCKET_NAME");
    getObject.mockResolvedValue(Buffer.from("site-logo"));

    const res = await GET(
      makeRequest(),
      makeParams("system", SITE_LOGO_KEY.split("/"))
    );

    expect(res.status).toBe(200);
    expect(getObject).toHaveBeenCalledWith(SITE_LOGO_KEY, "system", {
      signal: expect.anything(),
    });
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });

  it("网站资产桶支持运行时自定义名称", async () => {
    runtimeSettings.set("SYSTEM_ASSETS_BUCKET_NAME", "brand-assets");
    getObject.mockResolvedValue(Buffer.from("site-logo"));

    const res = await GET(
      makeRequest(),
      makeParams("brand-assets", SITE_LOGO_KEY.split("/"))
    );

    expect(res.status).toBe(200);
    expect(getObject).toHaveBeenCalledWith(SITE_LOGO_KEY, "brand-assets", {
      signal: expect.anything(),
    });
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it.each([
    ["svg", "image/svg+xml", true],
    ["ico", "image/x-icon", false],
  ])("网站资产桶按原扩展名返回 %s", async (extension, contentType, isSvg) => {
    const fileKey = `logo/${SITE_LOGO_HASH}.${extension}`;
    getObject.mockResolvedValue(Buffer.from("site-logo"));

    const res = await GET(
      makeRequest(),
      makeParams(SITE_ASSET_BUCKET, fileKey.split("/"))
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(contentType);
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toBe(
      isSvg ? "default-src 'none'; sandbox" : null
    );
  });

  it.each([
    ["非 PNG", `logo/${SITE_LOGO_HASH}.webp`],
    ["大写哈希", `logo/${SITE_LOGO_HASH.toUpperCase()}.png`],
    ["非哈希", "logo/current.png"],
    ["错误目录", `${SITE_LOGO_HASH}.png`],
    ["额外层级", `logo/archive/${SITE_LOGO_HASH}.png`],
    ["路径穿越", `logo/../${SITE_LOGO_HASH}.png`],
  ])("网站资产桶拒绝%s key", async (_label, fileKey) => {
    const res = await GET(
      makeRequest(),
      makeParams(SITE_ASSET_BUCKET, fileKey.split("/"))
    );

    expect(res.status).toBe(400);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("网站资产桶拒绝路径段与查询参数两种缩略图请求", async () => {
    const pathResponse = await GET(
      makeRequest(),
      makeParams(SITE_ASSET_BUCKET, ["w128", ...SITE_LOGO_KEY.split("/")])
    );
    const queryResponse = await GET(
      makeRequest({ w: "128" }),
      makeParams(SITE_ASSET_BUCKET, SITE_LOGO_KEY.split("/"))
    );

    expect(pathResponse.status).toBe(400);
    expect(queryResponse.status).toBe(400);
    expect(pathResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(queryResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(getObject).not.toHaveBeenCalled();
  });

  it.each([
    ["系统资产桶为空", "", "generations"],
    ["生成内容桶为空", "system", ""],
    ["系统资产桶使用保留逻辑别名", "_avatars", "generations"],
    ["系统资产桶含路径", "../system", "generations"],
    ["系统资产与生成内容冲突", "shared", "shared"],
  ])("%s时稳定返回配置错误且不触达存储", async (_label, systemAssets, generations) => {
    runtimeSettings.set("SYSTEM_ASSETS_BUCKET_NAME", systemAssets);
    runtimeSettings.set("GENERATIONS_BUCKET_NAME", generations);

    const res = await GET(
      makeRequest(),
      makeParams(generations, ["user", "private.png"])
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "Storage bucket configuration invalid",
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(logError).toHaveBeenCalledWith(expect.any(Error), {
      source: "storage-bucket-config",
    });
    expect(getObject).not.toHaveBeenCalled();
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("未知扩展回退 octet-stream 并以附件下载（防内容嗅探/存储型 XSS）", async () => {
    getObject.mockResolvedValue(Buffer.from("<svg/>"));
    const res = await GET(
      makeRequest(),
      makeParams(SYSTEM_ASSET_BUCKET, ["avatars", "user-9-evil.svg"])
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
  });

  it("对象不存在（ENOENT）映射为 404 且不记录基础设施错误", async () => {
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
    getObject.mockRejectedValue(enoent);
    const res = await GET(
      makeSignedRequest("generations", "user-1/missing.png"),
      makeParams("generations", ["user-1", "missing.png"])
    );
    expect(res.status).toBe(404);
    expect(logError).not.toHaveBeenCalled();
  });

  it("S3 缺键（NoSuchKey）映射为 404", async () => {
    const noSuchKey = Object.assign(new Error("not found"), {
      name: "NoSuchKey",
    });
    getObject.mockRejectedValue(noSuchKey);
    const res = await GET(
      makeSignedRequest("generations", "user-1/missing.png"),
      makeParams("generations", ["user-1", "missing.png"])
    );
    expect(res.status).toBe(404);
    expect(logError).not.toHaveBeenCalled();
  });

  it("缩略图宽度走路径段 /w<width>/:验签前剥离宽度段,getObject 用真实 key", async () => {
    // 签名只覆盖真实 key(不含 w128 段);URL 路径首段是 w128。
    // 验证:剥离宽度段后用真实 key 验签通过(非 403)、getObject 收到真实 key。
    // 注:sharp 对非图片字节缩放会失败并回退返回原图(本测试不关心缩放结果)。
    getObject.mockResolvedValue(Buffer.from("png-bytes"));
    const { sig, exp } = generateSignedImageParams(
      "generations",
      "user-123/abc.png"
    );
    const res = await GET(
      makeRequest({ sig, exp: String(exp) }),
      makeParams("generations", ["w128", "user-123", "abc.png"])
    );
    expect(res.status).toBe(200);
    expect(getObject).toHaveBeenCalledWith("user-123/abc.png", "generations", {
      signal: expect.anything(),
    });
  });

  it("路径宽度段用错误 key 的签名仍 403(宽度段不能绕过鉴权)", async () => {
    // 用 "其它/key.png" 的签名去访问 "user-123/abc.png",即便带 w128 段也应 403。
    const { sig, exp } = generateSignedImageParams(
      "generations",
      "other/key.png"
    );
    const res = await GET(
      makeRequest({ sig, exp: String(exp) }),
      makeParams("generations", ["w128", "user-123", "abc.png"])
    );
    expect(res.status).toBe(403);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("基础设施故障映射为 502 并记日志（不静默吞成 404）", async () => {
    getObject.mockRejectedValue(new Error("存储配置缺失"));
    const res = await GET(
      makeSignedRequest("generations", "user-1/abc.png"),
      makeParams("generations", ["user-1", "abc.png"])
    );
    expect(res.status).toBe(502);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
