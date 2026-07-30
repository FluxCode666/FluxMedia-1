/**
 * 管理端单模型配置 multipart Route 测试。
 *
 * 测试以真实 Request/FormData 驱动薄适配器，并隔离 Better Auth、Origin 与 UOL，验证拒绝
 * 顺序、严格字段语义、封面字节转换、Principal 以及稳定错误响应。
 */
import {
  MAX_MODEL_MARKETPLACE_COVER_BYTES,
  type UpdateModelConfigurationEntryInput,
} from "@repo/shared/model-marketplace";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(),
  getUserRoleById: vi.fn(),
  getSession: vi.fn(),
  hasTrustedOrigin: vi.fn(),
  invokeOperation: vi.fn(),
}));

vi.mock("@repo/shared/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: mocks.getUserRoleById,
}));
vi.mock("@repo/shared/logger", () => ({
  logError: vi.fn(),
}));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
  OperationError: class OperationError extends Error {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    readonly httpStatus: number;

    /** 构造测试使用的稳定 UOL 错误。 */
    constructor(
      code: string,
      message: string,
      details?: Record<string, unknown>,
      httpStatus = 400
    ) {
      super(message);
      this.name = "OperationError";
      this.code = code;
      this.details = details;
      this.httpStatus = httpStatus;
    }
  },
}));
vi.mock("@/features/model-configuration/request-origin", () => ({
  hasTrustedModelConfigurationOrigin: mocks.hasTrustedOrigin,
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

import { OperationError } from "@repo/shared/uol";

import { MAX_MODEL_CONFIGURATION_MULTIPART_BYTES } from "@/features/model-configuration/bounded-multipart";

import { POST } from "./route";

const CLIENT_REQUEST_ID = "6b7d1204-3f43-4da7-b2b5-b7540927e462";

/** 构造图像价格公共字段。 */
function imagePricingFields(): Record<string, string> {
  return {
    base1024Credits: "1.27",
    base1kCredits: "1.27",
    base2kCredits: "5.07",
    base4kCredits: "10",
  };
}

/** 构造合法的图像显式价格表单字段。 */
function explicitImageFields(): Record<string, string> {
  return {
    category: "image",
    configKey: "gpt-image-2",
    expectedRevision: "2",
    clientRequestId: CLIENT_REQUEST_ID,
    visible: "true",
    homepageVisible: "true",
    homepagePriority: "3",
    description: "公开图像模型",
    coverChange: "keep",
    ...imagePricingFields(),
  };
}

/** 把标量字段和可选封面组装为浏览器同形 FormData。 */
function createFormData(
  fields: Record<string, string>,
  cover?: File
): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  if (cover) formData.append("cover", cover);
  return formData;
}

/** 构造带受信 Origin 的真实 multipart POST 请求。 */
function createMultipartRequest(formData: FormData): Request {
  return new Request("https://app.example.com/api/admin/model-configuration", {
    method: "POST",
    headers: { origin: "https://app.example.com" },
    body: formData,
  });
}

/** 构造会在正文被读取时记录 pull 的流式请求。 */
function createObservedStreamRequest(options: {
  contentLength?: string;
  onPull: () => void;
}): Request {
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        options.onPull();
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  const headers = new Headers({
    origin: "https://app.example.com",
    "content-type": "multipart/form-data; boundary=test",
  });
  if (options.contentLength !== undefined) {
    headers.set("content-length", options.contentLength);
  }
  return new Request("https://app.example.com/api/admin/model-configuration", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

/** 取得 UOL 收到并已完成契约收窄的保存输入。 */
function invokedInput(): UpdateModelConfigurationEntryInput {
  const call = mocks.invokeOperation.mock.calls[0];
  if (!call) throw new Error("预期模型配置 operation 已调用");
  return call[1] as UpdateModelConfigurationEntryInput;
}

describe("POST /api/admin/model-configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedOrigin.mockReturnValue(true);
    mocks.getSession.mockResolvedValue({
      user: { id: "super-admin-1" },
    });
    mocks.getUserRoleById.mockResolvedValue("super_admin");
    mocks.ensureUolInitialized.mockResolvedValue(undefined);
    mocks.invokeOperation.mockResolvedValue({
      category: "image",
      configKey: "gpt-image-2",
      revision: 3,
    });
  });

  it("Origin 失败时不鉴权、不读取正文且不调用 UOL", async () => {
    mocks.hasTrustedOrigin.mockReturnValue(false);
    const onPull = vi.fn();
    const request = createObservedStreamRequest({ onPull });

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(onPull).not.toHaveBeenCalled();
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it.each([
    "-1",
    "1.5",
    "NaN",
    "1x",
  ])("非法 Content-Length %s 在鉴权和正文读取前被拒绝", async (contentLength) => {
    const onPull = vi.fn();
    const request = createObservedStreamRequest({ contentLength, onPull });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(onPull).not.toHaveBeenCalled();
  });

  it("声明正文超限时在鉴权和正文读取前返回 413", async () => {
    const onPull = vi.fn();
    const request = createObservedStreamRequest({
      contentLength: String(MAX_MODEL_CONFIGURATION_MULTIPART_BYTES + 1),
      onPull,
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(onPull).not.toHaveBeenCalled();
  });

  it("未登录请求在正文读取前返回 401", async () => {
    mocks.getSession.mockResolvedValue(null);
    const onPull = vi.fn();
    const request = createObservedStreamRequest({ onPull });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(onPull).not.toHaveBeenCalled();
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it.each([
    "user",
    "observer_admin",
    "admin",
    "system",
  ])("角色 %s 不能通过早期 super_admin 预检", async (role) => {
    mocks.getSession.mockResolvedValue({ user: { id: "actor-1" } });
    mocks.getUserRoleById.mockResolvedValue(role);
    const onPull = vi.fn();
    const request = createObservedStreamRequest({ onPull });

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(mocks.getUserRoleById).toHaveBeenCalledWith("actor-1");
    expect(onPull).not.toHaveBeenCalled();
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("拒绝未知字段、重复标量和额外文件", async () => {
    const unknown = createFormData({
      ...explicitImageFields(),
      unexpected: "value",
    });
    const duplicate = createFormData(explicitImageFields());
    duplicate.append("visible", "false");
    const extraFile = createFormData(explicitImageFields());
    extraFile.append("avatar", new File(["x"], "avatar.webp"));

    for (const formData of [unknown, duplicate, extraFile]) {
      const response = await POST(createMultipartRequest(formData));
      expect(response.status).toBe(400);
    }
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("keep 与 remove 不接受封面文件", async () => {
    for (const coverChange of ["keep", "remove"]) {
      const response = await POST(
        createMultipartRequest(
          createFormData(
            { ...explicitImageFields(), coverChange },
            new File(["cover"], "cover.webp", { type: "image/webp" })
          )
        )
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("replace 要求且只允许一个不超过 5 MiB 的封面", async () => {
    const missing = createFormData({
      ...explicitImageFields(),
      coverChange: "replace",
    });
    const duplicated = createFormData(
      { ...explicitImageFields(), coverChange: "replace" },
      new File(["a"], "a.webp")
    );
    duplicated.append("cover", new File(["b"], "b.webp"));
    const oversized = createFormData(
      { ...explicitImageFields(), coverChange: "replace" },
      new File(
        [new Uint8Array(MAX_MODEL_MARKETPLACE_COVER_BYTES + 1)],
        "large.webp"
      )
    );

    for (const formData of [missing, duplicated, oversized]) {
      const response = await POST(createMultipartRequest(formData));
      expect(response.status).toBe(400);
    }
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("replace 把唯一封面转换为 Uint8Array", async () => {
    const response = await POST(
      createMultipartRequest(
        createFormData(
          { ...explicitImageFields(), coverChange: "replace" },
          new File([new Uint8Array([1, 2, 3])], "cover.webp", {
            type: "image/webp",
          })
        )
      )
    );

    expect(response.status).toBe(200);
    const input = invokedInput();
    expect(input).toMatchObject({
      category: "image",
      coverChange: { action: "replace" },
    });
    if (input.category !== "image" || input.coverChange.action !== "replace") {
      throw new Error("预期图像封面替换输入");
    }
    expect(input.coverChange.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("正确构造图像显式价格并拒绝旧价格来源字段", async () => {
    const explicitResponse = await POST(
      createMultipartRequest(createFormData(explicitImageFields()))
    );
    expect(explicitResponse.status).toBe(200);
    expect(invokedInput()).toMatchObject({
      category: "image",
      homepageVisible: true,
      homepagePriority: 3,
      pricing: {
        base1024Credits: 1.27,
        base1kCredits: 1.27,
        base2kCredits: 5.07,
        base4kCredits: 10,
      },
    });

    mocks.invokeOperation.mockClear();
    const legacyResponse = await POST(
      createMultipartRequest(
        createFormData({
          ...explicitImageFields(),
          pricingSource: "explicit",
        })
      )
    );
    expect(legacyResponse.status).toBe(400);
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("拒绝矛盾的首页开关与非法首页优先级", async () => {
    const invalidForms = [
      { ...explicitImageFields(), visible: "false", homepageVisible: "true" },
      { ...explicitImageFields(), homepagePriority: "-1" },
      { ...explicitImageFields(), homepagePriority: "1.5" },
      { ...explicitImageFields(), homepagePriority: "10001" },
    ];

    for (const fields of invalidForms) {
      const response = await POST(
        createMultipartRequest(createFormData(fields))
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("正确构造视频并拒绝已删除的 default 类别", async () => {
    mocks.invokeOperation.mockResolvedValue({
      category: "video",
      configKey: "veo31",
      revision: 6,
    });
    const videoResponse = await POST(
      createMultipartRequest(
        createFormData({
          category: "video",
          configKey: "veo31",
          expectedRevision: "5",
          clientRequestId: CLIENT_REQUEST_ID,
          visible: "false",
          homepageVisible: "false",
          homepagePriority: "8",
          description: "视频模型",
          coverChange: "remove",
          creditsPerSecondByResolution: JSON.stringify({
            "720p": 30,
            "1080p": 45,
          }),
        })
      )
    );
    expect(videoResponse.status).toBe(200);
    expect(invokedInput()).toMatchObject({
      category: "video",
      configKey: "veo31",
      visible: false,
      homepageVisible: false,
      homepagePriority: 8,
      creditsPerSecondByResolution: { "720p": 30, "1080p": 45 },
      coverChange: { action: "remove" },
    });

    mocks.invokeOperation.mockClear();
    const defaultResponse = await POST(
      createMultipartRequest(
        createFormData({
          category: "fallback",
          configKey: "default",
          expectedRevision: "6",
          clientRequestId: CLIENT_REQUEST_ID,
          ...imagePricingFields(),
        })
      )
    );
    expect(defaultResponse.status).toBe(400);
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("拒绝非法或非正数的视频分辨率价格 JSON", async () => {
    for (const creditsPerSecondByResolution of [
      "not-json",
      JSON.stringify({ "720p": 0 }),
      JSON.stringify({ "720p": "30" }),
      JSON.stringify({}),
    ]) {
      const response = await POST(
        createMultipartRequest(
          createFormData({
            category: "video",
            configKey: "veo31",
            expectedRevision: "5",
            clientRequestId: CLIENT_REQUEST_ID,
            visible: "true",
            homepageVisible: "false",
            homepagePriority: "5",
            description: "视频模型",
            coverChange: "keep",
            creditsPerSecondByResolution,
          })
        )
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("解析 Seedance 正安全整数参考图上限并拒绝非法值", async () => {
    const baseFields = {
      category: "video",
      configKey: "seedance2",
      expectedRevision: "5",
      clientRequestId: CLIENT_REQUEST_ID,
      visible: "true",
      homepageVisible: "false",
      homepagePriority: "5",
      description: "Seedance 视频模型",
      coverChange: "keep",
      creditsPerSecondByResolution: JSON.stringify({ "1080p": 45 }),
    };
    const response = await POST(
      createMultipartRequest(
        createFormData({ ...baseFields, maxReferenceImages: "20" })
      )
    );

    expect(response.status).toBe(200);
    expect(invokedInput()).toMatchObject({
      category: "video",
      configKey: "seedance2",
      maxReferenceImages: 20,
    });

    for (const maxReferenceImages of ["0", "-1", "1.5", "1e3"]) {
      mocks.invokeOperation.mockClear();
      const invalidResponse = await POST(
        createMultipartRequest(
          createFormData({ ...baseFields, maxReferenceImages })
        )
      );
      expect(invalidResponse.status).toBe(400);
      expect(mocks.invokeOperation).not.toHaveBeenCalled();
    }
  });

  it("用真实会话构造 Principal，并先初始化再调用 UOL", async () => {
    const order: string[] = [];
    mocks.ensureUolInitialized.mockImplementation(async () => {
      order.push("initialize");
    });
    mocks.invokeOperation.mockImplementation(async () => {
      order.push("invoke");
      return { category: "image", configKey: "gpt-image-2", revision: 3 };
    });

    const response = await POST(
      createMultipartRequest(createFormData(explicitImageFields()))
    );

    expect(response.status).toBe(200);
    expect(order).toEqual(["initialize", "invoke"]);
    expect(mocks.getUserRoleById).toHaveBeenCalledWith("super-admin-1");
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "settings.updateModelConfigurationEntry",
      expect.any(Object),
      {
        type: "user",
        userId: "super-admin-1",
        role: "super_admin",
      }
    );
  });

  it("按 OperationError 的 code 与 httpStatus 返回稳定 JSON", async () => {
    mocks.invokeOperation.mockRejectedValue(
      new OperationError(
        "conflict",
        "包含不应向客户端暴露的数据库细节",
        undefined,
        409
      )
    );

    const response = await POST(
      createMultipartRequest(createFormData(explicitImageFields()))
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Operation failed",
      code: "conflict",
    });
  });

  it("把已分类的封面校验错误编码为前端稳定机器码", async () => {
    mocks.invokeOperation.mockRejectedValue(
      new OperationError(
        "validation_error",
        "封面必须是可安全解码的静态图片",
        { reason: "invalid_cover", coverCode: "invalid_image" },
        400
      )
    );

    const response = await POST(
      createMultipartRequest(createFormData(explicitImageFields()))
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Operation failed",
      code: "invalid_cover",
    });
  });

  it("未知异常返回稳定 500 且不泄露原始消息", async () => {
    mocks.invokeOperation.mockRejectedValue(
      new Error("secret database host and stack")
    );

    const response = await POST(
      createMultipartRequest(createFormData(explicitImageFields()))
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("Internal server error");
    expect(body).not.toContain("secret database host");
    expect(body).not.toContain("stack");
  });
});
