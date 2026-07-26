"use server";

/**
 * 模型配置管理读取的 Server Action 薄适配器。
 *
 * 使用方是管理端模型配置页面；本模块只初始化 UOL、从 adminAction 交付的真实会话上下文
 * 构造 user Principal，并调用统一读取 operation，不访问数据库、不合并价格或构造封面 URL。
 * 读取角色集合与 UOL admin 一致，包含 observer_admin、admin 和 super_admin。
 */
import type { ModelConfigurationSnapshot } from "@repo/shared/model-marketplace";
import { imageBackendPoolViewerAction } from "@repo/shared/safe-action";
import { invokeOperation } from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";

/**
 * 读取当前管理员可见的规范化模型配置快照。
 *
 * @returns UOL 返回的严格管理快照；canEdit 由真实 Principal 在服务端计算。
 * @sideEffects 初始化 Web UOL binding，并执行一次只读 operation；不直接读取数据库或存储。
 * @failure 会话或后台查看权限由 viewer Action 拒绝；初始化和 operation 异常不伪装为空快照，
 * 交由共享 Server Action 错误边界处理。
 */
export const getModelConfigurationAction = imageBackendPoolViewerAction
  .metadata({ action: "modelConfiguration.get" })
  .action(async ({ ctx }): Promise<ModelConfigurationSnapshot> => {
    await ensureUolInitialized();
    return invokeOperation<ModelConfigurationSnapshot>(
      "settings.getModelConfiguration",
      {},
      { type: "user", userId: ctx.userId, role: ctx.role }
    );
  });
