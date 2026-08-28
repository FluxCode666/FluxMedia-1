"use client";

/**
 * 供应商账号详情页。
 *
 * 使用方：`/dashboard/admin/suppliers/[memberId]`。页面读取脱敏账号快照后复用成员
 * 表单的详情模式，只开放模型能力、上游映射、视频协议、脚本和分辨率等适配细节。
 * 凭据仍由服务端 action 管理，浏览器不会获得密钥正文。
 */
import type { BackendGroupSummary } from "@repo/shared/image-backend/group-contract";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { ArrowLeft } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { getModelConfigurationAction } from "@/features/model-configuration/actions";
import { Link, useRouter } from "@/i18n/routing";
import { getAdminImageBackendPoolAction } from "./actions";
import { AdobeCredentialHealthView } from "./adobe-credential-health-view";
import { BackendMemberFormDialog } from "./member-form";
import {
  type BackendMemberModelOption,
  buildBackendMemberModelOptions,
} from "./member-model-options";
import type { BackendMemberModelOptionStatus } from "./member-model-select";
import type { BackendMemberAdminSummary } from "./member-service";

/**
 * 返回详情页使用的账号类型名称。
 *
 * @param member 已脱敏的供应商账号摘要。
 * @returns API、Adobe Direct 或 Adobe Gateway。
 * @sideEffects 无；不读取凭据正文。
 */
function getMemberTypeLabel(member: BackendMemberAdminSummary): string {
  if (member.type === "api") return "API";
  return member.config.mode === "direct" ? "Adobe Direct" : "Adobe Gateway";
}

/**
 * 渲染单个供应商账号的适配详情。
 *
 * @param memberId 路由中的账号 ID。
 * @param readOnly observer 角色只读时隐藏保存能力。
 * @returns 加载中、找不到账号或详情表单。
 * @sideEffects 读取管理快照和模型目录，保存后重新读取快照。
 */
export function BackendMemberDetailPage({
  memberId,
  timeZone,
  readOnly = false,
}: {
  memberId: string;
  timeZone: string;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [member, setMember] = useState<BackendMemberAdminSummary | null>(null);
  const [groups, setGroups] = useState<BackendGroupSummary[]>([]);
  const [modelOptions, setModelOptions] = useState<BackendMemberModelOption[]>(
    []
  );
  const [modelOptionStatus, setModelOptionStatus] =
    useState<BackendMemberModelOptionStatus>("loading");
  const [isLoading, setIsLoading] = useState(true);

  const { execute: loadPool } = useAction(getAdminImageBackendPoolAction, {
    onSuccess: ({ data }) => {
      const found = data?.members.find((item) => item.id === memberId) ?? null;
      setGroups(data?.groups ?? []);
      setMember(found);
      setIsLoading(false);
      if (!found) toast.error("供应商账号不存在或已删除");
    },
    onError: ({ error }) => {
      setIsLoading(false);
      toast.error(error.serverError || "加载供应商账号详情失败");
    },
  });
  const { execute: loadModelOptions } = useAction(getModelConfigurationAction, {
    onSuccess: ({ data }) => {
      if (!data) {
        setModelOptionStatus("unavailable");
        return;
      }
      setModelOptions(buildBackendMemberModelOptions(data));
      setModelOptionStatus(
        data.runtimeCatalogStatus === "ready" ? "ready" : "degraded"
      );
    },
    onError: ({ error }) => {
      setModelOptionStatus("unavailable");
      toast.error(error.serverError || "加载模型配置失败");
    },
  });

  useEffect(() => {
    loadPool();
    loadModelOptions();
  }, [loadModelOptions, loadPool]);

  if (isLoading) {
    return (
      <div aria-busy="true" aria-label="正在加载账号详情" role="status">
        <div className="h-96 animate-pulse rounded-md border bg-muted/30" />
      </div>
    );
  }

  if (!member) {
    return (
      <div className="space-y-4 rounded-md border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">
          找不到该供应商账号，可能已被删除。
        </p>
        <Button asChild variant="outline">
          <Link href="/dashboard/admin/suppliers">
            <ArrowLeft />
            返回供应商账号列表
          </Link>
        </Button>
      </div>
    );
  }

  const groupNames = member.groupIds
    .map((groupId) => groups.find((group) => group.id === groupId)?.name)
    .filter((name): name is string => Boolean(name));

  return (
    <div className="space-y-6">
      <header className="overflow-hidden rounded-lg border bg-card">
        <div className="px-5 py-5 sm:px-6">
          <Button asChild className="-ml-3 mb-2" size="sm" variant="ghost">
            <Link href="/dashboard/admin/suppliers">
              <ArrowLeft />
              返回账号列表
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">
              {member.name}
            </h2>
            <Badge variant="outline">{getMemberTypeLabel(member)}</Badge>
            <Badge
              variant={
                !member.isEnabled || member.status === "error"
                  ? "destructive"
                  : "secondary"
              }
            >
              {member.isEnabled ? member.status : "disabled"}
            </Badge>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            按模型维护供应商能力，并集中配置该账号的请求协议、响应解析和默认参数。
          </p>
        </div>
        <dl className="grid grid-cols-2 border-t bg-muted/10 lg:grid-cols-4">
          <div className="border-r border-b px-5 py-3 lg:border-b-0">
            <dt className="text-xs text-muted-foreground">所属分组</dt>
            <dd className="mt-1 truncate text-sm font-medium">
              {groupNames.join("、") || "未分组"}
            </dd>
          </div>
          <div className="border-b px-5 py-3 lg:border-r lg:border-b-0">
            <dt className="text-xs text-muted-foreground">支持模型</dt>
            <dd className="mt-1 text-sm font-medium tabular-nums">
              {member.supportedModelIds.length} 个
            </dd>
          </div>
          <div className="border-r px-5 py-3">
            <dt className="text-xs text-muted-foreground">优先级</dt>
            <dd className="mt-1 text-sm font-medium tabular-nums">
              {member.priority}
            </dd>
          </div>
          <div className="px-5 py-3">
            <dt className="text-xs text-muted-foreground">并发占用 / 上限</dt>
            <dd className="mt-1 text-sm font-medium tabular-nums">
              {member.inflightCount} / {member.concurrency}
            </dd>
          </div>
        </dl>
      </header>
      <BackendMemberFormDialog
        detailsOnly
        groups={groups}
        inline
        member={member}
        modelOptionStatus={modelOptionStatus}
        modelOptions={modelOptions}
        onOpenChange={() => router.push("/dashboard/admin/suppliers")}
        onSaved={() => {
          loadPool();
          router.refresh();
        }}
        open
        readOnly={readOnly}
      />
      {member.type === "adobe" && member.config.mode === "direct" ? (
        <AdobeCredentialHealthView
          memberId={member.id}
          readOnly={readOnly}
          timeZone={timeZone}
        />
      ) : null}
    </div>
  );
}
