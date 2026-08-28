/**
 * 站内图片异步任务的身份契约。
 *
 * 职责：为没有外部 API Key 的站内会话提供数据库必填的凭据域标记；该值只用于
 * 区分任务归属，不代表真实凭据，也不得传入外部上游或积分账户操作。
 * 使用方：站内图片路由与图片异步任务 UOL binding。
 */

/** image_async_task.api_key_id 的站内会话保留标记。 */
export const SITE_IMAGE_ASYNC_API_KEY_ID = "web:session";

/** 判断异步任务是否由站内会话创建。 */
export function isSiteImageAsyncTaskApiKeyId(value: string): boolean {
  return value === SITE_IMAGE_ASYNC_API_KEY_ID;
}
