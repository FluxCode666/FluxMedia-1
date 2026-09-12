"use server";

/**
 * 模型配置管理读取的 Server Action 薄适配器。
 *
 * 使用方是管理端模型配置页面；本模块通过 Go 后端读取模型配置快照，不访问数据库、不合并价格
 * 或构造封面 URL。viewer Action 负责保持 observer_admin、admin 和 super_admin 的会话边界。
 */
import {
  type ModelConfigurationListOutput,
  type ModelConfigurationSnapshot,
  modelConfigurationListInputSchema,
} from "@repo/shared/model-marketplace";
import { imageBackendPoolViewerAction } from "@repo/shared/safe-action";
import { requestGoJson } from "@/server/go-backend-client";

/**
 * 读取当前管理员可见的规范化模型配置快照。
 *
 * @returns Go 后端返回的管理快照；canEdit 由真实会话角色在服务端计算。
 * @sideEffects 发起一次带会话 Cookie 的 Go API 只读请求；不直接读取数据库或存储。
 * @failure 会话或后台查看权限由 viewer Action 拒绝；初始化和 operation 异常不伪装为空快照，
 * 交由共享 Server Action 错误边界处理。
 */
export const getModelConfigurationAction = imageBackendPoolViewerAction
  .metadata({ action: "modelConfiguration.get" })
  .action(async ({ ctx }): Promise<ModelConfigurationSnapshot> => {
    void ctx;
    return requestGoJson<ModelConfigurationSnapshot>("/api/admin/model-configuration");
  });

/**
 * 按查询条件分页读取当前管理员可见的模型配置。
 *
 * @returns Go 后端校验后的精确总数和当前页条目。
 * @sideEffects 发起一次带会话 Cookie 的 Go API 读取请求。
 * @failure 会话、角色、输入和 operation 错误由统一 Action 边界处理。
 */
export const listModelConfigurationsAction = imageBackendPoolViewerAction
  .metadata({ action: "modelConfiguration.list" })
  .schema(modelConfigurationListInputSchema)
  .action(
    async ({ parsedInput, ctx }): Promise<ModelConfigurationListOutput> => {
      void ctx;
      const query = new URLSearchParams({
        page: String(parsedInput.page),
        pageSize: String(parsedInput.pageSize),
        query: parsedInput.query,
        category: parsedInput.category,
      });
      return requestGoJson<ModelConfigurationListOutput>(
        `/api/admin/model-configuration?${query.toString()}`
      );
    }
  );
