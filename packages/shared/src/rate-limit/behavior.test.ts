/** Go owns admission; Next only transports results and formats HTTP responses. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
const mocks=vi.hoisted(()=>({request:vi.fn()}));
vi.mock("../http/go-backend",()=>({requestGoBackendInternalJson:mocks.request}));
import {checkRateLimit,withRateLimit,getClientIp} from "./index";
beforeEach(()=>{vi.clearAllMocks();vi.unstubAllEnvs()});
describe("Go rate limit adapter",()=>{
 it("forwards the server scope and preserves Go admission",async()=>{
  const denied={success:false,remaining:0,reset:Date.now()+60000,limit:3,skipped:false};mocks.request.mockResolvedValue(denied);
  await expect(checkRateLimit("analytics-dashboard:user-1","global")).resolves.toEqual(denied);
  expect(mocks.request).toHaveBeenCalledWith("/api/internal/rate-limit",{method:"POST",body:JSON.stringify({identifier:"analytics-dashboard:user-1",type:"global"})});
 });
 it("short circuits denied work and returns retry headers",async()=>{
  mocks.request.mockResolvedValue({success:false,remaining:0,reset:Date.now()+60000,limit:3,skipped:false});const handler=vi.fn(async()=>new Response("ok"));
  const response=await withRateLimit({headers:new Headers()} as NextRequest,{getIdentifier:()=>"analytics-dashboard:user-1"},handler);
  expect(response.status).toBe(429);expect(response.headers.get("X-RateLimit-Limit")).toBe("3");expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);expect(handler).not.toHaveBeenCalled();
 });
 it("forwards response headers on admitted work",async()=>{
  mocks.request.mockResolvedValue({success:true,remaining:2,reset:12000,limit:3,skipped:false});const response=await withRateLimit({headers:new Headers()} as NextRequest,{getIdentifier:()=>"analytics-dashboard:user-1"},async()=>new Response("ok"));
  expect(await response.text()).toBe("ok");expect(response.headers.get("X-RateLimit-Remaining")).toBe("2");
 });
 it("retains the legacy header parser without using it to own counters",()=>{
  vi.stubEnv("RATE_LIMIT_TRUSTED_PROXY","false");expect(getClientIp({headers:new Headers({"x-forwarded-for":"8.8.8.8"})} as NextRequest)).toBe("untrusted-proxy");
 });
});
