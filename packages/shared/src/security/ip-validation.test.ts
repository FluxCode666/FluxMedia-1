/**
 * IP 地址 SSRF 边界测试。
 *
 * 使用方：Vitest；覆盖共享 schema 与服务端 DNS pin 共用的 IPv4、IPv6 和映射地址判断。
 */
import { describe, expect, it } from "vitest";
import { isBlockedIP, isPrivateIPv4, isPrivateIPv6 } from "./ip-validation";

describe("IP validation", () => {
  it.each([
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "192.168.1.1",
  ])("blocks private IPv4 %s", (ip) => {
    expect(isPrivateIPv4(ip)).toBe(true);
    expect(isBlockedIP(ip)).toBe(true);
  });

  it.each([
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["198.19.255.255", true],
  ])("classifies IPv4 %s according to the configured ranges", (ip, blocked) => {
    expect(isPrivateIPv4(ip)).toBe(blocked);
  });

  it.each([
    "::",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:192.168.1.1",
  ])("blocks reserved IPv6 %s", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(true);
    expect(isBlockedIP(ip)).toBe(true);
  });

  it.each([
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
  ])("allows public IPv6 %s", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(false);
    expect(isBlockedIP(ip)).toBe(false);
  });

  it("rejects malformed addresses instead of treating them as blocked", () => {
    expect(isPrivateIPv4("127.0.0")).toBe(false);
    expect(isPrivateIPv4("010.0.0.1")).toBe(false);
    expect(isPrivateIPv6("2001:::1")).toBe(false);
    expect(isBlockedIP("not-an-ip")).toBe(false);
  });
});
