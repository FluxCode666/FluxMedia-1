/**
 * 模型配置与模型广场 UOL operation。
 *
 * 使用方：管理端、公开模型页面与 apps/web late binding。三个操作只声明传输无关的
 * schema、权限、幂等和副作用；真实目录、事务和存储实现由 Web 层后续注入。
 */
import { z } from "zod";

import {
  modelConfigurationSnapshotSchema,
  modelMarketplacePublicItemSchema,
  updateModelConfigurationEntryInputSchema,
  updateModelConfigurationEntryOutputSchema,
} from "../../model-marketplace";
import { defineOperation } from "../registry";

/** 公开模型目录成功输出；空 items 表示正常空目录，依赖故障由 not_ready 错误表示。 */
export const modelMarketplacePublicCatalogOutputSchema = z
  .object({
    items: z.array(modelMarketplacePublicItemSchema).max(500),
  })
  .strict();

/** 公开模型目录的严格输出类型。 */
export type ModelMarketplacePublicCatalogOutput = z.infer<
  typeof modelMarketplacePublicCatalogOutputSchema
>;

/**
 * 读取管理端模型配置快照。
 *
 * admin、observer_admin 与 super_admin 可读；真实实现必须根据 Principal 单独计算
 * canEdit，不能仅凭 operation 的读取权限推断写权限。
 */
export const settingsGetModelConfiguration = defineOperation({
  name: "settings.getModelConfiguration",
  domain: "system-settings",
  title: "读取模型配置",
  description: "读取图像、视频和图像计费兜底项的规范化管理快照。",
  input: z.object({}).strict(),
  output: modelConfigurationSnapshotSchema,
  access: { kind: "admin" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  async execute(_input, _principal, _ctx) {
    throw new Error("Not yet wired: settings.getModelConfiguration");
  },
});

/**
 * 更新单个模型或图像计费兜底项。
 *
 * `roles` 权限只接受真实 super_admin 用户并拒绝 system Principal；clientRequestId 负责
 * 网络重试幂等，expectedRevision 由后续事务服务负责乐观并发控制。
 */
export const settingsUpdateModelConfigurationEntry = defineOperation({
  name: "settings.updateModelConfigurationEntry",
  domain: "system-settings",
  title: "更新单个模型配置",
  description: "原子保存单个模型的价格、展示信息和封面状态。",
  input: updateModelConfigurationEntryInputSchema,
  output: updateModelConfigurationEntryOutputSchema,
  access: { kind: "roles", roles: ["super_admin"] },
  agentExposure: "human-only",
  readOnly: false,
  destructive: true,
  idempotency: {
    kind: "required",
    keyField: "clientRequestId",
    scope: "per-user",
  },
  sideEffects: ["storage", "cache", "audit"],
  async execute(_input, _principal, _ctx) {
    throw new Error("Not yet wired: settings.updateModelConfigurationEntry");
  },
});

/**
 * 读取公开模型广场目录。
 *
 * 仅允许 system Principal 在站内进程调用；公开描述的是返回内容，不代表匿名传输或
 * Agent/MCP 可直接调用。运行时依赖失败由后续 binding 映射为 not_ready。
 */
export const modelMarketplaceListPublicModels = defineOperation({
  name: "modelMarketplace.listPublicModels",
  domain: "external-api",
  title: "读取公开模型广场",
  description: "读取运行时可达且管理员允许展示的图像与视频模型。",
  input: z.object({}).strict(),
  output: modelMarketplacePublicCatalogOutputSchema,
  access: { kind: "system" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  async execute(_input, _principal, _ctx) {
    throw new Error("Not yet wired: modelMarketplace.listPublicModels");
  },
});
