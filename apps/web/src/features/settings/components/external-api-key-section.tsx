"use client";

/**
 * API 密钥管理页面主体。
 *
 * 职责：提供创建区、可重复复制的明文展示和单一响应式摘要列表；每行独立展开与锁定，
 * 启用态只编辑分组/额度，撤销态只读且仅允许删除。
 * 使用方：/dashboard/external-api 页面。
 * 关键依赖：API 密钥 Server Actions、纯列表状态 reducer、Shadcn Collapsible。
 */
import { formatCredits } from "@repo/shared/credits/format";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@repo/ui/components/alert-dialog";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/ui/components/collapsible";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import {
  ChevronDown,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { ExternalApiKeySummary } from "@/features/external-api/key-management-service";

import {
  createExternalApiKey,
  deleteExternalApiKey,
  type ExternalApiKeyListResult,
  getExternalApiKeys,
  revokeExternalApiKey,
  updateExternalApiKeyGroup,
  updateExternalApiKeyQuota,
} from "../actions/external-api-key";
import {
  canApplyExternalApiKeyFullListLoad,
  createExternalApiKeyActivityState,
  createExternalApiKeyListState,
  type ExternalApiKeyRowMutation,
  finishExternalApiKeyFullListLoad,
  finishExternalApiKeyMutation,
  getExternalApiKeyDeleteFocusTarget,
  isExternalApiKeyRowLocked,
  reduceExternalApiKeyListState,
  restoreExternalApiKeyDeleteFocus,
  tryStartExternalApiKeyFullListLoad,
  tryStartExternalApiKeyMutation,
} from "./external-api-key-list-state";

const DEFAULT_GROUP_VALUE = "default";

type LoadStatus = "loading" | "ready" | "error";
type EditableGroup = ExternalApiKeyListResult["editableGroups"][number];
type RefreshedKeyResult =
  | { status: "found"; key: ExternalApiKeySummary }
  | { status: "missing" }
  | { status: "failed" };

/** 按用户时区格式化时间；空值显示调用方提供的占位文案。 */
function formatDate(
  value: Date | string | null,
  emptyLabel: string,
  locale: string,
  timeZone?: string
): string {
  if (!value) return emptyLabel;
  return formatDateInTimeZone(
    value,
    locale,
    { dateStyle: "medium", timeStyle: "short" },
    timeZone
  );
}

/** 解析额度输入；空字符串表示不限额，非法输入返回 undefined。 */
function parseCreditLimit(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

/** 从 next-safe-action 结果读取安全错误文案。 */
function getActionError(
  result: { serverError?: string } | undefined,
  fallback: string
): string {
  return result?.serverError || fallback;
}

/**
 * 渲染 API 密钥创建区与摘要列表。
 *
 * @param baseUrl - 当前请求对应的 HTTP(S) origin，由服务端页面校验后传入。
 * @param timeZone - 当前用户的 IANA 时区；缺省时由格式化层回退。
 * @returns 可创建、编辑、撤销和删除 API 密钥的客户端交互区。
 * @sideEffects 加载与修改当前用户的 API 密钥，并展示操作反馈。
 */
export function ExternalApiKeySection({
  baseUrl,
  timeZone,
}: {
  baseUrl: string;
  timeZone?: string;
}) {
  const locale = useLocale();
  const t = useTranslations("Settings.externalApi");
  const didLoadRef = useRef(false);
  const createHeadingRef = useRef<HTMLHeadingElement>(null);
  const rowTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingRowsRef = useRef(new Set<string>());
  const activityRef = useRef(createExternalApiKeyActivityState());
  const createMutationActiveRef = useRef(false);
  const newKeyInputRef = useRef<HTMLInputElement>(null);

  const [listState, setListState] = useState(() =>
    createExternalApiKeyListState<ExternalApiKeySummary>([])
  );
  const [editableGroups, setEditableGroups] = useState<EditableGroup[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [loadError, setLoadError] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [keyName, setKeyName] = useState(() => t("defaultName"));
  const [newKeyGroupId, setNewKeyGroupId] = useState(DEFAULT_GROUP_VALUE);
  const [newKeyCreditLimit, setNewKeyCreditLimit] = useState("");
  const [groupDrafts, setGroupDrafts] = useState<Record<string, string>>({});
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({});
  const expandedKeyIdSet = useMemo(
    () => new Set(listState.expandedKeyIds),
    [listState.expandedKeyIds]
  );
  const editableGroupIdSet = useMemo(
    () => new Set(editableGroups.map((group) => group.id)),
    [editableGroups]
  );
  const isFullListLoading = loadStatus === "loading" || isRefreshing;
  const hasActiveMutation =
    isCreating || Object.keys(listState.pendingByKeyId).length > 0;

  /** 用服务端摘要重建列表和编辑草稿；只在完整加载成功时调用。 */
  const applyLoadedList = useCallback((data: ExternalApiKeyListResult) => {
    setListState(createExternalApiKeyListState(data.keys));
    setEditableGroups(data.editableGroups);
    setGroupDrafts(
      Object.fromEntries(
        data.keys.map((key) => [
          key.id,
          key.generationGroupId || DEFAULT_GROUP_VALUE,
        ])
      )
    );
    setQuotaDrafts(
      Object.fromEntries(
        data.keys.map((key) => [
          key.id,
          key.creditLimit === null ? "" : String(key.creditLimit),
        ])
      )
    );
  }, []);

  /** 初次加载或人工重试列表；加载失败永不降级为空态。 */
  const loadKeys = useCallback(
    async (initial: boolean) => {
      const loadToken = tryStartExternalApiKeyFullListLoad(activityRef.current);
      if (!loadToken) return;
      if (initial) {
        setLoadStatus("loading");
      } else {
        setIsRefreshing(true);
      }
      setLoadError("");
      try {
        const result = await getExternalApiKeys();
        if (
          !canApplyExternalApiKeyFullListLoad(activityRef.current, loadToken)
        ) {
          return;
        }
        if (result?.data) {
          applyLoadedList(result.data);
          setLoadStatus("ready");
        } else if (initial) {
          setLoadStatus("error");
          setLoadError(getActionError(result, t("errors.load")));
        } else {
          toast.error(getActionError(result, t("errors.load")));
        }
      } finally {
        finishExternalApiKeyFullListLoad(activityRef.current, loadToken);
        setIsRefreshing(false);
      }
    },
    [applyLoadedList, t]
  );

  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    void loadKeys(true);
  }, [loadKeys]);

  /** 把纯 reducer action 安全归并进 React 状态。 */
  const dispatchListAction = useCallback(
    (
      action: Parameters<
        typeof reduceExternalApiKeyListState<ExternalApiKeySummary>
      >[1]
    ) => {
      setListState((current) => reduceExternalApiKeyListState(current, action));
    },
    []
  );

  /** 为单行 mutation 建立同步锁，阻止快速双击绕过 React 提交。 */
  const startRowMutation = useCallback(
    (keyId: string, operation: ExternalApiKeyRowMutation): boolean => {
      if (pendingRowsRef.current.has(keyId)) return false;
      if (!tryStartExternalApiKeyMutation(activityRef.current)) return false;
      pendingRowsRef.current.add(keyId);
      dispatchListAction({
        type: "mutation-started",
        keyId,
        operation,
      });
      return true;
    },
    [dispatchListAction]
  );

  /** 释放同步行锁；纯 reducer 的 pending 状态由成功/失败 action 同步清理。 */
  const finishRowMutation = useCallback((keyId: string): void => {
    pendingRowsRef.current.delete(keyId);
    finishExternalApiKeyMutation(activityRef.current);
  }, []);

  /** mutation 失败后只取目标行真实状态；若行已消失则采用完整服务端列表。 */
  const refreshKeyAfterFailure = useCallback(
    async (keyId: string): Promise<RefreshedKeyResult> => {
      const result = await getExternalApiKeys();
      if (!result?.data) return { status: "failed" };
      setEditableGroups(result.data.editableGroups);
      const refreshedKey = result.data.keys.find((key) => key.id === keyId);
      if (refreshedKey) return { status: "found", key: refreshedKey };
      applyLoadedList(result.data);
      return { status: "missing" };
    },
    [applyLoadedList]
  );

  /** 归并行错误和可用的刷新行，保证竞态失败不会保留虚假旧状态。 */
  const handleRowFailure = useCallback(
    async (
      keyId: string,
      operation: ExternalApiKeyRowMutation,
      message: string
    ): Promise<void> => {
      const refreshed = await refreshKeyAfterFailure(keyId);
      if (refreshed.status !== "missing") {
        dispatchListAction({
          type: "mutation-failed",
          keyId,
          operation,
          error: message,
          ...(refreshed.status === "found"
            ? { refreshedItem: refreshed.key }
            : {}),
        });
      }
      finishRowMutation(keyId);
      toast.error(message);
    },
    [dispatchListAction, finishRowMutation, refreshKeyAfterFailure]
  );

  /** 创建新 Key；不自动重试，也不在成功后发起可能重复创建的刷新请求。 */
  const handleCreateKey = async (): Promise<void> => {
    const creditLimit = parseCreditLimit(newKeyCreditLimit);
    if (creditLimit === undefined) {
      toast.error(t("errors.quotaInvalid"));
      return;
    }
    if (createMutationActiveRef.current) return;
    if (!tryStartExternalApiKeyMutation(activityRef.current)) return;
    createMutationActiveRef.current = true;
    setIsCreating(true);
    try {
      const result = await createExternalApiKey({
        name: keyName.trim() || undefined,
        generationGroupId:
          newKeyGroupId === DEFAULT_GROUP_VALUE ? null : newKeyGroupId,
        creditLimit,
      });
      if (!result?.data) {
        toast.error(
          `${getActionError(result, t("errors.create"))} ${t("errors.createNoRetry")}`
        );
        return;
      }
      setNewKey(result.data.apiKey);
      setNewKeyCreditLimit("");
      setListState((current) => ({
        ...current,
        items: [result.data.key, ...current.items],
      }));
      setGroupDrafts((current) => ({
        ...current,
        [result.data.key.id]:
          result.data.key.generationGroupId || DEFAULT_GROUP_VALUE,
      }));
      setQuotaDrafts((current) => ({
        ...current,
        [result.data.key.id]:
          result.data.key.creditLimit === null
            ? ""
            : String(result.data.key.creditLimit),
      }));
      toast.success(t("success.created"));
    } finally {
      createMutationActiveRef.current = false;
      setIsCreating(false);
      finishExternalApiKeyMutation(activityRef.current);
    }
  };

  /** 复制当前创建结果；按钮保持可用，允许用户重复复制同一个密钥。 */
  const handleCopyNewKey = async (): Promise<void> => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      toast.success(t("success.copied"));
    } catch {
      newKeyInputRef.current?.focus();
      newKeyInputRef.current?.select();
      toast.error(t("errors.copy"));
    }
  };

  /** 保存目标启用 Key 的分组，成功时只替换该行。 */
  const handleSaveGroup = async (keyId: string): Promise<void> => {
    if (!startRowMutation(keyId, "update-group")) return;
    const draft = groupDrafts[keyId] || DEFAULT_GROUP_VALUE;
    const result = await updateExternalApiKeyGroup({
      id: keyId,
      generationGroupId: draft === DEFAULT_GROUP_VALUE ? null : draft,
    });
    if (!result?.data) {
      await handleRowFailure(
        keyId,
        "update-group",
        getActionError(result, t("errors.update"))
      );
      return;
    }
    dispatchListAction({
      type: "mutation-succeeded",
      keyId,
      operation: "update-group",
      item: result.data,
    });
    finishRowMutation(keyId);
    toast.success(t("success.updated"));
  };

  /** 保存目标启用 Key 的积分额度，空值表示不限额。 */
  const handleSaveQuota = async (keyId: string): Promise<void> => {
    const creditLimit = parseCreditLimit(quotaDrafts[keyId] || "");
    if (creditLimit === undefined) {
      toast.error(t("errors.quotaInvalid"));
      return;
    }
    if (!startRowMutation(keyId, "update-quota")) return;
    const result = await updateExternalApiKeyQuota({
      id: keyId,
      creditLimit,
    });
    if (!result?.data) {
      await handleRowFailure(
        keyId,
        "update-quota",
        getActionError(result, t("errors.quota"))
      );
      return;
    }
    dispatchListAction({
      type: "mutation-succeeded",
      keyId,
      operation: "update-quota",
      item: result.data,
    });
    setQuotaDrafts((current) => ({
      ...current,
      [keyId]:
        result.data.creditLimit === null ? "" : String(result.data.creditLimit),
    }));
    finishRowMutation(keyId);
    toast.success(t("success.quotaUpdated"));
  };

  /** 撤销目标启用 Key；重复撤销会刷新并展示真实行状态。 */
  const handleRevokeKey = async (keyId: string): Promise<void> => {
    if (!startRowMutation(keyId, "revoke")) return;
    const result = await revokeExternalApiKey({ id: keyId });
    if (!result?.data) {
      await handleRowFailure(
        keyId,
        "revoke",
        getActionError(result, t("errors.revoke"))
      );
      return;
    }
    dispatchListAction({
      type: "mutation-succeeded",
      keyId,
      operation: "revoke",
      item: result.data,
    });
    finishRowMutation(keyId);
    toast.success(t("success.revoked"));
  };

  /** 删除目标已撤销 Key，并按下一行、上一行、创建区顺序恢复键盘焦点。 */
  const handleDeleteKey = async (keyId: string): Promise<void> => {
    if (!startRowMutation(keyId, "delete")) return;
    const focusTarget = getExternalApiKeyDeleteFocusTarget(
      listState.items,
      keyId
    );
    const result = await deleteExternalApiKey({ id: keyId });
    if (!result?.data) {
      await handleRowFailure(
        keyId,
        "delete",
        getActionError(result, t("errors.delete"))
      );
      return;
    }
    dispatchListAction({
      type: "mutation-succeeded",
      keyId,
      operation: "delete",
    });
    finishRowMutation(keyId);
    window.requestAnimationFrame(() => {
      restoreExternalApiKeyDeleteFocus(
        focusTarget,
        rowTriggerRefs.current,
        createHeadingRef.current
      );
    });
    toast.success(t("success.deleted"));
  };

  /** 显示当前分组；失效现值仍保留名称和不可选状态。 */
  const getCurrentGroupLabel = (key: ExternalApiKeySummary): string => {
    if (!key.generationGroupId) return t("backendGroup.default");
    if (!key.currentGroup) {
      return t("backendGroup.unavailable", {
        id: key.generationGroupId.slice(-8),
      });
    }
    return key.currentGroup.selectable
      ? key.currentGroup.name
      : t("backendGroup.notSelectable", { name: key.currentGroup.name });
  };

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-lg border border-border p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h2
              ref={createHeadingRef}
              tabIndex={-1}
              className="flex items-center gap-2 text-sm font-medium outline-none"
            >
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              {t("createSectionTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("createSectionDescription")}
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              {t("baseUrl", { url: baseUrl })}
            </p>
            <Link
              href={`/${locale}/dashboard/api-docs`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {t("documentation")}
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </div>

        {newKey ? (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3">
            <Label htmlFor="new-external-api-key" className="text-xs">
              {t("newKeyLabel")}
            </Label>
            <div className="mt-2 flex items-center gap-2">
              <Input
                ref={newKeyInputRef}
                id="new-external-api-key"
                value={newKey}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
                className="min-w-0 flex-1 font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                aria-label={t("copy")}
                onClick={() => void handleCopyNewKey()}
              >
                <Copy className="mr-2 h-3.5 w-3.5" />
                {t("copy")}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("copyFallback")}
            </p>
          </div>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.7fr)_auto] lg:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="external-api-key-name">{t("nameLabel")}</Label>
            <Input
              id="external-api-key-name"
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              placeholder={t("namePlaceholder")}
              disabled={isCreating || isFullListLoading}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="external-api-key-group">
              {t("backendGroup.label")}
            </Label>
            <Select
              value={newKeyGroupId}
              onValueChange={setNewKeyGroupId}
              disabled={isCreating || isFullListLoading}
            >
              <SelectTrigger id="external-api-key-group" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_GROUP_VALUE}>
                  {t("backendGroup.default")}
                </SelectItem>
                {editableGroups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="external-api-key-credit-limit">
              {t("quota.label")}
            </Label>
            <Input
              id="external-api-key-credit-limit"
              type="number"
              min={0}
              step="0.01"
              value={newKeyCreditLimit}
              onChange={(event) => setNewKeyCreditLimit(event.target.value)}
              placeholder={t("quota.createPlaceholder")}
              disabled={isCreating || isFullListLoading}
            />
          </div>
          <Button
            type="button"
            onClick={() => void handleCreateKey()}
            disabled={isCreating || isFullListLoading}
          >
            {isCreating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {t("create")}
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">{t("listTitle")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("listDescription")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => void loadKeys(false)}
            disabled={isFullListLoading || hasActiveMutation}
            aria-label={t("refresh")}
          >
            <RefreshCw
              className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
            />
          </Button>
        </div>

        <div className="overflow-hidden rounded-lg border border-border">
          {loadStatus === "loading" ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("loading")}
            </div>
          ) : loadStatus === "error" ? (
            <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
              <XCircle className="h-8 w-8 text-destructive" />
              <div>
                <p className="text-sm font-medium">{t("loadFailed")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {loadError || t("errors.load")}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadKeys(true)}
              >
                {t("retry")}
              </Button>
            </div>
          ) : listState.items.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              {t("empty")}
            </div>
          ) : (
            <>
              <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-4 border-b border-border/60 bg-muted/50 px-4 py-3 text-xs font-medium uppercase tracking-[0.6px] text-muted-foreground md:grid">
                <span>{t("columns.key")}</span>
                <span>{t("columns.quota")}</span>
                <span>{t("columns.group")}</span>
                <span>{t("columns.lastUsed")}</span>
                <span className="sr-only">{t("columns.actions")}</span>
              </div>
              <div className="divide-y divide-border/60">
                {listState.items.map((key) => {
                  const isExpanded = expandedKeyIdSet.has(key.id);
                  const isLocked = isExternalApiKeyRowLocked(listState, key.id);
                  const pendingOperation = listState.pendingByKeyId[key.id];
                  const rowError = listState.errorsByKeyId[key.id];
                  const currentGroupIsEditable =
                    key.generationGroupId !== null &&
                    editableGroupIdSet.has(key.generationGroupId);
                  const groupDraft =
                    groupDrafts[key.id] ||
                    key.generationGroupId ||
                    DEFAULT_GROUP_VALUE;

                  return (
                    <Collapsible
                      key={key.id}
                      open={isExpanded}
                      onOpenChange={() =>
                        dispatchListAction({
                          type: "toggle-expanded",
                          keyId: key.id,
                        })
                      }
                    >
                      <div className="flex flex-col bg-background transition-colors hover:bg-muted/30 md:flex-row md:items-stretch">
                        <CollapsibleTrigger asChild>
                          <button
                            ref={(node) => {
                              if (node)
                                rowTriggerRefs.current.set(key.id, node);
                              else rowTriggerRefs.current.delete(key.id);
                            }}
                            type="button"
                            disabled={isLocked || isRefreshing}
                            className="grid min-w-0 flex-1 cursor-pointer grid-cols-1 gap-3 px-4 py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-wait disabled:opacity-70 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-center md:gap-4"
                            aria-label={
                              isExpanded
                                ? t("collapse", { name: key.name })
                                : t("expand", { name: key.name })
                            }
                          >
                            <span className="min-w-0">
                              <span className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium">
                                  {key.name}
                                </span>
                                <Badge
                                  variant="outline"
                                  className="shrink-0 text-[10px] uppercase tracking-wider"
                                >
                                  {key.isActive ? t("active") : t("revoked")}
                                </Badge>
                              </span>
                              <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                                {key.keyPrefix}...{key.lastFour}
                              </span>
                            </span>
                            <span className="text-sm">
                              <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground md:hidden">
                                {t("columns.quota")}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {t("quota.used")}:{" "}
                                {formatCredits(key.creditsUsed)}
                              </span>
                              <span className="mt-0.5 block text-xs">
                                {key.creditLimit === null
                                  ? t("quota.unlimited")
                                  : `${formatCredits(Math.max(0, key.creditLimit - key.creditsUsed))} / ${formatCredits(key.creditLimit)}`}
                              </span>
                            </span>
                            <span className="min-w-0 text-sm">
                              <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground md:hidden">
                                {t("columns.group")}
                              </span>
                              <span className="block truncate text-xs">
                                {getCurrentGroupLabel(key)}
                              </span>
                            </span>
                            <span className="flex items-center justify-between gap-2 text-sm">
                              <span>
                                <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground md:hidden">
                                  {t("columns.lastUsed")}
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                  {formatDate(
                                    key.lastUsedAt,
                                    t("never"),
                                    locale,
                                    timeZone
                                  )}
                                </span>
                              </span>
                              <ChevronDown
                                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`}
                              />
                            </span>
                          </button>
                        </CollapsibleTrigger>

                        <div className="flex items-center justify-end gap-2 border-t border-border/40 px-4 pb-4 pt-3 md:border-l md:border-t-0 md:py-3">
                          {key.isActive ? (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={isLocked || isRefreshing}
                                >
                                  {pendingOperation === "revoke" ? (
                                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                  ) : null}
                                  {t("revoke")}
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>
                                    {t("confirmRevokeTitle")}
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {t("confirmRevoke", { name: key.name })}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>
                                    {t("cancel")}
                                  </AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => void handleRevokeKey(key.id)}
                                  >
                                    {t("revoke")}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          ) : (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="text-destructive"
                                  disabled={isLocked || isRefreshing}
                                >
                                  {pendingOperation === "delete" ? (
                                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                                  )}
                                  {t("delete")}
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>
                                    {t("confirmDeleteTitle")}
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {t("confirmDelete", { name: key.name })}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>
                                    {t("cancel")}
                                  </AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => void handleDeleteKey(key.id)}
                                  >
                                    {t("delete")}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )}
                        </div>
                      </div>

                      <CollapsibleContent>
                        <div className="border-t border-border/60 bg-muted/20 px-4 py-4">
                          {rowError ? (
                            <p
                              role="alert"
                              className="mb-4 text-xs text-destructive"
                            >
                              {rowError.message}
                            </p>
                          ) : null}
                          {key.isActive ? (
                            <div className="grid gap-4 lg:grid-cols-2">
                              <div className="space-y-2">
                                <Label htmlFor={`external-key-group-${key.id}`}>
                                  {t("backendGroup.label")}
                                </Label>
                                <div className="flex flex-col gap-2 sm:flex-row">
                                  <Select
                                    value={groupDraft}
                                    onValueChange={(value) =>
                                      setGroupDrafts((current) => ({
                                        ...current,
                                        [key.id]: value,
                                      }))
                                    }
                                    disabled={isLocked || isRefreshing}
                                  >
                                    <SelectTrigger
                                      id={`external-key-group-${key.id}`}
                                      className="w-full"
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value={DEFAULT_GROUP_VALUE}>
                                        {t("backendGroup.default")}
                                      </SelectItem>
                                      {key.generationGroupId &&
                                      !currentGroupIsEditable ? (
                                        <SelectItem
                                          value={key.generationGroupId}
                                          disabled
                                        >
                                          {getCurrentGroupLabel(key)}
                                        </SelectItem>
                                      ) : null}
                                      {editableGroups.map((group) => (
                                        <SelectItem
                                          key={group.id}
                                          value={group.id}
                                        >
                                          {group.name}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => void handleSaveGroup(key.id)}
                                    disabled={isLocked || isRefreshing}
                                  >
                                    {pendingOperation === "update-group" ? (
                                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                    ) : null}
                                    {t("save")}
                                  </Button>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  {t("backendGroup.hint")}
                                </p>
                              </div>

                              <div className="space-y-2">
                                <Label htmlFor={`external-key-quota-${key.id}`}>
                                  {t("quota.label")}
                                </Label>
                                <div className="flex flex-col gap-2 sm:flex-row">
                                  <Input
                                    id={`external-key-quota-${key.id}`}
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    value={quotaDrafts[key.id] ?? ""}
                                    onChange={(event) =>
                                      setQuotaDrafts((current) => ({
                                        ...current,
                                        [key.id]: event.target.value,
                                      }))
                                    }
                                    placeholder={t("quota.placeholder")}
                                    disabled={isLocked || isRefreshing}
                                  />
                                  <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => void handleSaveQuota(key.id)}
                                    disabled={isLocked || isRefreshing}
                                  >
                                    {pendingOperation === "update-quota" ? (
                                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                    ) : null}
                                    {t("quota.save")}
                                  </Button>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  {t("quota.description")}
                                </p>
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-1 text-sm">
                              <p className="font-medium">
                                {t("revokedReadOnlyTitle")}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {t("revokedReadOnlyDescription")}
                              </p>
                            </div>
                          )}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
