/**
 * 图片模型 ID 输入契约。
 *
 * 职责：为 UOL、HTTP 路由和 Server Action 提供统一的必传模型参数校验，避免传输层
 * 各自实现不同的缺省与空白处理。该模块仅依赖 Zod，可在无数据库环境中复用与测试。
 */
import { z } from "zod";

/**
 * 校验客户端明确选择的图片模型 ID。
 *
 * 输入必须是非空字符串；解析成功后会移除首尾空白。缺失、类型错误、空字符串、纯
 * 空白或超过 120 个字符均会失败，不产生默认模型，也没有 I/O 副作用。
 */
export const imageModelIdSchema = z
  .string({ error: "model is required" })
  .trim()
  .min(1, "model is required")
  .max(120, "model must be at most 120 characters");
