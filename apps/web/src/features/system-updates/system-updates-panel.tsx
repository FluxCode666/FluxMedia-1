"use client";

/**
 * 站内系统更新面板（仅超级管理员）。
 *
 * 读取 /api/admin/system-updates 展示版本与宿主机更新器状态；点击更新后只提交请求，
 * 实际发布由服务器上的 systemd 更新器执行。更新期间 app 容器会重启，轮询失败时显示
 * “服务重启中”并继续轮询，服务恢复后自动展示最终结果。
 */
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { ArrowUpRight, Check, Download, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useState } from "react";

const POLL_INTERVAL_MS = 3000;
const KNOWN_ERRORS = new Set([
  "invalid_request",
  "invalid_version",
  "current_version_unknown",
  "version_not_newer",
  "download_failed",
  "deploy_failed",
  "deploy_evidence_missing",
  "runner_interrupted",
]);
const KNOWN_PHASES: Record<string, string> = {
  validating: "phaseValidating",
  downloading: "phaseDownloading",
  deploying: "phaseDeploying",
};

type UpdaterStatus = {
  state: "idle" | "running" | "succeeded" | "failed";
  phase: string | null;
  error: string | null;
  targetVersion: string | null;
  requestId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  logTail: string[];
  stale: boolean;
};

type UpdatesInfo = {
  currentVersion: string;
  currentVersionKnown: boolean;
  latestRelease: {
    version: string;
    name: string;
    notes: string;
    url: string;
    publishedAt: string | null;
    deployable: boolean;
  } | null;
  releaseError: string | null;
  updateAvailable: boolean;
  updater: {
    available: boolean;
    busy: boolean;
    status: UpdaterStatus | null;
    pendingRequest: {
      version: string;
      requestId: string;
      stale: boolean;
    } | null;
  };
};

type RequestError =
  | "requestError"
  | "updateInProgress"
  | "updaterNotInstalled"
  | "releaseNotDeployable";

export function SystemUpdatesPanel() {
  const t = useTranslations("SystemUpdates");
  const [info, setInfo] = useState<UpdatesInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<RequestError | null>(null);
  // 本页发起的请求：用于在服务重启期间持续轮询，直到该请求有最终结果。
  const [trackedRequestId, setTrackedRequestId] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(
    async (options: { refresh?: boolean; background?: boolean } = {}) => {
      if (!options.background) {
        setLoading(true);
        setLoadError(false);
      }
      try {
        const response = await fetch(
          `/api/admin/system-updates${options.refresh ? "?refresh=1" : ""}`,
          { cache: "no-store" }
        );
        if (!response.ok) throw new Error("Unable to load updates");
        setInfo((await response.json()) as UpdatesInfo);
        setRestarting(false);
      } catch {
        if (options.background) {
          setRestarting(true);
        } else {
          setLoadError(true);
        }
      } finally {
        if (!options.background) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void load();
  }, [load]);

  const status = info?.updater.status ?? null;
  const trackedFinished =
    trackedRequestId !== null &&
    status?.requestId === trackedRequestId &&
    (status.state === "succeeded" || status.state === "failed");
  const shouldPoll =
    Boolean(info?.updater.busy) ||
    (trackedRequestId !== null && !trackedFinished);

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => {
      void load({ background: true });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [shouldPoll, load]);

  async function startUpdate() {
    const version = info?.latestRelease?.version;
    if (!version || !window.confirm(t("confirm", { version }))) return;

    setSubmitting(true);
    setRequestError(null);
    try {
      const response = await fetch("/api/admin/system-updates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        requestId?: string;
        error?: string;
      };
      if (response.status === 202 && body.requestId) {
        setTrackedRequestId(body.requestId);
        await load({ background: true });
        return;
      }
      setRequestError(
        body.error === "update_in_progress"
          ? "updateInProgress"
          : body.error === "updater_not_installed"
            ? "updaterNotInstalled"
            : body.error === "release_not_deployable"
              ? "releaseNotDeployable"
              : "requestError"
      );
    } catch {
      setRequestError("requestError");
    } finally {
      setSubmitting(false);
    }
  }

  const release = info?.latestRelease ?? null;
  const canStartUpdate = Boolean(
    info &&
      release &&
      info.updateAvailable &&
      info.currentVersionKnown &&
      release.deployable &&
      info.updater.available &&
      !info.updater.busy &&
      !submitting &&
      !(trackedRequestId && !trackedFinished)
  );

  return (
    <main className="container mx-auto space-y-6 px-4 py-6 md:px-6">
      <header className="space-y-2">
        <h1 className="font-serif text-2xl font-medium tracking-tight">
          {t("title")}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("description")}
        </p>
      </header>

      <Card className="rounded-lg">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <CardTitle>{t("statusTitle")}</CardTitle>
              <CardDescription>{t("statusDescription")}</CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void load({ refresh: true })}
              disabled={loading || submitting}
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
              {t("checkAgain")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {loading && !info && (
            <p className="text-sm text-muted-foreground">{t("loading")}</p>
          )}
          {loadError && (
            <p role="alert" className="text-sm text-destructive">
              {t("loadError")}
            </p>
          )}
          {info && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <VersionCard
                  label={t("currentVersion")}
                  value={info.currentVersion}
                />
                <VersionCard
                  label={t("latestVersion")}
                  value={release?.version ?? "-"}
                  badge={
                    !release ? null : info.updateAvailable ? (
                      <Badge>{t("updateAvailable")}</Badge>
                    ) : info.currentVersionKnown ? (
                      <Badge variant="secondary">
                        <Check />
                        {t("upToDate")}
                      </Badge>
                    ) : (
                      <Badge variant="outline">{t("unknownVersion")}</Badge>
                    )
                  }
                />
              </div>

              {info.releaseError && (
                <p role="alert" className="text-sm text-destructive">
                  {t("releaseUnavailable")}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  onClick={() => void startUpdate()}
                  disabled={!canStartUpdate}
                >
                  <Download className={submitting ? "animate-bounce" : ""} />
                  {submitting ? t("startingUpdate") : t("updateNow")}
                </Button>
                {release && (
                  <a
                    className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
                    href={release.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("viewRelease")}
                    <ArrowUpRight className="size-4" />
                  </a>
                )}
              </div>

              {!info.updater.available && (
                <p className="text-sm text-muted-foreground">
                  {t("updaterNotInstalled")}
                </p>
              )}
              {release && info.updateAvailable && !release.deployable && (
                <p className="text-sm text-muted-foreground">
                  {t("releaseNotDeployable")}
                </p>
              )}
              {requestError && (
                <p role="alert" className="text-sm text-destructive">
                  {t(requestError)}
                </p>
              )}

              <UpdateProgress info={info} restarting={restarting} t={t} />

              {release?.publishedAt && (
                <p className="text-xs text-muted-foreground">
                  {t("publishedAt", {
                    date: formatDate(release.publishedAt),
                  })}
                </p>
              )}
              {release && (
                <section className="space-y-2 border-t pt-5">
                  <h2 className="font-medium">{release.name}</h2>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-4 font-sans text-sm leading-relaxed">
                    {release.notes || t("noReleaseNotes")}
                  </pre>
                </section>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function UpdateProgress({
  info,
  restarting,
  t,
}: {
  info: UpdatesInfo;
  restarting: boolean;
  t: ReturnType<typeof useTranslations<"SystemUpdates">>;
}) {
  const { pendingRequest, status } = info.updater;
  if (!pendingRequest && (!status || status.state === "idle") && !restarting) {
    return null;
  }

  const targetVersion =
    pendingRequest?.version ?? status?.targetVersion ?? null;
  let stateLabel: string;
  let badgeVariant: "default" | "secondary" | "destructive" | "outline" =
    "outline";
  if (pendingRequest) {
    stateLabel = t("stateQueued");
  } else if (status?.state === "running") {
    stateLabel = t("stateRunning");
  } else if (status?.state === "succeeded") {
    stateLabel = t("stateSucceeded");
    badgeVariant = "secondary";
  } else if (status?.state === "failed") {
    stateLabel = t("stateFailed");
    badgeVariant = "destructive";
  } else {
    stateLabel = t("stateRunning");
  }
  const phaseKey =
    !pendingRequest && status?.state === "running" && status.phase
      ? KNOWN_PHASES[status.phase]
      : undefined;

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{t("progressTitle")}</h2>
        <Badge variant={badgeVariant}>
          {stateLabel}
          {phaseKey ? ` · ${t(phaseKey)}` : ""}
        </Badge>
      </div>
      {targetVersion && (
        <p className="text-sm text-muted-foreground">
          {t("targetVersion", { version: targetVersion })}
        </p>
      )}
      {restarting && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("restarting")}
        </p>
      )}
      {pendingRequest?.stale && (
        <p className="text-sm text-destructive">{t("pendingStale")}</p>
      )}
      {!pendingRequest && status?.state === "running" && status.stale && (
        <p className="text-sm text-destructive">{t("runningStale")}</p>
      )}
      {!pendingRequest && status?.state === "succeeded" && (
        <p role="status" className="text-sm text-green-600 dark:text-green-400">
          {t("succeededMessage", { version: status.targetVersion ?? "" })}{" "}
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => window.location.reload()}
          >
            {t("reloadPage")}
          </button>
        </p>
      )}
      {!pendingRequest && status?.state === "failed" && (
        <p role="alert" className="text-sm text-destructive">
          {t("failedMessage", {
            version: status.targetVersion ?? "-",
            reason: t(
              `errors.${status.error && KNOWN_ERRORS.has(status.error) ? status.error : "unknown"}`
            ),
          })}
        </p>
      )}
      {!pendingRequest && status && (status.startedAt || status.finishedAt) && (
        <p className="text-xs text-muted-foreground">
          {status.startedAt &&
            t("startedAt", { date: formatDate(status.startedAt, true) })}
          {status.startedAt && status.finishedAt ? " / " : ""}
          {status.finishedAt &&
            t("finishedAt", { date: formatDate(status.finishedAt, true) })}
        </p>
      )}
      {!pendingRequest && status && status.logTail.length > 0 && (
        <details open={status.state !== "succeeded"}>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {t("logTitle")}
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed">
            {status.logTail.join("\n")}
          </pre>
        </details>
      )}
    </section>
  );
}

function formatDate(value: string, withTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "medium" } : {}),
  }).format(date);
}

function VersionCard({
  label,
  value,
  badge,
}: {
  label: string;
  value: string;
  badge?: ReactNode;
}) {
  return (
    <div className="flex min-h-24 items-center justify-between gap-3 rounded-lg border bg-muted/20 p-4">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className="font-mono text-lg font-semibold">{value}</p>
      </div>
      {badge}
    </div>
  );
}
