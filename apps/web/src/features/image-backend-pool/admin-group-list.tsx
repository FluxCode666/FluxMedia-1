"use client";

/**
 * 账号池分组的紧凑语义列表。
 *
 * 使用方：ImageBackendPoolAdminPanel 的分组 Tab。组件展示服务端分组摘要、成员数量
 * 和层级名称，并把编辑与删除意图回传父组件；不加载数据或持有表单状态。
 */
import type { BackendGroupSummary } from "@repo/shared/image-backend/group-contract";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Pencil, Trash2 } from "lucide-react";

/** 返回分组内容安全覆盖的后台标签。 */
function getGroupContentSafetyLabel(
  contentSafety: BackendGroupSummary["contentSafety"]
): string {
  if (contentSafety === "enabled") return "开启";
  if (contentSafety === "disabled") return "关闭";
  return "继承";
}

/**
 * 渲染分组表格、原始空态或筛选空态。
 *
 * @param props 已筛选分组、完整分组名称、成员计数、权限及行操作回调。
 * @returns 窄屏可横向滚动的分组语义列表。
 * @sideEffects 点击编辑回传目标；删除经浏览器确认后回传目标 ID。
 * @failure 无分组时显示创建提示；有搜索但无匹配时显示筛选空态。
 */
export function BackendGroupList({
  groups,
  allGroups,
  memberCountByGroup,
  readOnly,
  isDeleting,
  hasNameFilter,
  onEdit,
  onDelete,
}: {
  groups: readonly BackendGroupSummary[];
  allGroups: readonly BackendGroupSummary[];
  memberCountByGroup: ReadonlyMap<string, number>;
  readOnly: boolean;
  isDeleting: boolean;
  hasNameFilter: boolean;
  onEdit: (group: BackendGroupSummary) => void;
  onDelete: (id: string) => void;
}) {
  if (groups.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center px-4 text-center text-sm text-muted-foreground">
        {hasNameFilter
          ? "没有符合名称条件的分组。"
          : "尚未创建分组。创建第一个分组后才能添加供应商账号。"}
      </div>
    );
  }

  const groupNameById = new Map(
    allGroups.map((group) => [group.id, group.name])
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] table-fixed text-sm">
        <thead className="bg-muted/30 text-left text-xs text-muted-foreground">
          <tr>
            <th className="w-[28%] px-4 py-3 font-medium" scope="col">
              分组
            </th>
            <th className="w-28 px-4 py-3 font-medium" scope="col">
              状态
            </th>
            <th className="w-32 px-4 py-3 font-medium" scope="col">
              访问规则
            </th>
            <th className="w-36 px-4 py-3 font-medium" scope="col">
              调度与安全
            </th>
            <th className="px-4 py-3 font-medium" scope="col">
              子分组
            </th>
            <th className="w-24 px-4 py-3 text-right font-medium" scope="col">
              账号数
            </th>
            {!readOnly ? (
              <th className="w-24 px-4 py-3 text-right font-medium" scope="col">
                操作
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y">
          {groups.map((group) => (
            <tr
              className="align-top transition-colors hover:bg-muted/20"
              key={group.id}
            >
              <td className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  <span>{group.name}</span>
                  {group.isDefault ? <Badge>默认</Badge> : null}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {group.description || "无说明"}
                </p>
              </td>
              <td className="px-4 py-3">
                <Badge variant={group.isEnabled ? "secondary" : "outline"}>
                  {group.isEnabled ? "已启用" : "已停用"}
                </Badge>
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                <span className="block">最低套餐：{group.minPlan}</span>
                <span className="mt-1 block">
                  用户选择：{group.isUserSelectable ? "允许" : "禁止"}
                </span>
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                <span className="block">优先级：{group.priority}</span>
                <span className="mt-1 block">
                  内容安全：
                  {getGroupContentSafetyLabel(group.contentSafety)}
                </span>
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {group.childGroupIds.length > 0
                  ? group.childGroupIds
                      .map((id) => groupNameById.get(id) ?? id)
                      .join("、")
                  : "无"}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {memberCountByGroup.get(group.id) ?? 0}
              </td>
              {!readOnly ? (
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    <Button
                      aria-label={`编辑分组“${group.name}”`}
                      onClick={() => onEdit(group)}
                      size="icon"
                      title="编辑分组"
                      type="button"
                      variant="ghost"
                    >
                      <Pencil />
                    </Button>
                    <Button
                      aria-label={`删除分组“${group.name}”`}
                      disabled={isDeleting || group.isDefault}
                      onClick={() => {
                        if (window.confirm(`确认删除分组“${group.name}”？`)) {
                          onDelete(group.id);
                        }
                      }}
                      size="icon"
                      title={group.isDefault ? "默认分组不能删除" : "删除分组"}
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
