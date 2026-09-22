/** Runtime configuration is resolved by Go, and failures cannot bypass admission in Node. */
import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({request:vi.fn()}));
vi.mock("../http/go-backend",()=>({requestGoBackendInternalJson:mocks.request}));
import {checkRateLimit} from "./index";
beforeEach(()=>{vi.clearAllMocks();vi.unstubAllEnvs()});
describe("Go rate limit runtime authority",()=>{
 it("accepts each Go runtime limit independently of local env metadata",async()=>{
  vi.stubEnv("RATE_LIMIT_GLOBAL_REQUESTS_PER_MINUTE","99999");
  mocks.request.mockResolvedValueOnce({success:true,remaining:1,reset:60000,limit:2,skipped:false}).mockResolvedValueOnce({success:false,remaining:0,reset:60000,limit:1,skipped:false});
  expect((await checkRateLimit("analytics-dashboard:u")).limit).toBe(2);expect((await checkRateLimit("analytics-dashboard:u")).success).toBe(false);
 });
 it("propagates unavailable Go instead of opening a Node fallback bucket",async()=>{
  mocks.request.mockRejectedValue(new Error("Go unavailable"));await expect(checkRateLimit("analytics-dashboard:u")).rejects.toThrow("Go unavailable");
 });
});
