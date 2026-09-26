"use client";

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

type UpdatesInfo = {
  currentVersion: string;
  currentVersionKnown: boolean;
  latestRelease: {
    version: string;
    name: string;
    notes: string;
    url: string;
    publishedAt: string | null;
  };
  updateAvailable: boolean;
  canDeploy: boolean;
};

export function SystemUpdatesPanel() {
  const t = useTranslations("SystemUpdates");
  const [info, setInfo] = useState<UpdatesInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<"load" | "dispatch" | null>(null);
  const [dispatched, setDispatched] = useState<{
    version: string;
    workflowUrl: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/system-updates", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Unable to load releases");
      setInfo((await response.json()) as UpdatesInfo);
    } catch {
      setError("load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function startUpdate() {
    if (
      !info ||
      !window.confirm(t("confirm", { version: info.latestRelease.version }))
    ) {
      return;
    }

    setUpdating(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/system-updates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: info.latestRelease.version }),
      });
      if (!response.ok) throw new Error("Unable to dispatch deployment");
      const result = (await response.json()) as {
        version: string;
        workflowUrl: string;
      };
      setDispatched(result);
    } catch {
      setError("dispatch");
    } finally {
      setUpdating(false);
    }
  }

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
              onClick={() => void refresh()}
              disabled={loading || updating}
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
              {t("checkAgain")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {loading && (
            <p className="text-sm text-muted-foreground">{t("loading")}</p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error === "load" ? t("loadError") : t("dispatchError")}
            </p>
          )}
          {info && !loading && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <VersionCard
                  label={t("currentVersion")}
                  value={info.currentVersion}
                />
                <VersionCard
                  label={t("latestVersion")}
                  value={info.latestRelease.version}
                  badge={
                    info.updateAvailable ? (
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

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  onClick={() => void startUpdate()}
                  disabled={
                    !info.updateAvailable ||
                    !info.currentVersionKnown ||
                    !info.canDeploy ||
                    updating ||
                    Boolean(dispatched)
                  }
                >
                  <Download className={updating ? "animate-bounce" : ""} />
                  {updating ? t("startingUpdate") : t("updateNow")}
                </Button>
                <a
                  className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
                  href={info.latestRelease.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("viewRelease")}
                  <ArrowUpRight className="size-4" />
                </a>
              </div>

              {!info.canDeploy && info.updateAvailable && (
                <p className="text-sm text-muted-foreground">
                  {t("dispatchNotConfigured")}
                </p>
              )}
              {dispatched && (
                <p
                  role="status"
                  className="text-sm text-green-600 dark:text-green-400"
                >
                  {t("dispatchAccepted", { version: dispatched.version })}{" "}
                  <a
                    className="underline underline-offset-4"
                    href={dispatched.workflowUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("viewWorkflow")}
                  </a>
                </p>
              )}
              {info.latestRelease.publishedAt && (
                <p className="text-xs text-muted-foreground">
                  {t("publishedAt", {
                    date: new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                    }).format(new Date(info.latestRelease.publishedAt)),
                  })}
                </p>
              )}
              <section className="space-y-2 border-t pt-5">
                <h2 className="font-medium">{info.latestRelease.name}</h2>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-4 font-sans text-sm leading-relaxed">
                  {info.latestRelease.notes || t("noReleaseNotes")}
                </pre>
              </section>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
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
