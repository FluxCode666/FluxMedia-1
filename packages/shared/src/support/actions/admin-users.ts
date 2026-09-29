import { requestGoBackendJson, type UntypedGoBackendJson } from "../../http/go-backend";
import { z } from "zod";
import { adminAction, superAdminAction } from "../../safe-action";
const go = <T>(path: string, body?: unknown, method = "GET") =>
  requestGoBackendJson<T>(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const a=(name:string)=>adminAction.metadata({action:`support.adminUsers.${name}`}).schema(z.any()); const sa=(name:string)=>superAdminAction.metadata({action:`support.adminUsers.${name}`}).schema(z.any());
export const getAllUsersAction=a("getAllUsers").action(async({parsedInput})=>{const q=new URLSearchParams(Object.entries(parsedInput||{}).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));return go<UntypedGoBackendJson>(`/api/admin/users?${q}`);});
export const getUserDetailAction=a("getUserDetail").action(async({parsedInput})=>go<UntypedGoBackendJson>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}`));
export const createUserAction=sa("createUser").action(async({parsedInput})=>go<UntypedGoBackendJson>("/api/admin/users",parsedInput,"POST"));
export const updateUserRoleAction=sa("updateUserRole").action(async({parsedInput})=>go<UntypedGoBackendJson>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}`,{role:parsedInput.role,reason:parsedInput.reason},"PATCH"));
export const updateUserProfileAction=sa("updateUserProfile").action(async({parsedInput})=>go<UntypedGoBackendJson>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}`,parsedInput,"PATCH"));
export const setUserPasswordAction=sa("setUserPassword").action(async({parsedInput})=>go<UntypedGoBackendJson>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}`,parsedInput,"PATCH"));
export const banUserAction=a("banUser").action(async({parsedInput})=>go<UntypedGoBackendJson>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}`,parsedInput,"PATCH"));
export const adminGrantCreditsAction=a("grantCredits").action(async({parsedInput})=>go<UntypedGoBackendJson>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}/credits/grant`,parsedInput,"POST"));
export const adminAdjustCreditsAction=sa("adjustCredits").action(async({parsedInput})=>go<UntypedGoBackendJson>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}/credits/adjust`,parsedInput,"POST"));
export const setUserCreditsStatusAction=a("setCreditsStatus").action(async({parsedInput})=>go<UntypedGoBackendJson>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}/credits/status`,parsedInput,"POST"));
export const setExternalApiKeyStatusAction=a("setExternalApiKeyStatus").action(async({parsedInput})=>go<UntypedGoBackendJson>(`/api/admin/api-keys/${encodeURIComponent(parsedInput.keyId)}/status`,parsedInput,"POST"));
export const setUserModerationPolicyAction=a("setModerationPolicy").action(async({parsedInput})=>go<UntypedGoBackendJson>(`/api/moderation/users/${encodeURIComponent(parsedInput.userId)}/policy`,parsedInput,"POST"));
export const setUserImageGenerationConcurrencyAction=a("setImageGenerationConcurrency").action(async({parsedInput})=>go<UntypedGoBackendJson>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}/concurrency`,parsedInput,"POST"));
