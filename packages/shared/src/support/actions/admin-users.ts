"use server";
import { cookies } from "next/headers";
import { z } from "zod";
import { adminAction, superAdminAction } from "../../safe-action";
async function go<T>(path:string, body?:unknown, method="GET"):Promise<T>{const base=(process.env.GO_BACKEND_URL||"http://127.0.0.1:8080").replace(/\/$/u,"");const cookie=(await cookies()).getAll().map(c=>`${c.name}=${c.value}`).join("; ");const h:Record<string,string>={...(body!==undefined?{"content-type":"application/json"}:{}),...(cookie?{cookie}: {})};const r=await fetch(base+path,{method,headers:h,...(body!==undefined?{body:JSON.stringify(body)}:{}),cache:"no-store"});const p=await r.json().catch(()=>null) as T & {error?:{message?:string}};if(!r.ok)throw new Error(p?.error?.message||`请求失败 (${r.status})`);return p;}
const a=(name:string)=>adminAction.metadata({action:`support.adminUsers.${name}`}).schema(z.any()); const sa=(name:string)=>superAdminAction.metadata({action:`support.adminUsers.${name}`}).schema(z.any());
export const getAllUsersAction=a("getAllUsers").action(async({parsedInput})=>{const q=new URLSearchParams(Object.entries(parsedInput||{}).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));return go<any>(`/api/admin/users?${q}`);});
export const getUserDetailAction=a("getUserDetail").action(async({parsedInput})=>go<any>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}`));
export const createUserAction=sa("createUser").action(async({parsedInput})=>go<any>("/api/admin/users",parsedInput,"POST"));
export const updateUserRoleAction=sa("updateUserRole").action(async({parsedInput})=>go<any>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}`,{role:parsedInput.role,reason:parsedInput.reason},"PATCH"));
export const updateUserProfileAction=sa("updateUserProfile").action(async({parsedInput})=>go<any>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}`,parsedInput,"PATCH"));
export const setUserPasswordAction=sa("setUserPassword").action(async({parsedInput})=>go<any>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}`,parsedInput,"PATCH"));
export const banUserAction=a("banUser").action(async({parsedInput})=>go<any>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}`,parsedInput,"PATCH"));
export const adminGrantCreditsAction=a("grantCredits").action(async({parsedInput})=>go<any>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}/credits/grant`,parsedInput,"POST"));
export const adminAdjustCreditsAction=sa("adjustCredits").action(async({parsedInput})=>go<any>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}/credits/adjust`,parsedInput,"POST"));
export const setUserCreditsStatusAction=a("setCreditsStatus").action(async({parsedInput})=>go<any>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}/credits/status`,parsedInput,"POST"));
export const setExternalApiKeyStatusAction=a("setExternalApiKeyStatus").action(async({parsedInput})=>go<any>(`/api/admin/api-keys/${encodeURIComponent(parsedInput.keyId)}/status`,parsedInput,"POST"));
export const setUserModerationPolicyAction=a("setModerationPolicy").action(async({parsedInput})=>go<any>(`/api/moderation/users/${encodeURIComponent(parsedInput.userId)}/policy`,parsedInput,"POST"));
export const setUserImageGenerationConcurrencyAction=a("setImageGenerationConcurrency").action(async({parsedInput})=>go<any>(`/api/admin/users/${encodeURIComponent(parsedInput.userId)}/concurrency`,parsedInput,"POST"));
