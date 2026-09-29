import { requestGoBackendJson } from "../http/go-backend";
import { z } from "zod";
import { protectedAction } from "../safe-action";
const go = <T>(path: string, init: RequestInit = {}) => requestGoBackendJson<T>(path, init);
const withStorage=(name:string)=>protectedAction.metadata({action:`storage.${name}`});
export const getSignedUploadUrlAction=withStorage("getSignedUploadUrl").schema(z.object({key:z.string().min(1).max(255),contentType:z.enum(["image/jpeg","image/png","image/gif","image/webp"]),bucket:z.string().optional()})).action(async({parsedInput})=>go<any>("/api/upload/presigned",{method:"POST",body:JSON.stringify(parsedInput)}));
export const deleteFileAction=withStorage("deleteFile").schema(z.object({key:z.string().min(1),bucket:z.string().optional()})).action(async({parsedInput})=>go<any>("/api/storage/delete",{method:"POST",body:JSON.stringify(parsedInput)}));
