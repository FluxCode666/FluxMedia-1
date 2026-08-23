/**
 * IP 地址安全校验工具函数。
 *
 * 纯函数，不依赖 Node 或浏览器专属 API。用于 SSRF 防护中判定解析出的 IP 是否属于
 * 私有/保留地址段，被共享媒体 schema 与服务端 dns-pin.ts 共同复用。
 *
 * 覆盖段（RFC 1918 / RFC 4193 / RFC 5737 等）：
 * - IPv4: 私网、环回、链路本地、CGNAT、基准测试、文档网段、组播和保留网段
 * - IPv6: 未指定、环回、IPv4-mapped、discard、文档、ULA、链路本地和组播
 */
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

type IPv4Cidr = readonly [address: string, prefix: number];
type IPv6Cidr = readonly [address: string, prefix: number];

/** 解析点分十进制 IPv4；非法值返回 null，避免把模糊地址当作公网地址。 */
function parseIPv4(value: string): number | null {
  const octets = value.split(".");
  if (octets.length !== 4) return null;
  let result = 0;
  for (const octet of octets) {
    if (
      !/^\d{1,3}$/u.test(octet) ||
      (octet.length > 1 && octet.startsWith("0"))
    ) {
      return null;
    }
    const number = Number(octet);
    if (number > 255) return null;
    result = result * 256 + number;
  }
  return result;
}

/** 把 IPv4 嵌入段转换成 IPv6 的两个 16 位分组。 */
function replaceEmbeddedIPv4(value: string): string | null {
  if (!value.includes(".")) return value;
  const separatorIndex = value.lastIndexOf(":");
  if (separatorIndex < 0) return null;
  const ipv4 = parseIPv4(value.slice(separatorIndex + 1));
  if (ipv4 === null) return null;
  const high = Math.floor(ipv4 / 65_536).toString(16);
  const low = (ipv4 % 65_536).toString(16);
  return `${value.slice(0, separatorIndex + 1)}${high}:${low}`;
}

/** 解析 IPv6（含 IPv4-mapped 形式）为八个 16 位分组。 */
function parseIPv6(value: string): number[] | null {
  const cleaned = value.replace(/^\[|\]$/g, "").toLowerCase();
  const expandedIPv4 = replaceEmbeddedIPv4(cleaned);
  if (expandedIPv4 === null) return null;
  const compressionIndex = expandedIPv4.indexOf("::");
  if (
    compressionIndex !== -1 &&
    compressionIndex !== expandedIPv4.lastIndexOf("::")
  ) {
    return null;
  }

  const parseGroups = (groups: string): number[] | null => {
    if (groups === "") return [];
    const values = groups.split(":");
    if (values.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) {
      return null;
    }
    return values.map((group) => Number.parseInt(group, 16));
  };

  if (compressionIndex === -1) {
    const groups = parseGroups(expandedIPv4);
    return groups?.length === 8 ? groups : null;
  }

  const left = parseGroups(expandedIPv4.slice(0, compressionIndex));
  const right = parseGroups(expandedIPv4.slice(compressionIndex + 2));
  if (left === null || right === null || left.length + right.length >= 8) {
    return null;
  }
  return [
    ...left,
    ...Array.from({ length: 8 - left.length - right.length }, () => 0),
    ...right,
  ];
}

/** 判断 IPv4 数值是否落在 CIDR 网段。 */
function isIPv4InCidr(value: number, [network, prefix]: IPv4Cidr): boolean {
  const parsedNetwork = parseIPv4(network);
  if (parsedNetwork === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (parsedNetwork & mask) >>> 0;
}

/** 判断 IPv6 分组是否落在 CIDR 网段。 */
function isIPv6InCidr(value: number[], [network, prefix]: IPv6Cidr): boolean {
  const parsedNetwork = parseIPv6(network);
  if (parsedNetwork === null) return false;
  const fullGroups = Math.floor(prefix / 16);
  const remainingBits = prefix % 16;
  for (let index = 0; index < fullGroups; index += 1) {
    if (value[index] !== parsedNetwork[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (
    ((value[fullGroups] ?? 0) & mask) ===
    ((parsedNetwork[fullGroups] ?? 0) & mask)
  );
}

/**
 * 判定 IPv4 地址是否为私有/保留/不可路由地址。
 *
 * @param ip 点分十进制 IPv4 字符串，如 "10.0.0.1"
 * @returns true 表示该地址不应被外部请求访问
 */
export function isPrivateIPv4(ip: string): boolean {
  const parsed = parseIPv4(ip);
  return (
    parsed !== null &&
    BLOCKED_IPV4_CIDRS.some((cidr) => isIPv4InCidr(parsed, cidr))
  );
}

/**
 * 判定 IPv6 地址是否为私有/保留/不可路由地址。
 *
 * @param ip 标准化后的 IPv6 字符串（含或不含方括号均可）
 * @returns true 表示该地址不应被外部请求访问
 */
export function isPrivateIPv6(ip: string): boolean {
  const parsed = parseIPv6(ip);
  return (
    parsed !== null &&
    BLOCKED_IPV6_CIDRS.some((cidr) => isIPv6InCidr(parsed, cidr))
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
