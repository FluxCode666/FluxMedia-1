import { isSuperAdminRole, normalizeUserRole } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { NextResponse } from "next/server";
import {
  canUpdateTo,
  dispatchProductionDeployment,
  getCurrentReleaseVersion,
  getLatestGitHubRelease,
} from "@/features/system-updates/github-release";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession();
  if (!session?.user || session.user.banned) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isSuperAdminRole(normalizeUserRole(session.user.role))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const release = await getLatestGitHubRelease();
    const currentVersion = getCurrentReleaseVersion();
    return NextResponse.json(
      {
        currentVersion,
        currentVersionKnown: currentVersion !== "unknown",
        latestRelease: release,
        updateAvailable: canUpdateTo(currentVersion, release.version),
        canDeploy: Boolean(process.env.FLUXMEDIA_GITHUB_ACTIONS_TOKEN?.trim()),
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  } catch {
    return NextResponse.json(
      { error: "release_unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }
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

  try {
    const release = await getLatestGitHubRelease();
    const currentVersion = getCurrentReleaseVersion();
    if (
      requestedVersion !== release.version ||
      !canUpdateTo(currentVersion, release.version)
    ) {
      return NextResponse.json(
        { error: "release_not_deployable" },
        { status: 409 }
      );
    }
    const deployment = await dispatchProductionDeployment(release.version);
    return NextResponse.json({
      dispatched: true,
      version: release.version,
      ...deployment,
    });
  } catch (error) {
    const message =
      error instanceof Error &&
      error.message.includes("token is not configured")
        ? "dispatch_not_configured"
        : "dispatch_failed";
    const status = message === "dispatch_not_configured" ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
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
