import { describe, expect, it } from "vitest";

import type { BackendMemberAdminSummary } from "./member-service";
import {
  BACKEND_MEMBER_EXPORT_FORMAT,
  BACKEND_MEMBER_EXPORT_VERSION,
  parseBackendMemberExportText,
  serializeBackendMemberExport,
} from "./member-transfer";

function apiMember(): BackendMemberAdminSummary {
  return {
    id: "member-api",
    name: "沧元",
    type: "api",
    groupIds: ["group-primary"],
    supportedModelIds: ["seedance2"],
    supportedResolutionsByModel: { seedance2: ["1080p", "4k"] },
    contentSafetyEnabled: true,
    isEnabled: true,
    alwaysActive: false,
    failureCooldownEnabled: true,
    priority: 10,
    concurrency: 3,
    status: "healthy",
    healthStatus: "healthy",
    inflightCount: 0,
    leaseAcquiredCount: 2,
    createdAt: "2026-08-24T00:00:00.000Z",
    lastAcquiredAt: null,
    lastUsedAt: null,
    lastError: null,
    lastErrorAt: null,
    config: {
      baseUrl: "https://provider.example.com/v1",
      hasApiKey: true,
      useStream: false,
      videoSubmissionRetryCount: 2,
      videoProtocolMode: "seedance",
      videoInputCapabilities: {
        referenceVideos: false,
        referenceAudios: false,
      },
      modelMappings: [{ modelId: "seedance2", upstreamModelId: "seedance2" }],
      authentication: { mode: "bearer" },
      credentialScope: "provider",
      currentAdapterVersion: {
        id: "adapter-version-1",
        revision: 1,
        createdAt: "2026-08-24T00:00:00.000Z",
      },
    },
  };
}

describe("供应商账号导入导出", () => {
  it("导出模型能力和分辨率覆盖，但不会导出 API Key", () => {
    const text = serializeBackendMemberExport([apiMember()]);
    const document = JSON.parse(text) as Record<string, unknown>;
    const member = (document.members as Array<Record<string, unknown>>)[0];
    const config = member?.config as Record<string, unknown>;

    expect(document).toMatchObject({
      format: BACKEND_MEMBER_EXPORT_FORMAT,
      version: BACKEND_MEMBER_EXPORT_VERSION,
    });
    expect(member?.supportedResolutionsByModel).toEqual({
      seedance2: ["1080p", "4k"],
    });
    expect(config).not.toHaveProperty("apiKey");
    expect(config).not.toHaveProperty("hasApiKey");
    expect(config.expectedCurrentVersionId).toBe("adapter-version-1");
  });

  it("只接受带版本标识的 JSON 导入文件", () => {
    const valid = parseBackendMemberExportText(
      serializeBackendMemberExport([apiMember()])
    );
    expect(valid).toEqual({
      success: true,
      document: expect.objectContaining({
        format: BACKEND_MEMBER_EXPORT_FORMAT,
        version: BACKEND_MEMBER_EXPORT_VERSION,
        members: expect.any(Array),
      }),
    });

    expect(parseBackendMemberExportText("{}")).toMatchObject({
      success: false,
    });
    expect(parseBackendMemberExportText("not-json")).toEqual({
      success: false,
      message: "导入文件不是有效的 JSON",
    });
  });
});
