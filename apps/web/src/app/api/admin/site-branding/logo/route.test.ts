/**
 * 管理员 Logo multipart Route 测试。
 *
 * 驱动真实 Request/FormData，隔离认证、Origin 和 UOL，覆盖成功、权限、正文上限与严格
 * 字段行为；不写对象存储。
 */

import { MAX_SITE_LOGO_UPLOAD_BYTES } from "@repo/shared/system-settings/site-branding";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(),
  getSession: vi.fn(),
  getUserRoleById: vi.fn(),
  hasTrustedOrigin: vi.fn(),
  invokeOperation: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/shared/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: mocks.getUserRoleById,
}));
vi.mock("@repo/shared/logger", () => ({ logError: mocks.logError }));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
  OperationError: class OperationError extends Error {
    readonly code: string;
    readonly httpStatus: number;

    /** 构造测试用稳定 UOL 错误。 */
    constructor(code: string, message: string, _details?: unknown) {
      super(message);
      this.name = "OperationError";
      this.code = code;
      this.httpStatus = code === "forbidden" ? 403 : 400;
    }
  },
}));
vi.mock("@/features/model-configuration/request-origin", () => ({
  hasTrustedModelConfigurationOrigin: mocks.hasTrustedOrigin,
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

import { POST } from "./route";

const user = { id: "super-admin-1" };
const role = "super_admin";

/** 构造合法上传表单。 */
function createFormData(
  file = new File(["data"], "logo.svg", { type: "image/svg+xml" })
) {
  const formData = new FormData();
  formData.append("clientRequestId", "6b7d1204-3f43-4da7-b2b5-b7540927e462");
  formData.append("file", file);
  return formData;
}

/** 构造带受信来源的 multipart 请求。 */
function createRequest(formData: FormData): Request {
  return new Request("https://app.example.com/api/admin/site-branding/logo", {
    method: "POST",
    headers: { origin: "https://app.example.com" },
    body: formData,
  });
}

describe("POST /api/admin/site-branding/logo", () => {
  beforeEach(() => {
    mocks.ensureUolInitialized.mockReset();
    mocks.getSession.mockReset();
    mocks.getUserRoleById.mockReset();
    mocks.hasTrustedOrigin.mockReset();
    mocks.invokeOperation.mockReset();
    mocks.logError.mockReset();
    mocks.hasTrustedOrigin.mockReturnValue(true);
    mocks.getSession.mockResolvedValue({ user });
    mocks.getUserRoleById.mockResolvedValue(role);
    mocks.ensureUolInitialized.mockResolvedValue(undefined);
    mocks.invokeOperation.mockResolvedValue({
      logoUrl:
        "/api/storage/site-assets/logo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.svg",
      replayed: false,
    });
  });

  it("按严格字段把文件字节交给 upload operation", async () => {
    const response = await POST(createRequest(createFormData()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replayed: false });
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "settings.uploadSiteLogo",
      expect.objectContaining({
        clientRequestId: "6b7d1204-3f43-4da7-b2b5-b7540927e462",
        fileName: "logo.svg",
        contentType: "image/svg+xml",
        bytes: expect.any(Uint8Array),
      }),
      expect.objectContaining({ type: "user", userId: user.id, role })
    );
  });

  it("Origin、登录态和角色在读取正文前形成服务端边界", async () => {
    mocks.hasTrustedOrigin.mockReturnValue(false);
    expect((await POST(createRequest(createFormData()))).status).toBe(403);

    mocks.hasTrustedOrigin.mockReturnValue(true);
    mocks.getSession.mockResolvedValue(null);
    expect((await POST(createRequest(createFormData()))).status).toBe(401);

    mocks.getSession.mockResolvedValue({ user });
    mocks.getUserRoleById.mockResolvedValue("admin");
    expect((await POST(createRequest(createFormData()))).status).toBe(403);
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("拒绝超过 5 MiB 的真实文件字节", async () => {
    const file = new File(
      [new Uint8Array(MAX_SITE_LOGO_UPLOAD_BYTES + 1)],
      "logo.png",
      { type: "image/png" }
    );
    const response = await POST(createRequest(createFormData(file)));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_error" });
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("拒绝未知字段和重复文件", async () => {
    const unknown = createFormData();
    unknown.append("unexpected", "value");
    expect((await POST(createRequest(unknown))).status).toBe(400);

    const duplicate = createFormData();
    duplicate.append("file", new File(["data"], "other.png"));
    expect((await POST(createRequest(duplicate))).status).toBe(400);
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });
});
