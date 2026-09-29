import { requestGoBackendJson } from "../http/go-backend";
import { adminAction, protectedAction } from "../safe-action";
import { announcementIdSchema, createAnnouncementSchema, updateAnnouncementSchema } from "./schemas";
const go = <T>(path: string, init: RequestInit = {}) => requestGoBackendJson<T>(path, init);
export async function countUnreadAnnouncementsForUser(_userId:string){const x=await go<{count:number}>("/api/announcements/unread-count");return x.count??0;}
export async function markAnnouncementIdsReadForUser(_userId:string, ids:string[]){let n=0;for(const id of Array.from(new Set(ids)).filter(Boolean)){await go("/api/announcements/read",{method:"POST",body:JSON.stringify({id})});n++;}return n;}
export const getMyUnreadAnnouncementCountAction=protectedAction.metadata({action:"announcements.getMyUnreadCount"}).action(async()=>go<{count:number}>("/api/announcements/unread-count"));
export const markAllAnnouncementsReadAction=protectedAction.metadata({action:"announcements.markAllRead"}).action(async()=>go<{count:number}>("/api/announcements/read-all",{method:"POST",body:"{}"}));
export const markAnnouncementReadAction=protectedAction.metadata({action:"announcements.markRead"}).schema(announcementIdSchema).action(async({parsedInput})=>go("/api/announcements/read",{method:"POST",body:JSON.stringify({id:parsedInput.id})}));
export const createAnnouncementAction=adminAction.metadata({action:"announcements.admin.create"}).schema(createAnnouncementSchema).action(async({parsedInput})=>go("/api/admin/announcements",{method:"POST",body:JSON.stringify(parsedInput)}));
export const updateAnnouncementAction=adminAction.metadata({action:"announcements.admin.update"}).schema(updateAnnouncementSchema).action(async({parsedInput})=>{const {id,...payload}=parsedInput;return go(`/api/admin/announcements/${encodeURIComponent(id)}`,{method:"PUT",body:JSON.stringify(payload)});});
export const deleteAnnouncementAction=adminAction.metadata({action:"announcements.admin.delete"}).schema(announcementIdSchema).action(async({parsedInput})=>go(`/api/admin/announcements/${encodeURIComponent(parsedInput.id)}`,{method:"DELETE",body:"{}"}));
export const toggleAnnouncementPublishAction=adminAction.metadata({action:"announcements.admin.togglePublish"}).schema(announcementIdSchema).action(async({parsedInput})=>go(`/api/admin/announcements/${encodeURIComponent(parsedInput.id)}/toggle`,{method:"POST",body:"{}"}));
