import { isSuperAdminRole, normalizeUserRole } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { NextResponse } from "next/server";
import {
  canUpdateTo,
  getCurrentReleaseVersion,
  getLatestGitHubRelease,
  type LatestRelease,
} from "@/features/system-updates/github-release";
import {
  isUpdateInProgress,
  readHostUpdaterState,
  requestHostUpdate,
} from "@/features/system-updates/host-updater";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * 站内系统更新（仅超级管理员）。
 * GET：当前版本、最新稳定 Release 与宿主机更新器状态；Release 读取失败时仍返回
 *      更新器状态，保证更新过程中页面可以持续展示进度。`?refresh=1` 跳过 Release 缓存。
 * POST：校验目标版本后写入更新请求，由宿主机更新器异步执行，返回 202。
 */
export async function GET(request: Request) {
  const session = await getServerSession();
  if (!session?.user || session.user.banned) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isSuperAdminRole(normalizeUserRole(session.user.role))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const refresh = new URL(request.url).searchParams.has("refresh");
  const [releaseResult, updater] = await Promise.all([
    getLatestGitHubRelease({ refresh }).then(
      (release): LatestRelease | null => release,
      () => null
    ),
    readHostUpdaterState(),
  ]);
  const currentVersion = getCurrentReleaseVersion();
  return NextResponse.json(
    {
      currentVersion,
      currentVersionKnown: currentVersion !== "unknown",
      latestRelease: releaseResult,
      releaseError: releaseResult ? null : "release_unavailable",
      updateAvailable: releaseResult
        ? canUpdateTo(currentVersion, releaseResult.version)
        : false,
      updater: { ...updater, busy: isUpdateInProgress(updater) },
    },
    { headers: NO_STORE }
  );
}

export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session?.user || session.user.banned) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isSuperAdminRole(normalizeUserRole(session.user.role))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!hasTrustedOrigin(request)) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let requestedVersion: unknown;
  try {
    requestedVersion = (await request.json())?.version;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (typeof requestedVersion !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const updater = await readHostUpdaterState();
  if (!updater.available) {
    return NextResponse.json(
      { error: "updater_not_installed" },
      { status: 503 }
    );
  }
  if (isUpdateInProgress(updater)) {
    return NextResponse.json({ error: "update_in_progress" }, { status: 409 });
  }

  let release: LatestRelease;
  try {
    // 发起更新前强制刷新，避免基于 5 分钟前的缓存判断。
    release = await getLatestGitHubRelease({ refresh: true });
  } catch {
    return NextResponse.json({ error: "release_unavailable" }, { status: 502 });
  }
  const currentVersion = getCurrentReleaseVersion();
  if (
    requestedVersion !== release.version ||
    !release.deployable ||
    !canUpdateTo(currentVersion, release.version)
  ) {
    return NextResponse.json(
      { error: "release_not_deployable" },
      { status: 409 }
    );
  }

  try {
    const { requestId } = await requestHostUpdate({
      version: release.version,
      requestedBy: session.user.id,
    });
    return NextResponse.json(
      { queued: true, version: release.version, requestId },
      { status: 202 }
    );
  } catch {
    return NextResponse.json({ error: "request_failed" }, { status: 500 });
  }
}

function hasTrustedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const configuredOrigins = [
    process.env.BETTER_AUTH_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",") ?? []),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    })
    .filter((value): value is string => value !== null);

  const allowedOrigins = configuredOrigins.length
    ? configuredOrigins
    : [new URL(request.url).origin];

  return allowedOrigins.includes(origin);
}
