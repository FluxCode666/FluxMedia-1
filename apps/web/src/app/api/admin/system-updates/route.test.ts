import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getServerSession: vi.fn() }));
vi.mock("@repo/shared/auth/server", () => ({
  getServerSession: mocks.getServerSession,
}));

import { clearLatestReleaseCache } from "@/features/system-updates/github-release";
import { GET, POST } from "./route";

const endpoint = "https://app.example.com/api/admin/system-updates";
const release = {
  tag_name: "v0.9.0",
  name: "FluxMedia 0.9.0",
  body: "Release notes",
  html_url: "https://github.com/FluxCode666/FluxMedia-1/releases/v0.9.0",
  published_at: "2026-09-24T12:00:00Z",
  draft: false,
  prerelease: false,
  assets: [
    { name: "fluxmedia-release.env" },
    { name: "fluxmedia-deploy.tar.gz" },
  ],
};

let updateDirectory: string;

beforeEach(async () => {
  updateDirectory = await mkdtemp(path.join(tmpdir(), "system-update-"));
  await mkdir(path.join(updateDirectory, "requests"));
  await mkdir(path.join(updateDirectory, "status"));
  clearLatestReleaseCache();
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("FLUXMEDIA_RELEASE_TAG", "v0.8.0");
  vi.stubEnv("FLUXMEDIA_SYSTEM_UPDATE_DIR", updateDirectory);
  mocks.getServerSession.mockResolvedValue({
    user: { id: "root-1", role: "super_admin" },
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(updateDirectory, { recursive: true, force: true });
});

function fetchMock() {
  return vi.mocked(fetch);
}

function postUpdate(version: string) {
  return POST(
    new Request(endpoint, {
      method: "POST",
      headers: {
        origin: "https://app.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ version }),
    })
  );
}

function writeStatus(status: Record<string, unknown>) {
  return writeFile(
    path.join(updateDirectory, "status", "status.json"),
    JSON.stringify({ schemaVersion: 1, ...status })
  );
}

const requestPath = () =>
  path.join(updateDirectory, "requests", "update-request.json");

describe("GET /api/admin/system-updates", () => {
  it("requires an authenticated super administrator", async () => {
    mocks.getServerSession.mockResolvedValueOnce(null);
    const unauthorized = await GET(new Request(endpoint));
    expect(unauthorized.status).toBe(401);

    mocks.getServerSession.mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
    });
    const forbidden = await GET(new Request(endpoint));
    expect(forbidden.status).toBe(403);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("returns versions and host updater state without caching the response", async () => {
    fetchMock().mockResolvedValueOnce(Response.json(release));
    await writeStatus({
      state: "failed",
      error: "download_failed",
      targetVersion: "v0.8.5",
      logTail: ["line"],
    });

    const response = await GET(new Request(endpoint));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      currentVersion: "v0.8.0",
      currentVersionKnown: true,
      latestRelease: {
        version: "v0.9.0",
        url: release.html_url,
        deployable: true,
      },
      releaseError: null,
      updateAvailable: true,
      updater: {
        available: true,
        busy: false,
        pendingRequest: null,
        status: {
          state: "failed",
          error: "download_failed",
          logTail: ["line"],
        },
      },
    });
    const [, init] = fetchMock().mock.calls[0] ?? [];
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it("serves the latest release from cache unless a refresh is requested", async () => {
    fetchMock().mockImplementation(async () => Response.json(release));

    await GET(new Request(endpoint));
    await GET(new Request(endpoint));
    expect(fetchMock()).toHaveBeenCalledOnce();

    await GET(new Request(`${endpoint}?refresh=1`));
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("still reports updater progress when GitHub is unavailable", async () => {
    fetchMock().mockRejectedValueOnce(new Error("network"));
    await writeStatus({
      state: "running",
      phase: "deploying",
      updatedAt: new Date().toISOString(),
    });

    const response = await GET(new Request(endpoint));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      latestRelease: null,
      releaseError: "release_unavailable",
      updateAvailable: false,
      updater: { busy: true, status: { state: "running", stale: false } },
    });
  });

  it("marks the updater unavailable when the host directories are not mounted", async () => {
    fetchMock().mockResolvedValueOnce(Response.json(release));
    vi.stubEnv("FLUXMEDIA_SYSTEM_UPDATE_DIR", path.join(updateDirectory, "x"));

    const body = await (await GET(new Request(endpoint))).json();

    expect(body.updater).toMatchObject({ available: false, status: null });
  });
});

describe("POST /api/admin/system-updates", () => {
  it("rejects cross-origin requests", async () => {
    const response = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: { origin: "https://attacker.example" },
        body: JSON.stringify({ version: "v0.9.0" }),
      })
    );

    expect(response.status).toBe(403);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("rejects requests without an origin", async () => {
    const response = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ version: "v0.9.0" }),
      })
    );

    expect(response.status).toBe(403);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("rejects non-JSON requests from the trusted origin", async () => {
    const response = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: {
          origin: "https://app.example.com",
          "content-type": "text/plain",
        },
        body: JSON.stringify({ version: "v0.9.0" }),
      })
    );

    expect(response.status).toBe(400);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("queues the latest release for the host updater without any token", async () => {
    fetchMock().mockResolvedValueOnce(Response.json(release));

    const response = await postUpdate("v0.9.0");

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({ queued: true, version: "v0.9.0" });
    expect(JSON.parse(await readFile(requestPath(), "utf8"))).toEqual({
      version: "v0.9.0",
      requestId: body.requestId,
      requestedBy: "root-1",
    });
    expect(body.requestId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(fetchMock()).toHaveBeenCalledOnce();
  });

  it("refuses a stale requested version", async () => {
    fetchMock().mockResolvedValueOnce(Response.json(release));

    const response = await postUpdate("v0.8.1");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "release_not_deployable" });
  });

  it("refuses a release without a deployment bundle", async () => {
    fetchMock().mockResolvedValueOnce(
      Response.json({ ...release, assets: [] })
    );

    const response = await postUpdate("v0.9.0");

    expect(response.status).toBe(409);
    await expect(readFile(requestPath())).rejects.toThrow();
  });

  it("refuses a new request while an update is running", async () => {
    await writeStatus({
      state: "running",
      phase: "deploying",
      updatedAt: new Date().toISOString(),
    });

    const response = await postUpdate("v0.9.0");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "update_in_progress" });
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("allows a new request when a queued request was never picked up", async () => {
    await writeFile(
      requestPath(),
      JSON.stringify({ version: "v0.9.0", requestId: "old-request-1" })
    );
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(requestPath(), longAgo, longAgo);
    fetchMock().mockResolvedValueOnce(Response.json(release));

    const response = await postUpdate("v0.9.0");

    expect(response.status).toBe(202);
  });

  it("reports a missing host updater", async () => {
    vi.stubEnv("FLUXMEDIA_SYSTEM_UPDATE_DIR", path.join(updateDirectory, "x"));

    const response = await postUpdate("v0.9.0");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "updater_not_installed" });
  });
});
