/**
 * 站内系统更新的 GitHub Release 读取与版本比较。
 *
 * 使用方：/api/admin/system-updates。仓库公开，匿名读取 Release 即可，不需要任何
 * GitHub token；真正的发布由宿主机更新器完成（见 host-updater.ts）。
 * 匿名 API 每个 IP 每小时仅 60 次，因此最新 Release 在进程内缓存，页面轮询不会耗尽额度。
 */
const GITHUB_REPOSITORY = "FluxCode666/FluxMedia-1";
const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const LATEST_RELEASE_CACHE_TTL_MS = 5 * 60 * 1000;
// 与 Release 流水线产出的资产名一致；缺少任一资产的 Release 无法由宿主机更新器发布。
const REQUIRED_RELEASE_ASSETS = [
  "fluxmedia-release.env",
  "fluxmedia-deploy.tar.gz",
] as const;
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
  /** Release 是否附带部署包；旧流水线发布的版本没有部署包，不能站内更新。 */
  deployable: boolean;
};

type GitHubRelease = {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
};

let latestReleaseCache: { release: LatestRelease; expiresAt: number } | null =
  null;

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

export function clearLatestReleaseCache() {
  latestReleaseCache = null;
}

export async function getLatestGitHubRelease(
  options: { refresh?: boolean } = {}
): Promise<LatestRelease> {
  if (
    !options.refresh &&
    latestReleaseCache &&
    latestReleaseCache.expiresAt > Date.now()
  ) {
    return latestReleaseCache.release;
  }

  const response = await fetch(
    `${GITHUB_API}/repos/${GITHUB_REPOSITORY}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
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

  const latestRelease: LatestRelease = {
    version: tagName,
    name: typeof release.name === "string" ? release.name : tagName,
    notes: typeof release.body === "string" ? release.body : "",
    url: release.html_url,
    publishedAt:
      typeof release.published_at === "string" ? release.published_at : null,
    deployable: hasRequiredAssets(release.assets),
  };
  latestReleaseCache = {
    release: latestRelease,
    expiresAt: Date.now() + LATEST_RELEASE_CACHE_TTL_MS,
  };
  return latestRelease;
}

function hasRequiredAssets(assets: unknown) {
  if (!Array.isArray(assets)) return false;
  const names = new Set(
    assets
      .map((asset: unknown) =>
        asset && typeof asset === "object" && "name" in asset
          ? (asset as { name: unknown }).name
          : null
      )
      .filter((name): name is string => typeof name === "string")
  );
  return REQUIRED_RELEASE_ASSETS.every((name) => names.has(name));
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
