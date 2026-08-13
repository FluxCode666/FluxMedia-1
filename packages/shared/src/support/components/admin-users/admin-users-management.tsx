/**
 * 管理后台用户列表与详情工作台。
 *
 * 职责：提供用户检索、账户运维、审核策略管理与管理员审计视图；所有写操作
 * 委托给 support Server Actions，组件只负责权限感知的交互和结果展示。
 */
"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/ui/components/avatar";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { PaginationControls } from "@repo/ui/components/pagination-controls";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@repo/ui/components/sheet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/ui/components/tabs";
import { Textarea } from "@repo/ui/components/textarea";
import {
  Ban,
  Coins,
  CreditCard,
  Eye,
  KeyRound,
  Loader2,
  Lock,
  MoreHorizontal,
  Search,
  Shield,
  Unlock,
  UserCheck,
  UserPlus,
  Users,
  XCircle,
} from "lucide-react";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import {
  APP_USER_ROLES,
  type AppUserRole,
  canActOnTargetRole,
  getUserRoleLabel,
} from "../../../auth/roles";
import { formatCredits } from "../../../credits/format";
import type { MediaLimitsForUser } from "../../../image-generation/media-limit-service";
import type {
  ModerationBlockRiskLevel,
  ModerationPolicySource,
} from "../../../moderation/policy-contract";
import { getPaginationWindow } from "../../../pagination/state";
import { buildStorageThumbnailUrl } from "../../../storage/signed-url";
import { formatDateInTimeZone } from "../../../time-zone";
import {
  adminAdjustCreditsAction,
  adminGrantCreditsAction,
  banUserAction,
  createUserAction,
  getAllUsersAction,
  getUserDetailAction,
  setExternalApiKeyStatusAction,
  setUserCreditsStatusAction,
  setUserPasswordAction,
  updateUserProfileAction,
  updateUserRoleAction,
} from "../../actions/admin-users";
import { ModerationPolicyControl } from "./moderation-policy-control";
import { UserConcurrencyControl } from "./user-concurrency-control";

type UserStatusFilter = "all" | "active" | "banned" | "unverified";
type CreditsStatusFilter = "all" | "active" | "frozen";

/** 将 URL 页码收窄为安全正整数，非法值回退到默认值。 */
function parseUrlPositiveInteger(value: string | null, fallback: number) {
  return value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Math.max(1, Number(value))
    : fallback;
}

/** 仅接受产品确认的 10/20/50 页大小。 */
function parseAdminUserPageSize(value: string | null): 10 | 20 | 50 {
  if (value === "10") return 10;
  if (value === "50") return 50;
  return 20;
}

/** 将 URL 用户状态筛选收窄到白名单。 */
function parseUserStatus(value: string | null): UserStatusFilter {
  return value === "active" || value === "banned" || value === "unverified"
    ? value
    : "all";
}

/** 将 URL 积分状态筛选收窄到白名单。 */
function parseCreditsStatus(value: string | null): CreditsStatusFilter {
  return value === "active" || value === "frozen" ? value : "all";
}

type UserRow = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: AppUserRole;
  banned: boolean;
  bannedReason: string | null;
  emailVerified: boolean;
  imageGenerationConcurrencyOverride: number | null;
  createdAt: Date;
  updatedAt: Date;
  creditsBalance: number;
  creditsTotalEarned: number;
  creditsTotalSpent: number;
  creditsStatus: "active" | "frozen";
  generationCount: number;
  failedGenerationCount: number;
  apiKeyCount: number;
  activeApiKeyCount: number;
};

type UserDetail = {
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    role: AppUserRole;
    banned: boolean;
    bannedReason: string | null;
    emailVerified: boolean;
    createdAt: Date;
    updatedAt: Date;
  };
  creditsBalance: {
    balance: number;
    totalEarned: number;
    totalSpent: number;
    status: "active" | "frozen";
    createdAt: Date;
    updatedAt: Date;
  } | null;
  activeBatches: Array<{
    id: string;
    amount: number;
    remaining: number;
    expiresAt: Date | null;
    sourceType: string;
    sourceRef: string | null;
    issuedAt: Date;
  }>;
  transactions: Array<{
    id: string;
    type: string;
    amount: number;
    description: string | null;
    createdAt: Date;
  }>;
  generations: Array<{
    id: string;
    prompt: string;
    model: string;
    size: string;
    status: "pending" | "completed" | "failed";
    creditsConsumed: number;
    error: string | null;
    imageUrl: string | null;
    createdAt: Date;
  }>;
  apiKeys: Array<{
    id: string;
    name: string;
    keyPrefix: string;
    lastFour: string;
    creditLimit: number | null;
    creditsUsed: number;
    lastUsedAt: Date | null;
    isActive: boolean;
    createdAt: Date;
  }>;
  auditLogs: Array<{
    id: string;
    adminUserId: string | null;
    action: string;
    reason: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  }>;
  moderationPolicy: {
    globalDefault: ModerationBlockRiskLevel;
    userOverride: ModerationBlockRiskLevel | null;
    effectiveLevel: ModerationBlockRiskLevel;
    source: ModerationPolicySource;
  };
  mediaLimits: MediaLimitsForUser;
  generationSummary: {
    total: number;
    completed: number;
    failed: number;
    creditsConsumed: number;
  };
};

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
const ROLE_OPTIONS: Array<{ value: AppUserRole; label: string }> =
  APP_USER_ROLES.map((role) => ({
    value: role,
    label: getUserRoleLabel(role),
  }));

function formatDateTime(value?: Date | string | null, timeZone?: string) {
  if (!value) {
    return "-";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return formatDateInTimeZone(
    date,
    "zh",
    {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    },
    timeZone
  );
}

function getInitials(name: string) {
  return name
    .split(" ")
    .map((item) => item[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function generationStatusBadge(status: string) {
  if (status === "completed") {
    return (
      <Badge variant="secondary" className="bg-success/10 text-success">
        成功
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="secondary" className="bg-destructive/10 text-destructive">
        失败
      </Badge>
    );
  }
  return <Badge variant="secondary">处理中</Badge>;
}

function userRoleBadge(role: AppUserRole) {
  if (role === "super_admin") {
    return <Badge className="bg-foreground text-background">超管</Badge>;
  }
  if (role === "admin") {
    return <Badge variant="secondary">管理员</Badge>;
  }
  if (role === "observer_admin") {
    return <Badge variant="outline">观察管理员</Badge>;
  }
  return null;
}

const MODERATION_POLICY_AUDIT_ACTION =
  "moderation.setUserRiskLevelOverride" as const;
const MODERATION_LEVEL_LABELS: Record<ModerationBlockRiskLevel, string> = {
  low: "low（严格）",
  medium: "medium（均衡）",
  high: "high（宽松）",
};

/**
 * 从审计 metadata 读取非空字符串，避免信任 JSON 字段形状。
 *
 * @param metadata - 数据库返回的未信任审计元数据。
 * @param key - 需要读取的字段名。
 * @returns 非空字符串；字段缺失或类型非法时返回 null。
 */
function readAuditMetadataString(
  metadata: Record<string, unknown> | null,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * 把审核策略审计快照转换为稳定文案。
 *
 * @param snapshot - before 或 after JSON 快照。
 * @returns 合法级别、"继承全站"或"未知"；不会原样输出未信任 JSON。
 */
function formatModerationAuditLevel(
  snapshot: Record<string, unknown> | null
): string {
  const level = snapshot?.level;
  if (level === null) {
    return "继承全站";
  }
  if (level === "low" || level === "medium" || level === "high") {
    return MODERATION_LEVEL_LABELS[level];
  }
  return "未知";
}

/**
 * 把审计中的目标角色安全转换为中文角色名。
 *
 * @param metadata - 数据库返回的未信任审计元数据。
 * @returns 合法目标角色的中文名，缺失或非法时返回短横线。
 */
function formatAuditTargetRole(
  metadata: Record<string, unknown> | null
): string {
  const role = readAuditMetadataString(metadata, "targetRole");
  return role && APP_USER_ROLES.includes(role as AppUserRole)
    ? getUserRoleLabel(role)
    : "-";
}

/**
 * 渲染一次用户审核策略变更审计。
 *
 * @param props - 审计记录与管理员时区。
 * @returns 结构化的前后值、操作者、原因、请求 ID、目标角色和时间。
 */
function ModerationPolicyAuditEntry({
  log,
  timeZone,
}: {
  log: UserDetail["auditLogs"][number];
  timeZone: string | undefined;
}) {
  const actorUserId =
    log.adminUserId ??
    readAuditMetadataString(log.metadata, "actorUserId") ??
    "-";
  const requestId = readAuditMetadataString(log.metadata, "requestId") ?? "-";

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <span className="font-medium">用户审核级别变更</span>
        <span className="text-xs text-muted-foreground">
          {formatDateTime(log.createdAt, timeZone)}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge variant="outline">
          {formatModerationAuditLevel(log.before)}
        </Badge>
        <span className="text-muted-foreground" aria-hidden="true">
          →
        </span>
        <Badge variant="secondary">
          {formatModerationAuditLevel(log.after)}
        </Badge>
      </div>
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-muted-foreground">变更原因</dt>
          <dd className="mt-0.5 break-words">{log.reason || "未填写原因"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">管理员</dt>
          <dd className="mt-0.5 break-all font-mono">{actorUserId}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">目标角色</dt>
          <dd className="mt-0.5">{formatAuditTargetRole(log.metadata)}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-muted-foreground">请求 ID</dt>
          <dd className="mt-0.5 break-all font-mono">{requestId}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * 提供管理员用户列表、详情与受权限约束的运维操作。
 *
 * @param props - 当前管理员角色、超管能力标志与显示时区。
 * @returns 用户管理工作台；加载或写入失败时通过 toast 向管理员反馈。
 */
export function AdminUsersManagement({
  actorRole,
  canManageRoles = false,
  timeZone,
}: {
  actorRole: AppUserRole;
  canManageRoles?: boolean;
  timeZone?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isNavigating, startNavigation] = useTransition();
  const requestedPage = parseUrlPositiveInteger(searchParams.get("page"), 1);
  const requestedPageSize = parseAdminUserPageSize(
    searchParams.get("pageSize")
  );
  const requestedQuery = searchParams.get("query")?.trim() ?? "";
  const requestedStatus = parseUserStatus(searchParams.get("status"));
  const requestedCreditsStatus = parseCreditsStatus(
    searchParams.get("creditsStatus")
  );

  /** 更新用户列表归属 URL；保留未知安全参数，筛选或页大小变化回第一页。 */
  const replaceListUrl = (update: {
    page?: number;
    pageSize?: number;
    query?: string;
    status?: UserStatusFilter;
    creditsStatus?: CreditsStatusFilter;
  }) => {
    const next = new URLSearchParams(searchParams.toString());
    const isCriteriaChange =
      update.pageSize !== undefined ||
      update.query !== undefined ||
      update.status !== undefined ||
      update.creditsStatus !== undefined;
    if (isCriteriaChange) next.delete("page");
    if (update.page !== undefined && !isCriteriaChange) {
      if (update.page === 1) next.delete("page");
      else next.set("page", String(update.page));
    }
    if (update.pageSize !== undefined) {
      if (update.pageSize === 20) next.delete("pageSize");
      else next.set("pageSize", String(update.pageSize));
    }
    if (update.query !== undefined) {
      if (update.query) next.set("query", update.query);
      else next.delete("query");
    }
    if (update.status !== undefined) {
      if (update.status === "all") next.delete("status");
      else next.set("status", update.status);
    }
    if (update.creditsStatus !== undefined) {
      if (update.creditsStatus === "all") next.delete("creditsStatus");
      else next.set("creditsStatus", update.creditsStatus);
    }
    next.sort();
    const queryString = next.toString();
    const href = queryString ? `${pathname}?${queryString}` : pathname;
    startNavigation(() => {
      router.replace(href, {
        scroll: false,
      });
    });
  };
  const [users, setUsers] = useState<UserRow[]>([]);
  const [stats, setStats] = useState({
    totalUsers: 0,
    admins: 0,
    banned: 0,
  });
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 20,
    totalCount: 0,
    totalPages: 1,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [queryInput, setQueryInput] = useState(requestedQuery);
  const listRequestGenerationRef = useRef(0);

  const [selectedUser, setSelectedUser] = useState<UserRow | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);

  const [grantOpen, setGrantOpen] = useState(false);
  const [grantAmount, setGrantAmount] = useState("");
  const [grantReason, setGrantReason] = useState("");
  const [isGranting, setIsGranting] = useState(false);

  const [creditAdjustOpen, setCreditAdjustOpen] = useState(false);
  const [creditAdjustAmount, setCreditAdjustAmount] = useState("");
  const [creditAdjustReason, setCreditAdjustReason] = useState("");
  const [isAdjustingCredits, setIsAdjustingCredits] = useState(false);

  const [banOpen, setBanOpen] = useState(false);
  const [banReason, setBanReason] = useState("");
  const [isBanning, setIsBanning] = useState(false);

  const [creditsDialogOpen, setCreditsDialogOpen] = useState(false);
  const [creditsReason, setCreditsReason] = useState("");
  const [targetCreditsStatus, setTargetCreditsStatus] =
    useState<CreditsStatusFilter>("frozen");
  const [isSettingCreditsStatus, setIsSettingCreditsStatus] = useState(false);

  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<
    UserDetail["apiKeys"][number] | null
  >(null);
  const [targetKeyStatus, setTargetKeyStatus] = useState(false);
  const [keyReason, setKeyReason] = useState("");
  const [isSettingKeyStatus, setIsSettingKeyStatus] = useState(false);

  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [targetRole, setTargetRole] = useState<AppUserRole>("user");
  const [roleReason, setRoleReason] = useState("");
  const [isSettingRole, setIsSettingRole] = useState(false);

  // 新增用户 Dialog 状态
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createRole, setCreateRole] = useState<AppUserRole>("user");
  const [createReason, setCreateReason] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  // 编辑资料 Dialog 状态
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileEmail, setProfileEmail] = useState("");
  const [profileReason, setProfileReason] = useState("");
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  // 重设密码 Dialog 状态
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [passwordReason, setPasswordReason] = useState("");
  const [isSettingPassword, setIsSettingPassword] = useState(false);

  const startIndex =
    pagination.totalCount === 0
      ? 0
      : (pagination.page - 1) * pagination.pageSize + 1;
  const endIndex = Math.min(
    pagination.page * pagination.pageSize,
    pagination.totalCount
  );

  /** 读取当前 URL 对应用户页，并用世代号隔离快速导航产生的过期响应。 */
  const loadUsers = useCallback(async () => {
    const requestGeneration = listRequestGenerationRef.current + 1;
    listRequestGenerationRef.current = requestGeneration;
    setIsLoading(true);
    try {
      const result = await getAllUsersAction({
        query: requestedQuery,
        page: requestedPage,
        pageSize: requestedPageSize,
        status: requestedStatus,
        creditsStatus: requestedCreditsStatus,
      });
      if (requestGeneration !== listRequestGenerationRef.current) return;
      if (result?.data) {
        setUsers(result.data.users as UserRow[]);
        setStats(result.data.stats);
        setPagination(result.data.pagination);
      } else if (result?.serverError) {
        toast.error(result.serverError);
      }
    } catch (error) {
      if (requestGeneration !== listRequestGenerationRef.current) return;
      toast.error(error instanceof Error ? error.message : "加载用户列表失败");
    } finally {
      if (requestGeneration === listRequestGenerationRef.current) {
        setIsLoading(false);
      }
    }
  }, [
    requestedCreditsStatus,
    requestedPage,
    requestedPageSize,
    requestedQuery,
    requestedStatus,
  ]);

  useEffect(() => {
    setQueryInput(requestedQuery);
    void loadUsers();
  }, [loadUsers, requestedQuery]);

  const reloadCurrent = async () => {
    await loadUsers();
    if (selectedUser && detailOpen) {
      await loadDetail(selectedUser.id, false);
    }
  };

  const loadDetail = async (userId: string, open = true) => {
    if (open) {
      setDetailOpen(true);
    }
    setIsDetailLoading(true);
    try {
      const result = await getUserDetailAction({ userId });
      if (result?.data) {
        setDetail(result.data as UserDetail);
      } else if (result?.serverError) {
        toast.error(result.serverError);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载用户详情失败");
    } finally {
      setIsDetailLoading(false);
    }
  };

  const openDetail = (userRow: UserRow) => {
    setSelectedUser(userRow);
    setDetail(null);
    void loadDetail(userRow.id);
  };

  const openGrantDialog = (userRow: UserRow) => {
    setSelectedUser(userRow);
    setGrantAmount("");
    setGrantReason("");
    setGrantOpen(true);
  };

  const openCreditAdjustDialog = (userRow: UserRow) => {
    setSelectedUser(userRow);
    setCreditAdjustAmount("");
    setCreditAdjustReason("");
    setCreditAdjustOpen(true);
  };

  const openBanDialog = (userRow: UserRow) => {
    setSelectedUser(userRow);
    setBanReason("");
    setBanOpen(true);
  };

  const openCreditsDialog = (
    userRow: UserRow,
    nextStatus: "active" | "frozen"
  ) => {
    setSelectedUser(userRow);
    setTargetCreditsStatus(nextStatus);
    setCreditsReason("");
    setCreditsDialogOpen(true);
  };

  const openKeyDialog = (
    key: UserDetail["apiKeys"][number],
    isActive: boolean
  ) => {
    setSelectedKey(key);
    setTargetKeyStatus(isActive);
    setKeyReason("");
    setKeyDialogOpen(true);
  };

  const openRoleDialog = (userRow: UserRow) => {
    setSelectedUser(userRow);
    setTargetRole(userRow.role);
    setRoleReason("");
    setRoleDialogOpen(true);
  };

  const openCreateDialog = () => {
    setCreateName("");
    setCreateEmail("");
    setCreatePassword("");
    setCreateRole("user");
    setCreateReason("");
    setCreateOpen(true);
  };

  const openProfileDialog = (userRow: UserRow) => {
    setSelectedUser(userRow);
    setProfileName(userRow.name);
    setProfileEmail(userRow.email);
    setProfileReason("");
    setProfileOpen(true);
  };

  const openPasswordDialog = (userRow: UserRow) => {
    setSelectedUser(userRow);
    setNewPassword("");
    setPasswordReason("");
    setPasswordOpen(true);
  };

  const handleCreateUser = async () => {
    if (!canManageRoles) {
      toast.error("只有超管可以创建用户");
      return;
    }
    if (!createName.trim() || !createEmail.trim()) {
      toast.error("请填写用户名和邮箱");
      return;
    }
    if (createPassword.length < 8) {
      toast.error("密码至少 8 位");
      return;
    }
    if (!createReason.trim()) {
      toast.error("请填写操作原因");
      return;
    }
    setIsCreating(true);
    try {
      const result = await createUserAction({
        name: createName.trim(),
        email: createEmail.trim(),
        password: createPassword,
        role: createRole,
        emailVerified: true,
        reason: createReason.trim(),
      });
      if (result?.data) {
        toast.success(result.data.message);
        setCreateOpen(false);
        if (requestedPage === 1) await loadUsers();
        else replaceListUrl({ page: 1 });
      } else if (result?.serverError) {
        toast.error(result.serverError);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建用户失败");
    } finally {
      setIsCreating(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!selectedUser) {
      return;
    }
    if (!canManageRoles) {
      toast.error("只有超管可以编辑用户资料");
      return;
    }
    if (!profileName.trim() || !profileEmail.trim()) {
      toast.error("用户名和邮箱不能为空");
      return;
    }
    if (!profileReason.trim()) {
      toast.error("请填写操作原因");
      return;
    }
    setIsSavingProfile(true);
    try {
      const result = await updateUserProfileAction({
        userId: selectedUser.id,
        name: profileName.trim(),
        email: profileEmail.trim(),
        reason: profileReason.trim(),
      });
      if (result?.data) {
        toast.success(result.data.message);
        setProfileOpen(false);
        await reloadCurrent();
      } else if (result?.serverError) {
        toast.error(result.serverError);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存资料失败");
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleSetPassword = async () => {
    if (!selectedUser) {
      return;
    }
    if (!canManageRoles) {
      toast.error("只有超管可以重设密码");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("密码至少 8 位");
      return;
    }
    if (!passwordReason.trim()) {
      toast.error("请填写操作原因");
      return;
    }
    setIsSettingPassword(true);
    try {
      const result = await setUserPasswordAction({
        userId: selectedUser.id,
        password: newPassword,
        reason: passwordReason.trim(),
      });
      if (result?.data) {
        toast.success(result.data.message);
        setPasswordOpen(false);
        setNewPassword("");
      } else if (result?.serverError) {
        toast.error(result.serverError);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重设密码失败");
    } finally {
      setIsSettingPassword(false);
    }
  };

  const handleSearch = (event: React.FormEvent) => {
    event.preventDefault();
    replaceListUrl({ page: 1, query: queryInput.trim() });
  };

  const clearFilters = () => {
    setQueryInput("");
    replaceListUrl({
      page: 1,
      query: "",
      status: "all",
      creditsStatus: "all",
    });
  };

  const handleGrant = async () => {
    if (!selectedUser) {
      return;
    }
    const amount = Number.parseFloat(grantAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("请输入有效的积分数量");
      return;
    }
    if (!grantReason.trim()) {
      toast.error("请填写充值原因");
      return;
    }
    setIsGranting(true);
    try {
      const result = await adminGrantCreditsAction({
        userId: selectedUser.id,
        amount,
        reason: grantReason.trim(),
      });
      if (result?.data) {
        toast.success(result.data.message);
        setGrantOpen(false);
        await reloadCurrent();
      } else if (result?.serverError) {
        toast.error(result.serverError);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "充值失败");
    } finally {
      setIsGranting(false);
    }
  };

  const handleCreditAdjust = async () => {
    if (!selectedUser) {
      return;
    }
    if (!canManageRoles) {
      toast.error("只有超管可以调整用户积分");
      return;
    }
    const amount = Number.parseFloat(creditAdjustAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error("请输入有效的积分数量");
      return;
    }
    if (amount <= 0) {
      toast.error("扣减积分必须大于 0");
      return;
    }
    if (!creditAdjustReason.trim()) {
      toast.error("请填写操作原因");
      return;
    }
    setIsAdjustingCredits(true);
    try {
      const result = await adminAdjustCreditsAction({
        userId: selectedUser.id,
        amount,
        reason: creditAdjustReason.trim(),
      });
      if (result?.data) {
        toast.success(result.data.message);
        setCreditAdjustOpen(false);
        await reloadCurrent();
      } else if (result?.serverError) {
        toast.error(result.serverError);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "积分调整失败");
    } finally {
      setIsAdjustingCredits(false);
    }
  };

  const handleBan = async () => {
    if (!selectedUser) {
      return;
    }
    setIsBanning(true);
    try {
      const result = await banUserAction({
        userId: selectedUser.id,
        banned: !selectedUser.banned,
        reason: banReason.trim() || undefined,
      });
      if (result?.data) {
        toast.success(result.data.message);
        setBanOpen(false);
        await reloadCurrent();
      } else if (result?.serverError) {
        toast.error(result.serverError);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setIsBanning(false);
    }
  };

  const handleCreditsStatus = async () => {
    if (!selectedUser || targetCreditsStatus === "all") {
      return;
    }
    if (!creditsReason.trim()) {
      toast.error("请填写操作原因");
      return;
    }
    setIsSettingCreditsStatus(true);
    try {
      const result = await setUserCreditsStatusAction({
        userId: selectedUser.id,
        status: targetCreditsStatus,
        reason: creditsReason.trim(),
      });
      if (result?.data) {
        toast.success(result.data.message);
        setCreditsDialogOpen(false);
        await reloadCurrent();
      } else if (result?.serverError) {
        toast.error(result.serverError);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setIsSettingCreditsStatus(false);
    }
  };

  const handleKeyStatus = async () => {
    if (!selectedKey) {
      return;
    }
    if (!keyReason.trim()) {
      toast.error("请填写操作原因");
      return;
    }
    setIsSettingKeyStatus(true);
    try {
      const result = await setExternalApiKeyStatusAction({
        keyId: selectedKey.id,
        isActive: targetKeyStatus,
        reason: keyReason.trim(),
      });
      if (result?.data) {
        toast.success(result.data.message);
        setKeyDialogOpen(false);
        await reloadCurrent();
      } else if (result?.serverError) {
        toast.error(result.serverError);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setIsSettingKeyStatus(false);
    }
  };

  const handleRoleChange = async () => {
    if (!selectedUser) {
      return;
    }
    if (!canManageRoles) {
      toast.error("只有超管可以修改用户角色");
      return;
    }
    if (targetRole === selectedUser.role) {
      setRoleDialogOpen(false);
      return;
    }
    if (!roleReason.trim()) {
      toast.error("请填写操作原因");
      return;
    }
    setIsSettingRole(true);
    try {
      const result = await updateUserRoleAction({
        userId: selectedUser.id,
        role: targetRole,
        reason: roleReason.trim(),
      });
      if (result?.data) {
        toast.success(result.data.message);
        setRoleDialogOpen(false);
        await reloadCurrent();
      } else if (result?.serverError) {
        toast.error(result.serverError);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setIsSettingRole(false);
    }
  };

  const detailBalance = detail?.creditsBalance;
  const detailGenerationRate = useMemo(() => {
    if (!detail?.generationSummary.total) {
      return "0%";
    }
    return `${Math.round(
      (detail.generationSummary.completed / detail.generationSummary.total) *
        100
    )}%`;
  }, [detail]);
  const canManageModerationPolicy = detail
    ? canActOnTargetRole(actorRole, detail.user.role)
    : false;
  const moderationPolicyReadOnlyReason =
    actorRole === "admin"
      ? "目标用户权限不低于当前管理员，仅可查看其审核策略。"
      : "当前管理员角色没有修改该用户审核策略的权限。";
  const concurrencyReadOnlyReason =
    actorRole === "admin"
      ? "目标用户权限不低于当前管理员，仅可查看其生图并发限制。"
      : "当前管理员角色没有修改该用户生图并发限制的权限。";

  return (
    <div className="space-y-6">
      <div className="animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none">
        <div>
          <h2 className="font-serif text-2xl font-medium tracking-tight">
            用户管理
          </h2>
          <p className="text-muted-foreground">
            查询用户、排查积分和生图问题，并记录关键后台操作。
          </p>
        </div>
      </div>

      {/* 统计卡:入场错峰放外层包裹,hover 过渡放卡片(duration 工具类共享
          同一 CSS 变量,同元素叠加会互相覆盖)。 */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[
          { label: "总用户", value: stats.totalUsers, icon: Users },
          { label: "管理员", value: stats.admins, icon: Shield },
          { label: "已封禁", value: stats.banned, icon: Ban },
        ].map((item, index) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className="animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none"
              style={{
                animationDelay: `${index * 60}ms`,
                animationFillMode: "backwards",
              }}
            >
              <Card className="h-full transition-all duration-250 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-whisper">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {item.label}
                  </CardTitle>
                  <Icon className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="font-serif text-3xl font-medium tracking-tight">
                    {item.value}
                  </div>
                </CardContent>
              </Card>
            </div>
          );
        })}
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <form
            onSubmit={handleSearch}
            className="flex flex-col gap-3 lg:flex-row"
          >
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={queryInput}
                onChange={(event) => setQueryInput(event.target.value)}
                placeholder="搜索邮箱、用户名或用户 ID"
                className="pl-10"
              />
            </div>
            <Button type="submit" disabled={isLoading}>
              搜索
            </Button>
            <Button type="button" variant="outline" onClick={clearFilters}>
              清除
            </Button>
          </form>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Select
              value={requestedStatus}
              onValueChange={(value) =>
                replaceListUrl({
                  page: 1,
                  status: value as UserStatusFilter,
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="active">正常用户</SelectItem>
                <SelectItem value="banned">已封禁</SelectItem>
                <SelectItem value="unverified">邮箱未验证</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={requestedCreditsStatus}
              onValueChange={(value) =>
                replaceListUrl({
                  page: 1,
                  creditsStatus: value as CreditsStatusFilter,
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部积分账户</SelectItem>
                <SelectItem value="active">积分正常</SelectItem>
                <SelectItem value="frozen">积分冻结</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(requestedPageSize)}
              onValueChange={(value) =>
                replaceListUrl({
                  page: 1,
                  pageSize: Number(value),
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    每页 {size} 条
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <CardTitle>用户列表</CardTitle>
            <p className="text-sm text-muted-foreground">
              {pagination.totalCount > 0
                ? `显示 ${startIndex}-${endIndex} / 共 ${pagination.totalCount} 位`
                : "没有匹配用户"}
            </p>
          </div>
          {canManageRoles ? (
            <Button onClick={openCreateDialog}>
              <UserPlus className="mr-2 h-4 w-4" />
              新增用户
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
            </div>
          ) : users.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              没有找到匹配的用户
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">用户</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">积分</th>
                    <th className="px-4 py-3 font-medium">生图</th>
                    <th className="px-4 py-3 font-medium">API Key</th>
                    <th className="px-4 py-3 font-medium">注册时间</th>
                    <th className="px-4 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {users.map((item) => {
                    const failureRate =
                      item.generationCount > 0
                        ? Math.round(
                            (item.failedGenerationCount /
                              item.generationCount) *
                              100
                          )
                        : 0;
                    return (
                      <tr
                        key={item.id}
                        className="transition-colors duration-150 hover:bg-muted/50"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <Avatar className="h-9 w-9">
                              <AvatarImage
                                src={item.image || undefined}
                                alt={item.name}
                              />
                              <AvatarFallback className="bg-foreground text-xs text-background">
                                {getInitials(item.name)}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="truncate font-medium">
                                  {item.name}
                                </span>
                                {userRoleBadge(item.role)}
                              </div>
                              <p className="truncate text-xs text-muted-foreground">
                                {item.email}
                              </p>
                              <p className="truncate text-[11px] text-muted-foreground">
                                {item.id}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-1">
                            {item.banned ? (
                              <Badge className="w-fit bg-destructive/10 text-destructive">
                                已封禁
                              </Badge>
                            ) : item.emailVerified ? (
                              <Badge className="w-fit bg-success/10 text-success">
                                已验证
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="w-fit">
                                未验证
                              </Badge>
                            )}
                            {item.creditsStatus === "frozen" ? (
                              <Badge className="w-fit bg-warning/10 text-warning">
                                积分冻结
                              </Badge>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            {formatCredits(item.creditsBalance)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            消耗 {formatCredits(item.creditsTotalSpent)}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            {item.generationCount} 次
                          </div>
                          <div className="text-xs text-muted-foreground">
                            失败 {item.failedGenerationCount} · {failureRate}%
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            {item.activeApiKeyCount}/{item.apiKeyCount}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            启用 / 总数
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          {formatDateTime(item.createdAt, timeZone)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openDetail(item)}
                            >
                              <Eye className="mr-2 h-4 w-4" />
                              详情
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon-sm" variant="outline">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={() => openGrantDialog(item)}
                                >
                                  <Coins className="h-4 w-4" />
                                  加积分
                                </DropdownMenuItem>
                                {canManageRoles && (
                                  <DropdownMenuItem
                                    onClick={() => openCreditAdjustDialog(item)}
                                  >
                                    <CreditCard className="h-4 w-4" />
                                    减积分
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  onClick={() => openBanDialog(item)}
                                >
                                  {item.banned ? (
                                    <UserCheck className="h-4 w-4" />
                                  ) : (
                                    <Ban className="h-4 w-4" />
                                  )}
                                  {item.banned ? "解除封禁" : "封禁用户"}
                                </DropdownMenuItem>
                                {canManageRoles && (
                                  <DropdownMenuItem
                                    onClick={() => openRoleDialog(item)}
                                  >
                                    <Shield className="h-4 w-4" />
                                    修改角色
                                  </DropdownMenuItem>
                                )}
                                {canManageRoles && (
                                  <DropdownMenuItem
                                    onClick={() => openProfileDialog(item)}
                                  >
                                    <UserCheck className="h-4 w-4" />
                                    编辑资料
                                  </DropdownMenuItem>
                                )}
                                {canManageRoles && (
                                  <DropdownMenuItem
                                    onClick={() => openPasswordDialog(item)}
                                  >
                                    <KeyRound className="h-4 w-4" />
                                    重设密码
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() =>
                                    openCreditsDialog(
                                      item,
                                      item.creditsStatus === "frozen"
                                        ? "active"
                                        : "frozen"
                                    )
                                  }
                                >
                                  {item.creditsStatus === "frozen" ? (
                                    <Unlock className="h-4 w-4" />
                                  ) : (
                                    <Lock className="h-4 w-4" />
                                  )}
                                  {item.creditsStatus === "frozen"
                                    ? "解冻积分"
                                    : "冻结积分"}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 flex flex-col gap-3 border-t pt-4 md:flex-row md:items-center md:justify-between">
            <p className="text-sm text-muted-foreground">
              第 {pagination.page} / {pagination.totalPages} 页
            </p>
            <PaginationControls
              ariaLabel="用户列表分页"
              className="justify-end"
              disabled={isLoading || isNavigating}
              getPageLabel={(pageNumber, isCurrent) =>
                isCurrent
                  ? `第 ${pageNumber} 页，当前页`
                  : `前往第 ${pageNumber} 页`
              }
              items={getPaginationWindow(
                pagination.page,
                pagination.totalPages
              )}
              nextLabel="下一页"
              onPageChange={(page) => replaceListUrl({ page })}
              page={pagination.page}
              pageSelectLabel="选择用户列表页码"
              previousLabel="上一页"
              totalPages={pagination.totalPages}
            />
          </div>
        </CardContent>
      </Card>

      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent
          className="flex w-full flex-col overflow-hidden p-0 sm:max-w-4xl xl:max-w-5xl"
          style={{
            top: 12,
            right: 12,
            bottom: 12,
            height: "calc(100dvh - 24px)",
            maxHeight: "calc(100dvh - 24px)",
          }}
        >
          <SheetHeader className="shrink-0 border-b px-6 py-5 pr-12">
            <SheetTitle>用户详情</SheetTitle>
            <SheetDescription>
              {selectedUser
                ? `${selectedUser.name} · ${selectedUser.email}`
                : "查看用户账户、积分、生图和 API Key。"}
            </SheetDescription>
          </SheetHeader>

          <div className="scrollbar-ui min-h-0 flex-1 overflow-y-scroll px-6 py-5">
            {isDetailLoading || !detail ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-5">
                <div className="grid gap-3 md:grid-cols-3">
                  <Card>
                    <CardContent className="p-4">
                      <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                        余额
                      </div>
                      <div className="mt-1 font-serif text-lg font-medium tracking-tight">
                        {formatCredits(detailBalance?.balance ?? 0)}
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4">
                      <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                        生成成功率
                      </div>
                      <div className="mt-1 font-serif text-lg font-medium tracking-tight">
                        {detailGenerationRate}
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4">
                      <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                        API Key
                      </div>
                      <div className="mt-1 font-serif text-lg font-medium tracking-tight">
                        {detail.apiKeys.filter((item) => item.isActive).length}/
                        {detail.apiKeys.length}
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {canManageRoles && selectedUser ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-3">
                    <span className="mr-1 text-sm text-muted-foreground">
                      超管操作
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openGrantDialog(selectedUser)}
                    >
                      加积分
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openCreditAdjustDialog(selectedUser)}
                    >
                      减积分
                    </Button>
                  </div>
                ) : null}

                <Tabs defaultValue="overview" className="space-y-4">
                  <TabsList className="border bg-muted/40">
                    <TabsTrigger value="overview">概览</TabsTrigger>
                    <TabsTrigger value="credits">积分</TabsTrigger>
                    <TabsTrigger value="generations">生图</TabsTrigger>
                    <TabsTrigger value="api">API Key</TabsTrigger>
                    <TabsTrigger value="audit">审计</TabsTrigger>
                  </TabsList>

                  <TabsContent value="overview" className="space-y-4">
                    <div className="grid gap-4">
                      <InfoBlock
                        title="账户"
                        rows={[
                          ["用户 ID", detail.user.id],
                          ["邮箱", detail.user.email],
                          [
                            "邮箱验证",
                            detail.user.emailVerified ? "已验证" : "未验证",
                          ],
                          ["角色", getUserRoleLabel(detail.user.role)],
                          [
                            "注册时间",
                            formatDateTime(detail.user.createdAt, timeZone),
                          ],
                          [
                            "更新时间",
                            formatDateTime(detail.user.updatedAt, timeZone),
                          ],
                        ]}
                      />
                    </div>
                    <ModerationPolicyControl
                      key={detail.user.id}
                      userId={detail.user.id}
                      policy={detail.moderationPolicy}
                      canManage={canManageModerationPolicy}
                      readOnlyReason={moderationPolicyReadOnlyReason}
                      onUpdated={() => loadDetail(detail.user.id, false)}
                    />
                    <UserConcurrencyControl
                      key={`${detail.user.id}:${detail.mediaLimits.override ?? "inherit"}`}
                      userId={detail.user.id}
                      limits={detail.mediaLimits}
                      canManage={canManageModerationPolicy}
                      readOnlyReason={concurrencyReadOnlyReason}
                      onUpdated={() => loadDetail(detail.user.id, false)}
                    />
                  </TabsContent>

                  <TabsContent value="credits" className="space-y-4">
                    <InfoBlock
                      title="积分账户"
                      rows={[
                        ["状态", detailBalance?.status ?? "未创建"],
                        ["余额", formatCredits(detailBalance?.balance ?? 0)],
                        [
                          "累计获得",
                          formatCredits(detailBalance?.totalEarned ?? 0),
                        ],
                        [
                          "累计消费",
                          formatCredits(detailBalance?.totalSpent ?? 0),
                        ],
                      ]}
                    />
                    <Panel title="有效积分批次">
                      {detail.activeBatches.length === 0 ? (
                        <EmptyText>暂无有效批次</EmptyText>
                      ) : (
                        <div className="space-y-2">
                          {detail.activeBatches.map((batch) => (
                            <div
                              key={batch.id}
                              className="rounded-md border p-3 text-sm"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <span className="font-medium">
                                  {formatCredits(batch.remaining)} /{" "}
                                  {formatCredits(batch.amount)}
                                </span>
                                <Badge variant="secondary">
                                  {batch.sourceType}
                                </Badge>
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                发放 {formatDateTime(batch.issuedAt, timeZone)}{" "}
                                · 过期{" "}
                                {formatDateTime(batch.expiresAt, timeZone)}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </Panel>
                    <Panel title="最近积分流水">
                      {detail.transactions.length === 0 ? (
                        <EmptyText>暂无流水</EmptyText>
                      ) : (
                        <div className="space-y-2">
                          {detail.transactions.map((tx) => (
                            <div
                              key={tx.id}
                              className="flex items-start justify-between gap-3 rounded-md border p-3 text-sm"
                            >
                              <div>
                                <div className="font-medium">{tx.type}</div>
                                <div className="text-xs text-muted-foreground">
                                  {tx.description || "-"} ·{" "}
                                  {formatDateTime(tx.createdAt, timeZone)}
                                </div>
                              </div>
                              <span className="font-medium">
                                {formatCredits(tx.amount)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </Panel>
                  </TabsContent>

                  <TabsContent value="generations" className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-4">
                      <Metric
                        label="总生成"
                        value={detail.generationSummary.total}
                      />
                      <Metric
                        label="成功"
                        value={detail.generationSummary.completed}
                      />
                      <Metric
                        label="失败"
                        value={detail.generationSummary.failed}
                      />
                      <Metric
                        label="消耗积分"
                        value={formatCredits(
                          detail.generationSummary.creditsConsumed
                        )}
                      />
                    </div>
                    <Panel title="最近生图记录">
                      {detail.generations.length === 0 ? (
                        <EmptyText>暂无生图记录</EmptyText>
                      ) : (
                        <div className="scrollbar-ui max-h-[55vh] space-y-3 overflow-y-scroll pr-2">
                          {detail.generations.map((item) => (
                            <div
                              key={item.id}
                              className="grid gap-3 rounded-md border bg-background p-3 text-sm md:grid-cols-[84px_minmax(0,1fr)]"
                            >
                              <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-md bg-muted">
                                {item.imageUrl ? (
                                  <Image
                                    // 走 /w/ 路径段缩略图 + unoptimized 直连。
                                    // 不能用 Next 图片优化器:它对带 ?sig= 的本地图会
                                    // 返回 400("url parameter is not allowed",需配
                                    // images.localPatterns);且优化器会拉 5~7MB 原图来
                                    // 生成 80px 缩略图。改直连 /w160/ 小 webp。
                                    src={
                                      buildStorageThumbnailUrl(
                                        item.imageUrl,
                                        160
                                      ) ?? item.imageUrl
                                    }
                                    alt={item.prompt}
                                    width={80}
                                    height={80}
                                    sizes="80px"
                                    className="h-full w-full object-cover"
                                    unoptimized
                                  />
                                ) : item.status === "failed" ? (
                                  <XCircle className="h-5 w-5 text-destructive" />
                                ) : (
                                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                                )}
                              </div>
                              <div className="min-w-0 space-y-1">
                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                  {generationStatusBadge(item.status)}
                                  <Badge
                                    variant="secondary"
                                    className="max-w-[180px] truncate font-mono font-normal"
                                    title={item.model}
                                  >
                                    {item.model}
                                  </Badge>
                                  <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-muted-foreground">
                                    {item.size}
                                  </span>
                                  <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                                    {formatCredits(item.creditsConsumed)}
                                  </span>
                                </div>
                                <p
                                  className="line-clamp-2 break-words leading-snug"
                                  title={item.prompt}
                                >
                                  {item.prompt}
                                </p>
                                {item.error ? (
                                  <p
                                    className="line-clamp-2 break-words text-xs leading-snug text-destructive"
                                    title={item.error}
                                  >
                                    {item.error}
                                  </p>
                                ) : null}
                                <p className="text-xs text-muted-foreground">
                                  {formatDateTime(item.createdAt, timeZone)}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </Panel>
                  </TabsContent>

                  <TabsContent value="api" className="space-y-4">
                    <Panel title="外接 API Key">
                      {detail.apiKeys.length === 0 ? (
                        <EmptyText>暂无 API Key</EmptyText>
                      ) : (
                        <div className="space-y-2">
                          {detail.apiKeys.map((key) => (
                            <div
                              key={key.id}
                              className="flex flex-col gap-3 rounded-md border p-3 text-sm md:flex-row md:items-center md:justify-between"
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                                  <span className="font-medium">
                                    {key.name}
                                  </span>
                                  <Badge
                                    variant="secondary"
                                    className={
                                      key.isActive
                                        ? "bg-success/10 text-success"
                                        : ""
                                    }
                                  >
                                    {key.isActive ? "启用" : "禁用"}
                                  </Badge>
                                </div>
                                <div className="mt-1 text-xs text-muted-foreground">
                                  {key.keyPrefix}...{key.lastFour} · 最近使用{" "}
                                  {formatDateTime(key.lastUsedAt, timeZone)} ·
                                  创建 {formatDateTime(key.createdAt, timeZone)}
                                </div>
                                <div className="mt-1 text-xs text-muted-foreground">
                                  已用 {formatCredits(key.creditsUsed)} ·{" "}
                                  {key.creditLimit === null
                                    ? "不限额"
                                    : `剩余 ${formatCredits(
                                        Math.max(
                                          0,
                                          key.creditLimit - key.creditsUsed
                                        )
                                      )} / ${formatCredits(key.creditLimit)}`}
                                </div>
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  openKeyDialog(key, !key.isActive)
                                }
                              >
                                {key.isActive ? "禁用" : "启用"}
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </Panel>
                  </TabsContent>

                  <TabsContent value="audit" className="space-y-4">
                    <Panel title="最近管理员操作">
                      {detail.auditLogs.length === 0 ? (
                        <EmptyText>暂无审计记录</EmptyText>
                      ) : (
                        <div className="space-y-2">
                          {detail.auditLogs.map((log) =>
                            log.action === MODERATION_POLICY_AUDIT_ACTION ? (
                              <ModerationPolicyAuditEntry
                                key={log.id}
                                log={log}
                                timeZone={timeZone}
                              />
                            ) : (
                              <div
                                key={log.id}
                                className="rounded-md border p-3 text-sm"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <span className="font-medium">
                                    {log.action}
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    {formatDateTime(log.createdAt, timeZone)}
                                  </span>
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {log.reason || "未填写原因"} · 管理员{" "}
                                  {log.adminUserId || "-"}
                                </p>
                              </div>
                            )
                          )}
                        </div>
                      )}
                    </Panel>
                  </TabsContent>
                </Tabs>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={grantOpen} onOpenChange={setGrantOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>手动充值积分</DialogTitle>
            <DialogDescription>
              为 {selectedUser?.email ?? "用户"} 增加奖励积分，会写入审计日志。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label
                htmlFor="grantAmount"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                积分数量
              </Label>
              <Input
                id="grantAmount"
                type="number"
                min={0.01}
                max={100000}
                step={0.01}
                value={grantAmount}
                onChange={(event) => setGrantAmount(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="grantReason"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                充值原因
              </Label>
              <Textarea
                id="grantReason"
                value={grantReason}
                onChange={(event) => setGrantReason(event.target.value)}
                placeholder="例如：客服补偿、活动奖励、退款补偿"
                maxLength={300}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGrantOpen(false)}>
              取消
            </Button>
            <Button onClick={handleGrant} disabled={isGranting}>
              {isGranting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              确认充值
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={creditAdjustOpen} onOpenChange={setCreditAdjustOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>扣减积分</DialogTitle>
            <DialogDescription>
              目标用户：{selectedUser?.email ?? "-"}。
              将按有效积分批次(最快到期优先)扣减，并写入消费流水。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              当前余额：{formatCredits(selectedUser?.creditsBalance ?? 0)}。
              如需额外赠送积分，请使用加积分。
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="creditAdjustAmount"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                扣减数量
              </Label>
              <Input
                id="creditAdjustAmount"
                type="number"
                min={0.01}
                max={1000000}
                step={0.01}
                value={creditAdjustAmount}
                onChange={(event) => setCreditAdjustAmount(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="creditAdjustReason"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                操作原因
              </Label>
              <Textarea
                id="creditAdjustReason"
                value={creditAdjustReason}
                onChange={(event) => setCreditAdjustReason(event.target.value)}
                placeholder="例如：风控扣减、人工校准余额、误充值修正"
                maxLength={300}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreditAdjustOpen(false)}
            >
              取消
            </Button>
            <Button onClick={handleCreditAdjust} disabled={isAdjustingCredits}>
              {isAdjustingCredits ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={banOpen} onOpenChange={setBanOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {selectedUser?.banned ? "解除封禁" : "封禁用户"}
            </DialogTitle>
            <DialogDescription>
              目标用户：{selectedUser?.email ?? "-"}。操作会写入审计日志。
            </DialogDescription>
          </DialogHeader>
          {!selectedUser?.banned ? (
            <div className="space-y-2">
              <Label
                htmlFor="banReason"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                封禁原因
              </Label>
              <Textarea
                id="banReason"
                value={banReason}
                onChange={(event) => setBanReason(event.target.value)}
                placeholder="请输入封禁原因"
                maxLength={300}
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBanOpen(false)}>
              取消
            </Button>
            <Button onClick={handleBan} disabled={isBanning}>
              {isBanning ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {selectedUser?.banned ? "解除封禁" : "确认封禁"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={creditsDialogOpen} onOpenChange={setCreditsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {targetCreditsStatus === "frozen"
                ? "冻结积分账户"
                : "解冻积分账户"}
            </DialogTitle>
            <DialogDescription>
              目标用户：{selectedUser?.email ?? "-"}
              。冻结后用户不能继续消费或获得积分。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label
              htmlFor="creditsReason"
              className="text-[11px] uppercase tracking-widest text-muted-foreground"
            >
              操作原因
            </Label>
            <Textarea
              id="creditsReason"
              value={creditsReason}
              onChange={(event) => setCreditsReason(event.target.value)}
              placeholder="请填写冻结或解冻原因"
              maxLength={300}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreditsDialogOpen(false)}
            >
              取消
            </Button>
            <Button
              onClick={handleCreditsStatus}
              disabled={isSettingCreditsStatus}
            >
              {isSettingCreditsStatus ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={keyDialogOpen} onOpenChange={setKeyDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {targetKeyStatus ? "启用 API Key" : "禁用 API Key"}
            </DialogTitle>
            <DialogDescription>
              目标 Key：{selectedKey?.name ?? "-"}。不会展示或记录完整密钥。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label
              htmlFor="keyReason"
              className="text-[11px] uppercase tracking-widest text-muted-foreground"
            >
              操作原因
            </Label>
            <Textarea
              id="keyReason"
              value={keyReason}
              onChange={(event) => setKeyReason(event.target.value)}
              placeholder="请填写启用或禁用原因"
              maxLength={300}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKeyDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleKeyStatus} disabled={isSettingKeyStatus}>
              {isSettingKeyStatus ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={roleDialogOpen} onOpenChange={setRoleDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修改用户角色</DialogTitle>
            <DialogDescription>
              目标用户：{selectedUser?.email ?? "-"}。角色变更会写入审计日志。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              目标角色
            </Label>
            <Select
              value={targetRole}
              onValueChange={(value) => setTargetRole(value as AppUserRole)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label
              htmlFor="roleReason"
              className="text-[11px] uppercase tracking-widest text-muted-foreground"
            >
              操作原因
            </Label>
            <Textarea
              id="roleReason"
              value={roleReason}
              onChange={(event) => setRoleReason(event.target.value)}
              placeholder="请填写角色变更原因"
              maxLength={300}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleRoleChange} disabled={isSettingRole}>
              {isSettingRole ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新增用户</DialogTitle>
            <DialogDescription>
              手动创建账号并设置初始密码，会写入审计日志。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label
                htmlFor="createName"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                用户名
              </Label>
              <Input
                id="createName"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                maxLength={60}
              />
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="createEmail"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                绑定邮箱
              </Label>
              <Input
                id="createEmail"
                type="email"
                value={createEmail}
                onChange={(event) => setCreateEmail(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="createPassword"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                初始密码
              </Label>
              <Input
                id="createPassword"
                type="password"
                value={createPassword}
                onChange={(event) => setCreatePassword(event.target.value)}
                placeholder="至少 8 位"
              />
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="createRole"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                角色
              </Label>
              <Select
                value={createRole}
                onValueChange={(value) => setCreateRole(value as AppUserRole)}
              >
                <SelectTrigger id="createRole">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="createReason"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                操作原因
              </Label>
              <Textarea
                id="createReason"
                value={createReason}
                onChange={(event) => setCreateReason(event.target.value)}
                placeholder="例如：为客户代开账号"
                maxLength={300}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button onClick={handleCreateUser} disabled={isCreating}>
              {isCreating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              确认创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑用户资料</DialogTitle>
            <DialogDescription>
              修改 {selectedUser?.email ?? "用户"}{" "}
              的用户名或绑定邮箱，会写入审计日志。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label
                htmlFor="profileName"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                用户名
              </Label>
              <Input
                id="profileName"
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                maxLength={60}
              />
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="profileEmail"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                绑定邮箱
              </Label>
              <Input
                id="profileEmail"
                type="email"
                value={profileEmail}
                onChange={(event) => setProfileEmail(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="profileReason"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                操作原因
              </Label>
              <Textarea
                id="profileReason"
                value={profileReason}
                onChange={(event) => setProfileReason(event.target.value)}
                placeholder="请填写资料修改原因"
                maxLength={300}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProfileOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSaveProfile} disabled={isSavingProfile}>
              {isSavingProfile ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重设密码</DialogTitle>
            <DialogDescription>
              为 {selectedUser?.email ?? "用户"}{" "}
              设置新登录密码，会写入审计日志。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label
                htmlFor="newPassword"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                新密码
              </Label>
              <Input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="至少 8 位"
              />
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="passwordReason"
                className="text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                操作原因
              </Label>
              <Textarea
                id="passwordReason"
                value={passwordReason}
                onChange={(event) => setPasswordReason(event.target.value)}
                placeholder="请填写密码重设原因"
                maxLength={300}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasswordOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSetPassword} disabled={isSettingPassword}>
              {isSettingPassword ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              确认重设
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <h3 className="mb-3 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  );
}

function InfoBlock({
  title,
  rows,
}: {
  title: string;
  rows: Array<[string, string]>;
}) {
  return (
    <Panel title={title}>
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[92px_1fr] gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-serif text-lg font-medium tracking-tight">
        {value}
      </div>
    </div>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
