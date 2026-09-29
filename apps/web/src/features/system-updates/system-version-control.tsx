/**
 * 侧栏版本号与站内系统更新弹窗（仅超级管理员）。
 *
 * 使用方：DashboardSidebar。Provider 持有唯一的状态与弹窗，桌面侧栏和移动端抽屉里的
 * 版本号按钮都只负责打开弹窗，避免两处各自轮询。更新期间 Go 进程会退出、容器重启并
 * 在维护页中迁移数据库，因此轮询容忍连接失败与 503，直到当前版本变为目标版本后刷新页面。
 */
import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Progress } from "@repo/ui/components/progress";
import { cn } from "@repo/ui/utils";
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  Circle,
  Download,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocale, useTranslations } from "use-intl";
import { GoBackendRequestError, requestGoJson } from "@/lib/go-backend-request";
import {
  downloadPercent,
  knownCode,
  readSystemUpdateProbe,
  SYSTEM_UPDATE_BLOCKED_REASONS,
  SYSTEM_UPDATE_ERROR_CODES,
  SYSTEM_UPDATE_RELEASE_ERRORS,
  SYSTEM_UPDATE_STEPS,
  type SystemUpdateJob,
  type SystemUpdateProbe,
  type SystemUpdateStatus,
  type SystemUpdateStep,
  type TrackedOutcome,
  type TrackedUpdate,
  trackedOutcome,
} from "./system-update-model";

const ENDPOINT = "/api/admin/system-update";
const POLL_INTERVAL_MS = 3000;
const RELOAD_DELAY_MS = 2000;

type VersionContextValue = {
  enabled: boolean;
  version: string | null;
  updateAvailable: boolean;
  updating: boolean;
  open: () => void;
};

const VersionContext = createContext<VersionContextValue>({
  enabled: false,
  version: null,
  updateAvailable: false,
  updating: false,
  open: () => {},
});

/** 读取一次更新状态；网络失败交给 readSystemUpdateProbe 视为服务重启中。 */
async function probeSystemUpdate(refresh = false): Promise<SystemUpdateProbe> {
  const response = await fetch(`${ENDPOINT}${refresh ? "?refresh=1" : ""}`, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
  }).catch(() => null);
  return readSystemUpdateProbe(response);
}

function trackJob(job: SystemUpdateJob): TrackedUpdate | null {
  if (
    (job.state === "running" || job.state === "restarting") &&
    job.targetVersion
  ) {
    return { version: job.targetVersion, startedAt: job.startedAt ?? null };
  }
  return null;
}

/** 侧栏里的版本号按钮；有新版本时显示提示点，更新中显示旋转图标。 */
export function SystemVersionButton({ className }: { className?: string }) {
  const t = useTranslations("SystemUpdates");
  const { enabled, version, updateAvailable, updating, open } =
    useContext(VersionContext);
  if (!enabled || !version) return null;
  return (
    <button
      type="button"
      onClick={open}
      aria-label={t("versionButton", { version })}
      title={updateAvailable ? t("newVersion") : undefined}
      className={cn(
        "relative inline-flex items-center gap-1 rounded-md border border-sidebar-border/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
        className
      )}
    >
      {updating ? (
        <Loader2 aria-hidden="true" className="size-3 animate-spin" />
      ) : null}
      {version}
      {updateAvailable && !updating ? (
        <span
          aria-hidden="true"
          className="absolute -right-1 -top-1 size-2 rounded-full bg-destructive ring-2 ring-sidebar"
        />
      ) : null}
    </button>
  );
}

/**
 * 提供版本号状态与更新弹窗。
 *
 * @param enabled 仅超级管理员为 true；否则不发请求、不渲染弹窗。
 */
export function SystemVersionProvider({
  enabled,
  children,
}: PropsWithChildren<{ enabled: boolean }>) {
  const t = useTranslations("SystemUpdates");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SystemUpdateStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [tracked, setTracked] = useState<TrackedUpdate | null>(null);
  const [outcome, setOutcome] = useState<TrackedOutcome | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setLoadError(false);
    const probe = await probeSystemUpdate(refresh);
    if (!mounted.current) return;
    setLoading(false);
    if (probe.kind !== "status") {
      setLoadError(true);
      return;
    }
    setStatus(probe.status);
    const job = trackJob(probe.status.job);
    if (job) {
      setTracked((current) => current ?? job);
      setOutcome((current) => current ?? trackedOutcome(job, probe));
    }
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  // 更新期间持续轮询（弹窗关闭也继续），拿到最终结果后停止；成功则刷新页面加载新版本。
  useEffect(() => {
    if (!tracked) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const probe = await probeSystemUpdate();
      if (cancelled) return;
      if (probe.kind === "status") setStatus(probe.status);
      const next = trackedOutcome(tracked, probe);
      setOutcome(next);
      if (next.kind === "pending") {
        timer = setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }
      setTracked(null);
      if (next.kind === "succeeded") setOpen(true);
    };
    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tracked]);

  // 刷新计时不能放在轮询 effect 里：setTracked(null) 触发的清理会把它一起取消。
  const succeeded = outcome?.kind === "succeeded";
  useEffect(() => {
    if (!succeeded) return;
    const timer = setTimeout(() => window.location.reload(), RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [succeeded]);

  const release = status?.latestRelease ?? null;

  /** 打开弹窗时刷新一次状态；更新进行中由轮询负责，不重复请求。 */
  const openDialog = () => {
    setOpen(true);
    setConfirming(false);
    setSubmitError(null);
    if (!tracked) void load();
  };

  const startUpdate = async () => {
    if (!release || submitting) return;
    setSubmitting(true);
    setConfirming(false);
    setSubmitError(null);
    setOutcome(null);
    try {
      const response = await requestGoJson<{ job: SystemUpdateJob }>(ENDPOINT, {
        method: "POST",
        body: JSON.stringify({ version: release.version }),
      });
      if (!mounted.current) return;
      const job = response?.job;
      setTracked({
        version: release.version,
        startedAt: job?.startedAt ?? null,
      });
      setOutcome({ kind: "pending", step: "downloading" });
      if (job)
        setStatus((current) => (current ? { ...current, job } : current));
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof GoBackendRequestError && error.status < 500) {
        setSubmitError(error.code ?? "update_failed");
      } else {
        // 响应可能在服务重启时中断：先读取任务状态，不能自动重复发起更新。
        setSubmitError("update_failed");
        void load();
      }
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  };

  /** 错误码、阻塞原因与 GitHub 错误共用一套展示入口，未知码统一回退。 */
  const describeCode = (code: string | null | undefined): string => {
    const error = knownCode(code, SYSTEM_UPDATE_ERROR_CODES);
    if (error !== "unknown") return t(`errors.${error}`);
    const blocked = knownCode(code, SYSTEM_UPDATE_BLOCKED_REASONS);
    if (blocked !== "unknown") return t(`blocked.${blocked}`);
    const releaseError = knownCode(code, SYSTEM_UPDATE_RELEASE_ERRORS);
    if (releaseError !== "unknown") return t(`releaseErrors.${releaseError}`);
    return t("errors.unknown");
  };

  const formatDate = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
  };

  const updating = tracked !== null || outcome?.kind === "pending";
  // 有新版本时说明它为何不能站内安装；否则说明当前运行环境本身为何不可更新（如开发构建）。
  const blockedNotice = status?.updateAvailable
    ? release?.blockedReason
    : status && !status.updater.available
      ? (status.updater.reason ?? "unknown")
      : undefined;
  const canUpdate = Boolean(
    status?.updateAvailable &&
      release?.installable &&
      !updating &&
      !submitting &&
      !loading &&
      outcome?.kind !== "succeeded"
  );
  const lastResult = status?.lastResult ?? null;
  const showLastFailure =
    lastResult?.status === "failed" &&
    !outcome &&
    lastResult.version !== status?.currentVersion;
  const warnings =
    outcome?.kind === "succeeded"
      ? outcome.warnings
      : lastResult?.status === "succeeded" &&
          lastResult.version === status?.currentVersion
        ? (lastResult.warnings ?? [])
        : [];

  return (
    <VersionContext.Provider
      value={{
        enabled,
        version: status?.currentVersion ?? null,
        updateAvailable: Boolean(status?.updateAvailable),
        updating,
        open: openDialog,
      }}
    >
      {children}
      {enabled ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-h-[85svh] w-[calc(100%-2rem)] max-w-2xl gap-5 overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t("title")}</DialogTitle>
              <DialogDescription>{t("description")}</DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-4 rounded-lg border bg-muted/30 p-4">
              <div>
                <p className="text-xs text-muted-foreground">
                  {t("currentVersion")}
                </p>
                <p className="mt-1 break-all font-mono text-lg font-semibold">
                  {status?.currentVersion ?? "—"}
                </p>
                {status && status.imageVersion !== status.currentVersion ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("imageVersion", { version: status.imageVersion })}
                  </p>
                ) : null}
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  {t("latestVersion")}
                </p>
                <p className="mt-1 break-all font-mono text-lg font-semibold">
                  {release?.version ?? (loading ? t("checking") : "—")}
                </p>
              </div>
            </div>

            {loading ? (
              <p
                role="status"
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Loader2 className="size-4 animate-spin" />
                {t("checking")}
              </p>
            ) : null}
            {loadError ? (
              <p role="alert" className="text-sm text-destructive">
                {t("loadError")}
              </p>
            ) : null}
            {status?.releaseError ? (
              <p role="alert" className="text-sm text-destructive">
                {describeCode(status.releaseError)}
              </p>
            ) : null}

            {outcome ? (
              <UpdateProgress
                outcome={outcome}
                job={status?.job ?? null}
                version={
                  tracked?.version ??
                  status?.job.targetVersion ??
                  release?.version ??
                  ""
                }
                currentVersion={status?.currentVersion ?? ""}
                describeCode={describeCode}
              />
            ) : null}

            {showLastFailure && lastResult ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {t("lastFailed", {
                  version: lastResult.version ?? "",
                  reason: describeCode(lastResult.code),
                  date: formatDate(lastResult.finishedAt),
                })}
              </p>
            ) : null}
            {warnings.includes("dashboard_backfill_failed") ? (
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {t("warnings.dashboard_backfill_failed")}
              </p>
            ) : null}

            {release ? (
              <section aria-label={t("releaseNotes")} className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">
                    {release.name || release.version}
                  </h3>
                  <a
                    href={release.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4"
                  >
                    {t("viewRelease")}
                    <ArrowUpRight className="size-3" />
                  </a>
                </div>
                {release.publishedAt ? (
                  <p className="text-xs text-muted-foreground">
                    {t("publishedAt", {
                      date: formatDate(release.publishedAt),
                    })}
                  </p>
                ) : null}
                <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border p-4 font-sans text-sm leading-7">
                  {release.notes || t("noReleaseNotes")}
                </pre>
                {status &&
                !status.updateAvailable &&
                status.updater.available &&
                !updating &&
                !outcome ? (
                  <p className="flex items-center gap-2 text-sm">
                    <CheckCircle2 className="size-4" />
                    {t("upToDate")}
                  </p>
                ) : null}
              </section>
            ) : null}
            {blockedNotice && !outcome ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-200">
                {describeCode(blockedNotice)}
              </p>
            ) : null}

            {submitError ? (
              <p role="alert" className="text-sm text-destructive">
                {describeCode(submitError)}
              </p>
            ) : null}
            {confirming && release ? (
              <p className="rounded-lg border p-4 text-sm leading-6">
                {t("confirmMessage", { version: release.version })}
              </p>
            ) : null}

            <DialogFooter className="flex-wrap gap-2">
              {outcome?.kind === "succeeded" ? (
                <Button type="button" onClick={() => window.location.reload()}>
                  {t("reloadNow")}
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading || submitting || updating}
                    onClick={() => void load(true)}
                  >
                    <RefreshCw className="size-4" />
                    {t("checkAgain")}
                  </Button>
                  {confirming ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setConfirming(false)}
                      >
                        {t("cancel")}
                      </Button>
                      <Button
                        type="button"
                        disabled={!canUpdate}
                        onClick={() => void startUpdate()}
                      >
                        {t("confirmUpdate")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      disabled={!canUpdate}
                      onClick={() => setConfirming(true)}
                    >
                      {submitting || updating ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Download className="size-4" />
                      )}
                      {submitting
                        ? t("starting")
                        : updating
                          ? t("updating")
                          : t("updateNow")}
                    </Button>
                  )}
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </VersionContext.Provider>
  );
}

/** 分步展示更新进度与最终结果。 */
function UpdateProgress({
  outcome,
  job,
  version,
  currentVersion,
  describeCode,
}: {
  outcome: TrackedOutcome;
  job: SystemUpdateJob | null;
  version: string;
  currentVersion: string;
  describeCode: (code: string | null | undefined) => string;
}) {
  const t = useTranslations("SystemUpdates");
  const activeStep: SystemUpdateStep | null =
    outcome.kind === "pending"
      ? outcome.step
      : outcome.kind === "succeeded"
        ? "done"
        : null;
  const activeIndex = activeStep ? SYSTEM_UPDATE_STEPS.indexOf(activeStep) : -1;
  const percent =
    outcome.kind === "pending" && outcome.step === "downloading" && job
      ? downloadPercent(job)
      : null;

  return (
    <section
      aria-live="polite"
      className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm"
    >
      <p
        className={cn(
          "font-medium",
          outcome.kind === "failed" && "text-destructive"
        )}
      >
        {outcome.kind === "succeeded"
          ? t("succeeded", { version })
          : outcome.kind === "failed"
            ? t("failed", { version, reason: describeCode(outcome.code) })
            : outcome.kind === "unknown"
              ? t("unknownOutcome")
              : t("progressTitle", { version })}
      </p>
      {outcome.kind !== "failed" && outcome.kind !== "unknown" ? (
        <ol className="grid gap-1.5 sm:auto-cols-fr sm:grid-flow-col sm:grid-rows-4">
          {SYSTEM_UPDATE_STEPS.map((step, index) => {
            const done =
              index < activeIndex || (step === "done" && activeStep === "done");
            const current = index === activeIndex && step !== "done";
            return (
              <li
                key={step}
                className={cn(
                  "flex items-center gap-2",
                  !done && !current && "text-muted-foreground"
                )}
              >
                {done ? (
                  <Check className="size-4 text-green-600 dark:text-green-400" />
                ) : current ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Circle className="size-4" />
                )}
                {t(`steps.${step}`)}
              </li>
            );
          })}
        </ol>
      ) : null}
      {percent !== null ? (
        <div className="space-y-1">
          <Progress value={percent} />
          <p className="text-xs text-muted-foreground">
            {t("downloadProgress", { percent })}
          </p>
        </div>
      ) : null}
      {outcome.kind === "pending" && outcome.step === "restarting" ? (
        <p className="text-muted-foreground">{t("restartingHint")}</p>
      ) : null}
      {outcome.kind === "pending" && outcome.step === "migrating" ? (
        <p className="text-muted-foreground">{t("migratingHint")}</p>
      ) : null}
      {outcome.kind === "failed" && currentVersion ? (
        <p className="text-muted-foreground">
          {t("stillOnVersion", { version: currentVersion })}
        </p>
      ) : null}
    </section>
  );
}
