"use server";
import { cookies } from "next/headers";
import { z } from "zod";
import { protectedAction } from "../safe-action";
async function go<T>(path:string, init:RequestInit={}):Promise<T>{const base=(process.env.GO_BACKEND_URL||process.env.BETTER_AUTH_URL||"http://127.0.0.1:8080").replace(/\/$/u,"");const cookie=(await cookies()).getAll().map(c=>`${c.name}=${c.value}`).join("; ");const headers=new Headers(init.headers);if(init.body&&!headers.has("content-type"))headers.set("content-type","application/json");if(cookie)headers.set("cookie",cookie);const r=await fetch(base+path,{...init,headers,cache:"no-store"});const p=await r.json().catch(()=>null) as T & {error?:{message?:string}};if(!r.ok)throw new Error(p?.error?.message||`请求失败 (${r.status})`);return p;}
const withStorage=(name:string)=>protectedAction.metadata({action:`storage.${name}`});
export const getSignedUploadUrlAction=withStorage("getSignedUploadUrl").schema(z.object({key:z.string().min(1).max(255),contentType:z.enum(["image/jpeg","image/png","image/gif","image/webp"]),bucket:z.string().optional()})).action(async({parsedInput})=>go<any>("/api/upload/presigned",{method:"POST",body:JSON.stringify(parsedInput)}));
export const deleteFileAction=withStorage("deleteFile").schema(z.object({key:z.string().min(1),bucket:z.string().optional()})).action(async({parsedInput})=>go<any>("/api/storage/delete",{method:"POST",body:JSON.stringify(parsedInput)}));
