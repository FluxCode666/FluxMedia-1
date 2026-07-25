/**
 * IP 地址安全校验工具函数。
 *
 * 纯函数，仅依赖 Node 内置 net。用于 SSRF 防护中判定解析出的 IP 是否属于私有/保留地址段。
 * 被 dns-pin.ts 与 safe-image-fetch.ts 共同复用。
 *
 * 覆盖段（RFC 1918 / RFC 4193 / RFC 5737 等）：
 * - IPv4: 私网、环回、链路本地、CGNAT、基准测试、文档网段、组播和保留网段
 * - IPv6: 未指定、环回、IPv4-mapped、discard、文档、ULA、链路本地和组播
 */
import { BlockList, isIP } from "node:net";

const BLOCKED_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

const BLOCKED_IPV6_CIDRS = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2001:10::", 28],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const;

/** 构建分离的进程内只读地址段表，避免 IPv4 被 IPv4-mapped IPv6 规则误匹配。 */
function createBlockedAddressLists(): {
  ipv4: BlockList;
  ipv6: BlockList;
} {
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();
  for (const [address, prefix] of BLOCKED_IPV4_CIDRS) {
    ipv4.addSubnet(address, prefix, "ipv4");
  }
  for (const [address, prefix] of BLOCKED_IPV6_CIDRS) {
    ipv6.addSubnet(address, prefix, "ipv6");
  }
  return { ipv4, ipv6 };
}

const BLOCKED_ADDRESS_LISTS = createBlockedAddressLists();

/**
 * 判定 IPv4 地址是否为私有/保留/不可路由地址。
 *
 * @param ip 点分十进制 IPv4 字符串，如 "10.0.0.1"
 * @returns true 表示该地址不应被外部请求访问
 */
export function isPrivateIPv4(ip: string): boolean {
  return isIP(ip) === 4 && BLOCKED_ADDRESS_LISTS.ipv4.check(ip, "ipv4");
}

/**
 * 判定 IPv6 地址是否为私有/保留/不可路由地址。
 *
 * @param ip 标准化后的 IPv6 字符串（含或不含方括号均可）
 * @returns true 表示该地址不应被外部请求访问
 */
export function isPrivateIPv6(ip: string): boolean {
  const cleaned = ip.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    isIP(cleaned) === 6 && BLOCKED_ADDRESS_LISTS.ipv6.check(cleaned, "ipv6")
  );
}

/**
 * 综合判定任意 IP（v4 或 v6）是否属于被封堵的私有/保留地址。
 *
 * @param ip IP 地址字符串
 * @returns true 表示该 IP 应被 SSRF 防护阻断
 */
export function isBlockedIP(ip: string): boolean {
  const cleaned = ip.replace(/^\[|\]$/g, "");

  // 判断是否为 IPv4（含点分十进制）
  if (cleaned.includes(".") && !cleaned.includes(":")) {
    return isPrivateIPv4(cleaned);
  }

  // IPv6（含 IPv4-mapped）
  return isPrivateIPv6(cleaned);
}
