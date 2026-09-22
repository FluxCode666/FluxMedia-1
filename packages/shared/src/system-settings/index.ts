/** Runtime settings come from the Go service; this module only adapts shared frontend contracts. */
import { requestGoBackendJson, requestGoBackendInternalJson } from '../http/go-backend';
import { parseModelMarketplaceConfig } from '../model-marketplace';
import type { VideoBillingModelPricingDescriptor } from '../video-generation/video-pricing';
import { GENERATIONS_BUCKET_SETTING_KEY, SYSTEM_ASSETS_BUCKET_SETTING_KEY, parseRuntimeStorageBucketConfig } from '../storage/bucket-config';
import { type SettingKey, type SettingDefinition } from './definitions';
import { resolveSiteLogoUrl, type SiteBranding } from './site-branding';
import { normalizeVideoModelBillingSettings, type VideoModelBillingSettings } from './video-billing-settings';
export {
  normalizeVideoModelBillingSettings,
  type VideoModelBillingSettings,
} from "./video-billing-settings";

/** Compatibility hook: every read now asks Go with no-store, so no Node cache exists to invalidate. */
export async function invalidateSystemSettingsCache(): Promise<void> {}

export {
  SETTING_CATEGORIES,
  SETTING_DEFINITION_BY_KEY,
  type SettingCategory,
  type SettingDefinition,
  type SettingKey,
  type SettingValueType,
  SYSTEM_SETTING_DEFINITIONS,
} from "./definitions";

export {
  DEFAULT_SITE_LOGO_URL,
  resolveSiteLogoUrl,
  SITE_LOGO_ROUTE_PATH,
  type SiteBranding,
  siteBrandingSchema,
  siteLogoUrlSchema,
} from "./site-branding";

const PROCESS_SETTING_FALLBACKS_BEFORE_BOOTSTRAP = new Map<
  string,
  string | undefined
>();

const LEGACY_STORAGE_SETTING_ALIASES = {
  MODEL_MARKETPLACE_ASSETS_BUCKET_NAME: SYSTEM_ASSETS_BUCKET_SETTING_KEY,
  SITE_ASSETS_BUCKET_NAME: SYSTEM_ASSETS_BUCKET_SETTING_KEY,
  NEXT_PUBLIC_AVATARS_BUCKET_NAME: SYSTEM_ASSETS_BUCKET_SETTING_KEY,
  NEXT_PUBLIC_GENERATIONS_BUCKET_NAME: GENERATIONS_BUCKET_SETTING_KEY,
} as const satisfies Partial<Record<SettingKey, SettingKey>>;

function resolveCanonicalSettingKey(key: SettingKey): SettingKey {
  return (
    LEGACY_STORAGE_SETTING_ALIASES[
      key as keyof typeof LEGACY_STORAGE_SETTING_ALIASES
    ] ?? key
  );
}

function getRuntimeEnvironmentFallback(key: SettingKey) {
  const canonicalKey = resolveCanonicalSettingKey(key);
  if (PROCESS_SETTING_FALLBACKS_BEFORE_BOOTSTRAP.has(canonicalKey)) {
    return PROCESS_SETTING_FALLBACKS_BEFORE_BOOTSTRAP.get(canonicalKey);
  }
  return process.env[canonicalKey]?.trim() || undefined;
}

export function setBootstrappedProcessSetting(key: string, value: string) {
  if (!PROCESS_SETTING_FALLBACKS_BEFORE_BOOTSTRAP.has(key)) {
    PROCESS_SETTING_FALLBACKS_BEFORE_BOOTSTRAP.set(
      key,
      process.env[key]?.trim() || undefined
    );
  }
  process.env[key] = value;
}

export function resetBootstrappedProcessSettingsForTests() {
  PROCESS_SETTING_FALLBACKS_BEFORE_BOOTSTRAP.clear();
}

function parseJsonText(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return JSON.parse(trimmed) as unknown;
}

export async function getRuntimeSettingJson(key: SettingKey) {
  const value = await getSystemSettingValue(key);
  if (value !== undefined) {
    if (typeof value === "string") return parseJsonText(value);
    return value;
  }

  const envValue = getRuntimeEnvironmentFallback(key);
  if (!envValue?.trim()) return undefined;
  return parseJsonText(envValue);
}

export async function getSystemSettingString(key: SettingKey) {
  const value = await getSystemSettingValue(key);
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

export async function getRuntimeSettingString(key: SettingKey) {
  const value = await getSystemSettingString(key);
  return value ?? getRuntimeEnvironmentFallback(key);
}

export async function getRuntimeStorageBucketConfig() {
  const [systemAssets, generations] = await Promise.all([
    getRuntimeSettingString(SYSTEM_ASSETS_BUCKET_SETTING_KEY),
    getRuntimeSettingString(GENERATIONS_BUCKET_SETTING_KEY),
  ]);
  return parseRuntimeStorageBucketConfig(systemAssets, generations);
}

export async function getSiteBranding(): Promise<SiteBranding> {
  const logoUrl = await getSystemSettingString("SITE_LOGO_URL");
  return { logoUrl: resolveSiteLogoUrl(logoUrl) };
}

export async function getRuntimeSettingBoolean(
  key: SettingKey,
  fallback = false
) {
  const value = await getSystemSettingValue(key);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string" && value.trim()) {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }

  const envValue = getRuntimeEnvironmentFallback(key);
  if (!envValue) return fallback;
  return ["1", "true", "yes", "on"].includes(envValue.toLowerCase());
}

export async function getRuntimeSettingNumber(
  key: SettingKey,
  fallback: number,
  options?: { positive?: boolean; nonNegative?: boolean }
) {
  const isAllowedNumber = (candidate: number) => {
    if (!Number.isFinite(candidate)) return false;
    if (options?.positive) return candidate > 0;
    if (options?.nonNegative) return candidate >= 0;
    return true;
  };
  const value = await getSystemSettingValue(key);
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (isAllowedNumber(numericValue)) {
    return numericValue;
  }

  const envRawValue = getRuntimeEnvironmentFallback(key);
  if (envRawValue) {
    const envValue = Number(envRawValue);
    if (isAllowedNumber(envValue)) {
      return envValue;
    }
  }

  return fallback;
}

export async function getRuntimeSettingSelect<T extends string>(
  key: SettingKey,
  allowed: readonly T[],
  fallback: T
) {
  const value = await getRuntimeSettingString(key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function getProcessSettingString(key: SettingKey) {
  return process.env[resolveCanonicalSettingKey(key)]?.trim() || undefined;
}

export function getProcessSettingBoolean(key: SettingKey, fallback = false) {
  const value = process.env[resolveCanonicalSettingKey(key)];
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function getProcessSettingNumber(key: SettingKey, fallback: number) {
  const value = Number(process.env[resolveCanonicalSettingKey(key)]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseCustomVideoBillingModels(
  marketplaceValue: unknown
): VideoBillingModelPricingDescriptor[] {
  return parseModelMarketplaceConfig(marketplaceValue)
    .customModels.filter((model) => model.category === "video")
    .map((model) => ({
      modelId: model.modelId,
      supportedResolutions: model.supportedResolutions,
    }));
}

export async function getRuntimeVideoModelBillingSettings(): Promise<VideoModelBillingSettings> {
  const [marketplace, billingModes, creditsPerSecond, creditsPerItem] =
    await Promise.all([
      getRuntimeSettingJson("MODEL_MARKETPLACE_CONFIG"),
      getRuntimeSettingJson("VIDEO_MODEL_BILLING_MODES"),
      getRuntimeSettingJson("VIDEO_MODEL_CREDITS_PER_SECOND"),
      getRuntimeSettingJson("VIDEO_MODEL_CREDITS_PER_ITEM"),
    ]);
  return normalizeVideoModelBillingSettings({
    billingModes,
    creditsPerSecond,
    creditsPerItem,
    customModels: parseCustomVideoBillingModels(marketplace),
  });
}

/** Go reads are uncached at this adapter; retained for callers resetting request state. */
export function clearSystemSettingsCache() {}
export async function getSystemSettingValue(key: SettingKey): Promise<unknown | undefined> {
  const result=await requestGoBackendInternalJson<{value:unknown}>(`/api/system-settings/value?key=${encodeURIComponent(resolveCanonicalSettingKey(key))}`);
  return result.value ?? undefined;
}
export async function setSiteLogoUrl(logoUrl: string|null, _updatedBy: string): Promise<SiteBranding> {
  return requestGoBackendJson('/api/system-settings/site-logo',{method:'PUT',body:JSON.stringify({logoUrl})});
}
export async function importSystemSettingsFromEnv(options?: {updatedBy?: string;overwrite?: boolean}) {
  const result=await requestGoBackendJson<{importedKeys:SettingKey[]}>('/api/system-settings/import-env',{method:'POST',body:JSON.stringify({overwrite:options?.overwrite})});
  return result.importedKeys;
}
export async function initializeMissingSystemSettingsDefaults(_options?: {updatedBy?: string}) {
  const result=await requestGoBackendInternalJson<{initializedKeys:SettingKey[]}>('/api/system-settings/initialize-defaults',{method:'POST',body:'{}'});
  return result.initializedKeys;
}
export async function importMissingSystemSettingsFromEnv(_updatedBy?: string) {
  const result=await requestGoBackendInternalJson<{importedKeys:SettingKey[]}>('/api/system-settings/bootstrap');
  return result.importedKeys;
}
export async function getAuthoritativeVideoModelBillingSettings(): Promise<VideoModelBillingSettings> {
  return getRuntimeVideoModelBillingSettings();
}
export async function setSystemSettings(entries: Array<{key:string;value:unknown;clear?:boolean}>, _updatedBy:string) {
  const result=await requestGoBackendJson<{changedKeys:SettingKey[]}>('/api/system-settings',{method:'PUT',body:JSON.stringify({settings:entries})});
  return result.changedKeys;
}
export async function getAdminSystemSettingsSnapshot() {
  const result=await requestGoBackendJson<{settings:Array<SettingDefinition & {value:string;configured:boolean;stored:boolean;fromEnv:boolean;updatedAt:string|null}>}>('/api/system-settings');
  return result.settings;
}
