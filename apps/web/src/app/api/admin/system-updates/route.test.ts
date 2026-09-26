import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getServerSession: vi.fn() }));
vi.mock("@repo/shared/auth/server", () => ({
  getServerSession: mocks.getServerSession,
}));

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
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("FLUXMEDIA_RELEASE_TAG", "v0.8.0");
  vi.stubEnv("FLUXMEDIA_GITHUB_ACTIONS_TOKEN", "dispatch-token");
  mocks.getServerSession.mockResolvedValue({
    user: { id: "root-1", role: "super_admin" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function fetchMock() {
  return vi.mocked(fetch);
}

describe("GET /api/admin/system-updates", () => {
  it("requires an authenticated super administrator", async () => {
    mocks.getServerSession.mockResolvedValueOnce(null);
    const unauthorized = await GET();
    expect(unauthorized.status).toBe(401);

    mocks.getServerSession.mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
    });
    const forbidden = await GET();
    expect(forbidden.status).toBe(403);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("returns the current version and latest stable release without caching", async () => {
    fetchMock().mockResolvedValueOnce(Response.json(release));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      currentVersion: "v0.8.0",
      currentVersionKnown: true,
      latestRelease: {
        version: "v0.9.0",
        name: "FluxMedia 0.9.0",
        notes: "Release notes",
        url: release.html_url,
        publishedAt: release.published_at,
      },
      updateAvailable: true,
      canDeploy: true,
    });
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

  it("only dispatches the current latest release through workflow_dispatch", async () => {
    fetchMock()
      .mockResolvedValueOnce(Response.json(release))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const response = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: {
          origin: "https://app.example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: "v0.9.0" }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dispatched: true,
      version: "v0.9.0",
      workflowUrl:
        "https://github.com/FluxCode666/FluxMedia-1/actions/workflows/deploy-production.yml",
    });
    const [url, init] = fetchMock().mock.calls[1] ?? [];
    expect(url).toBe(
      "https://api.github.com/repos/FluxCode666/FluxMedia-1/actions/workflows/deploy-production.yml/dispatches"
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer dispatch-token"
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      ref: "v0.9.0",
      inputs: { version: "v0.9.0", skip_deploy: "false" },
    });
  });

  it("refuses a stale requested version", async () => {
    fetchMock().mockResolvedValueOnce(Response.json(release));

    const response = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: {
          origin: "https://app.example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: "v0.8.1" }),
      })
    );

    expect(response.status).toBe(409);
    expect(fetchMock()).toHaveBeenCalledOnce();
  });

  it("reports missing dispatch credentials without exposing secrets", async () => {
    vi.stubEnv("FLUXMEDIA_GITHUB_ACTIONS_TOKEN", "");
    fetchMock().mockResolvedValueOnce(Response.json(release));

    const response = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: {
          origin: "https://app.example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: "v0.9.0" }),
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "dispatch_not_configured" });
  });
});
