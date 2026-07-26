/**
 * 媒体上游出站 URL 安全策略。
 *
 * 职责：在 API Images 与 Adobe gateway 保存和每次外呼前校验 HTTPS、凭据、
 * 元数据主机及 DNS 解析结果，并对重定向逐跳复验。私网例外只能来自部署环境的
 * 精确主机或 CIDR allowlist，不能由后台表单自授权。
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { isBlockedIP } from "@repo/shared/security/ip-validation";

const METADATA_HOSTNAMES = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

/** 可注入的 DNS 与部署 allowlist，供运行时和无网络单测共用。 */
export interface MediaUpstreamUrlSecurityOptions {
  resolve?: (hostname: string) => Promise<string[]>;
  privateAllowlist?: readonly string[];
}

/** 解析主机全部地址，确保任一私网结果都能触发 fail-closed。 */
async function resolveAllAddresses(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address }) => address);
}

/** 从部署环境读取精确主机或 CIDR allowlist。 */
function getConfiguredPrivateAllowlist(): string[] {
  return String(process.env.MEDIA_UPSTREAM_PRIVATE_ALLOWLIST || "")
    .split(/[,\n;]/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** 把 CIDR 条目加入 Node BlockList；非法条目按非匹配处理。 */
function addCidr(blockList: BlockList, value: string): boolean {
  const separator = value.lastIndexOf("/");
  if (separator <= 0) return false;
  const address = value.slice(0, separator);
  const prefix = Number(value.slice(separator + 1));
  const family = isIP(address);
  if (
    !family ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > (family === 4 ? 32 : 128)
  ) {
    return false;
  }
  blockList.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  return true;
}

/** 判断私网解析结果是否被部署级精确主机/CIDR 放行。 */
function isPrivateTargetAllowed(
  hostname: string,
  address: string,
  allowlist: readonly string[]
): boolean {
  const normalizedHost = hostname.toLowerCase();
  if (allowlist.some((entry) => entry.toLowerCase() === normalizedHost)) {
    return true;
  }
  const family = isIP(address);
  if (!family) return false;
  const cidrs = new BlockList();
  for (const entry of allowlist) addCidr(cidrs, entry.toLowerCase());
  return cidrs.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * 连接层 DNS pin 对已阻断地址的部署级例外判断。
 *
 * 仅精确主机或 CIDR allowlist 可放行；元数据主机永远拒绝。调用方必须同时执行完整
 * URL 校验，不能单独用本函数批准一个目标。
 */
export function isMediaUpstreamBlockedAddressAllowed(input: {
  hostname: string;
  address: string;
}): boolean {
  const hostname = input.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || METADATA_HOSTNAMES.has(hostname)) return false;
  return isPrivateTargetAllowed(
    hostname,
    input.address,
    getConfiguredPrivateAllowlist()
  );
}

/** 构造稳定且不回显目标凭据的安全错误。 */
function unsafeTarget(reason: string): Error {
  return new Error(`Unsafe media upstream URL: ${reason}`);
}

/**
 * 校验一个媒体上游 URL。
 *
 * @param rawUrl 数据库或表单中的不可信 URL。
 * @param options 测试 DNS 注入或部署级私网 allowlist。
 * @returns 已规范化 URL；调用方仍应在连接层 pin 已校验地址。
 * @throws 协议、凭据、元数据、DNS 或私网边界不满足时抛出稳定错误。
 */
export async function assertSafeMediaUpstreamUrl(
  rawUrl: string,
  options: MediaUpstreamUrlSecurityOptions = {}
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw unsafeTarget("invalid URL");
  }
  if (url.protocol !== "https:") {
    throw unsafeTarget("HTTPS is required");
  }
  if (url.username || url.password) {
    throw unsafeTarget("embedded credentials are forbidden");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || METADATA_HOSTNAMES.has(hostname)) {
    throw unsafeTarget("metadata targets are forbidden");
  }
  const allowlist = options.privateAllowlist ?? getConfiguredPrivateAllowlist();
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [hostname]
    : await (options.resolve ?? resolveAllAddresses)(hostname);
  if (addresses.length === 0) {
    throw unsafeTarget("DNS resolution returned no addresses");
  }
  for (const address of addresses) {
    if (!isIP(address)) {
      throw unsafeTarget("DNS returned an invalid address");
    }
    if (
      isBlockedIP(address) &&
      !isPrivateTargetAllowed(hostname, address, allowlist)
    ) {
      throw unsafeTarget("target resolves to a private or reserved address");
    }
  }
  return url;
}

/**
 * 解析并逐跳复验媒体上游重定向。
 *
 * @param currentUrl 当前已校验的请求 URL。
 * @param location 上游 Location 值，可为相对 URL。
 * @param options 与初始 URL 相同的 DNS/allowlist 约束。
 * @returns 已校验的下一跳 URL。
 */
export async function assertSafeMediaUpstreamRedirect(
  currentUrl: string | URL,
  location: string,
  options: MediaUpstreamUrlSecurityOptions = {}
): Promise<URL> {
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(location, currentUrl);
  } catch {
    throw unsafeTarget("invalid redirect URL");
  }
  return assertSafeMediaUpstreamUrl(redirectUrl.toString(), options);
}
