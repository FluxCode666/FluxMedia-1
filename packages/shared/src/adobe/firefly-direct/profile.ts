/**
 * Adobe 网页客户端 Profile 的统一定义。
 *
 * 使用方：IMS Cookie 换 Token、Firefly 直连请求头和视频任务恢复。
 * 同一 Adobe 账号可以同时持有两套短期 Token；Profile 决定 client_id、来源头和 API key，
 * 防止把 Express Token 错用于 Firefly 网页接口。
 */

export type AdobeFireflyWebApp = "express" | "firefly";

export type AdobeWebAppProfile = {
  imsClientId: string;
  imsScope: string;
  apiKey: string;
  origin: string;
  referer: string;
};

export const ADOBE_WEB_APP_PROFILES: Record<
  AdobeFireflyWebApp,
  AdobeWebAppProfile
> = {
  express: {
    imsClientId: "projectx_webapp",
    imsScope: "AdobeID,firefly_api,openid",
    apiKey: "projectx_webapp",
    origin: "https://new.express.adobe.com",
    referer: "https://new.express.adobe.com/",
  },
  firefly: {
    imsClientId: "clio-playground-web",
    imsScope:
      "AdobeID,firefly_api,openid,pps.read,pps.write,additional_info.projectedProductContext,additional_info.ownerOrg,uds_read,uds_write,ab.manage,read_organizations,additional_info.roles,account_cluster.read,creative_production,tk_platform,tk_platform_sync,profile",
    apiKey: "clio-playground-web",
    origin: "https://firefly.adobe.com",
    referer: "https://firefly.adobe.com/",
  },
};
