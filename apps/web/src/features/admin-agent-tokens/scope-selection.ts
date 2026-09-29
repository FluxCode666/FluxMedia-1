/**
 * agent 令牌授权范围勾选的纯函数。
 *
 * 使用方：令牌管理面板。勾选 scope 时补齐前置 scope，取消时连带取消依赖它的
 * scope，与 Go 端签发时的规范化规则保持一致；不读取网络或浏览器状态。
 */
import type { AdminAgentScope } from "@repo/shared/uol/operations/admin-agent";

/**
 * 切换 scope 勾选状态：勾选时补齐前置 scope，取消时一并取消依赖它的 scope。
 *
 * @param selected 当前已勾选的 scope ID。
 * @param scopeId 被切换的 scope ID。
 * @param checked 切换后的勾选状态。
 * @param scopes 全部可签发的 scope 定义。
 * @returns 新的勾选集合。
 */
export function toggleScope(
  selected: ReadonlySet<string>,
  scopeId: string,
  checked: boolean,
  scopes: readonly AdminAgentScope[]
): Set<string> {
  const next = new Set(selected);
  const byId = new Map(scopes.map((scope) => [scope.id, scope]));
  if (checked) {
    const pending = [scopeId];
    while (pending.length > 0) {
      const id = pending.pop();
      if (!id || next.has(id)) continue;
      next.add(id);
      pending.push(...(byId.get(id)?.requires ?? []));
    }
    return next;
  }
  const pending = [scopeId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || !next.has(id)) continue;
    next.delete(id);
    for (const scope of scopes) {
      if (scope.requires.includes(id)) pending.push(scope.id);
    }
  }
  return next;
}

/**
 * 按 group 分组 scope，保持注册表顺序。
 *
 * @param scopes 全部可签发的 scope 定义。
 * @returns [分组名称, 该组 scope] 列表。
 */
export function groupScopes(
  scopes: readonly AdminAgentScope[]
): Array<[string, AdminAgentScope[]]> {
  const groups = new Map<string, AdminAgentScope[]>();
  for (const scope of scopes) {
    const items = groups.get(scope.group) ?? [];
    items.push(scope);
    groups.set(scope.group, items);
  }
  return [...groups.entries()];
}
