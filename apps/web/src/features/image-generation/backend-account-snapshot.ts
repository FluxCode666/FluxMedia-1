/**
 * 生成任务的供应商账号身份快照。
 *
 * 使用方：图片与视频任务写入链路。这里只保存统一账号的名称和 ID，供账号重命名或
 * 删除后的管理员历史追溯；凭据、地址、健康状态和租约信息不得进入快照。
 */

export type BackendAccountSnapshot = {
  id: string;
  name: string | null;
};

/**
 * 规范化可信调度结果中的供应商账号身份。
 *
 * @param input 已获租统一成员的可选名称和 ID。
 * @returns ID 缺失时返回 null；否则返回去除首尾空白的不可变安全快照。
 * @sideEffects 无；不读取数据库，也不接触供应商凭据。
 */
export function buildBackendAccountSnapshot(input: {
  id?: string;
  name?: string;
}): BackendAccountSnapshot | null {
  const id = input.id?.trim();
  if (!id) return null;
  return {
    id,
    name: input.name?.trim() || null,
  };
}
