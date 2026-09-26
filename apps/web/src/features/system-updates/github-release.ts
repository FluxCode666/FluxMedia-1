const GITHUB_REPOSITORY = "FluxCode666/FluxMedia-1";
const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const VERSION_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: "alpha" | "beta" | "rc" | null;
  prereleaseNumber: number | null;
};

export type LatestRelease = {
  version: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string | null;
};

type GitHubRelease = {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
};

export function compareReleaseVersions(
  left: string,
  right: string
): number | null {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) return null;

  for (const key of ["major", "minor", "patch"] as const) {
    if (leftVersion[key] !== rightVersion[key]) {
      return leftVersion[key] > rightVersion[key] ? 1 : -1;
    }
  }

  if (leftVersion.prerelease === rightVersion.prerelease) {
    if (leftVersion.prereleaseNumber === rightVersion.prereleaseNumber)
      return 0;
    if (leftVersion.prereleaseNumber === null) return 1;
    if (rightVersion.prereleaseNumber === null) return -1;
    return leftVersion.prereleaseNumber > rightVersion.prereleaseNumber
      ? 1
      : -1;
  }

  if (!leftVersion.prerelease) return 1;
  if (!rightVersion.prerelease) return -1;
  const prereleaseOrder = { alpha: 0, beta: 1, rc: 2 };
  return prereleaseOrder[leftVersion.prerelease] >
    prereleaseOrder[rightVersion.prerelease]
    ? 1
    : -1;
}

export function getCurrentReleaseVersion() {
  const configuredVersion = process.env.FLUXMEDIA_RELEASE_TAG?.trim();
  return configuredVersion && parseVersion(configuredVersion)
    ? configuredVersion
    : "unknown";
}

export function canUpdateTo(currentVersion: string, latestVersion: string) {
  const comparison = compareReleaseVersions(latestVersion, currentVersion);
  return comparison !== null && comparison > 0;
}

export async function getLatestGitHubRelease(): Promise<LatestRelease> {
  const token = process.env.FLUXMEDIA_GITHUB_ACTIONS_TOKEN?.trim();
  const response = await fetch(
    `${GITHUB_API}/repos/${GITHUB_REPOSITORY}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub releases request failed (${response.status})`);
  }

  const release = (await response.json()) as GitHubRelease;
  const tagName =
    typeof release.tag_name === "string" ? release.tag_name : null;
  const parsedVersion = tagName ? parseVersion(tagName) : null;
  if (
    !tagName ||
    !parsedVersion ||
    parsedVersion.prerelease !== null ||
    typeof release.html_url !== "string" ||
    !isExpectedReleaseUrl(release.html_url, tagName) ||
    release.draft === true ||
    release.prerelease === true
  ) {
    throw new Error("GitHub returned an invalid stable release");
  }

  return {
    version: tagName,
    name: typeof release.name === "string" ? release.name : tagName,
    notes: typeof release.body === "string" ? release.body : "",
    url: release.html_url,
    publishedAt:
      typeof release.published_at === "string" ? release.published_at : null,
  };
}

export async function dispatchProductionDeployment(version: string) {
  const token = process.env.FLUXMEDIA_GITHUB_ACTIONS_TOKEN?.trim();
  if (!token)
    throw new Error("GitHub Actions dispatch token is not configured");
  if (!parseVersion(version)) throw new Error("Invalid release version");

  const response = await fetch(
    `${GITHUB_API}/repos/${GITHUB_REPOSITORY}/actions/workflows/deploy-production.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: JSON.stringify({
        ref: version,
        inputs: { version, skip_deploy: "false" },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub deployment dispatch failed (${response.status})`);
  }
  return {
    workflowUrl: `https://github.com/${GITHUB_REPOSITORY}/actions/workflows/deploy-production.yml`,
  };
}

function isExpectedReleaseUrl(url: string, version: string) {
  return [
    `https://github.com/${GITHUB_REPOSITORY}/releases/${version}`,
    `https://github.com/${GITHUB_REPOSITORY}/releases/tag/${version}`,
  ].includes(url);
}

function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prereleaseNumber = match[5] === undefined ? null : Number(match[5]);
  if (
    ![major, minor, patch].every(Number.isSafeInteger) ||
    (prereleaseNumber !== null && !Number.isSafeInteger(prereleaseNumber))
  ) {
    return null;
  }
  return {
    major,
    minor,
    patch,
    prerelease: (match[4] as ParsedVersion["prerelease"]) ?? null,
    prereleaseNumber,
  };
}
