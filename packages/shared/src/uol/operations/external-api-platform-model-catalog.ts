/**
 * 平台公开模型目录 UOL operation。
 *
 * 使用方：首页服务端以 system Principal 进程内调用；真实运行时读取由 apps/web 的
 * late binding 注入。关键依赖：UOL 注册表与 Zod 严格输出契约。
 */
import { z } from "zod";

import { defineOperation } from "../registry";

/** 单个公开模型只允许携带可展示的模型 ID。 */
export const platformModelCatalogItemSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
  })
  .strict();

/**
 * 平台目录公开输出契约。
 *
 * 根对象与模型项均严格拒绝额外字段，避免 late binding 意外透传凭据、地址、
 * 内部 ID、健康错误或用户级授权信息。
 */
export const platformModelCatalogOutputSchema = z
  .object({
    image: z.array(platformModelCatalogItemSchema),
    video: z.array(platformModelCatalogItemSchema),
  })
  .strict();

/** 首页可公开展示的平台模型目录输出。 */
export type PlatformModelCatalogOutput = z.infer<
  typeof platformModelCatalogOutputSchema
>;

/**
 * 注册平台公开模型目录操作。
 *
 * 该操作仅允许 system Principal 进程内调用；human-only 是额外的 Agent 投影保险，
 * “公开”只描述输出数据，不代表匿名或 MCP 调用权限。
 */
export const getPlatformModelCatalog = defineOperation({
  name: "externalApi.getPlatformModelCatalog",
  domain: "external-api",
  title: "Get Platform Model Catalog",
  description: "读取仅含公开模型 ID 与分类的平台运行时模型目录。",
  input: z.object({}).strict(),
  output: platformModelCatalogOutputSchema,
  access: { kind: "system" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  async execute(_input, _principal, _ctx) {
    throw new Error("Not yet wired: externalApi.getPlatformModelCatalog");
  },
});
