import { getRuntimeSettingJson } from "../system-settings";
import {
  CREDIT_PACKAGES,
  type CreditPackage,
  ENTERPRISE_RESOURCE_PACKAGE_DEFAULT_CREDITS,
  ENTERPRISE_RESOURCE_PACKAGE_DEFAULT_PRICE,
  ENTERPRISE_RESOURCE_PACKAGE_ID,
  isCreditPackageVisible,
  PAY_AS_YOU_GO_PACKAGE_ID,
} from "./config";

export const CREDIT_PACKAGE_MATRIX_SETTING_KEY = "CREDIT_PACKAGE_MATRIX";

export type RuntimeCreditPackage = Omit<CreditPackage, "credits" | "price"> & {
  credits: number;
  price: number;
};

const PAY_AS_YOU_GO_DEFAULT_PRICE = 20;
const MAX_CREDIT_PACKAGE_CREDITS = 100_000_000;
const MAX_CREDIT_PACKAGE_PRICE = 1_000_000;
const MAX_CREDIT_PACKAGE_QUANTITY = 999;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parsePositiveNumber(value: unknown, fallback: number, max?: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max ?? Number.MAX_SAFE_INTEGER, numeric);
}

function parsePositiveInteger(value: unknown, fallback: number, max?: number) {
  return Math.floor(parsePositiveNumber(value, fallback, max));
}

function normalizeCurrency(value: unknown, fallback = "CNY") {
  const currency =
    typeof value === "string" && value.trim()
      ? value.trim().toUpperCase()
      : fallback;
  return /^[A-Z]{3}$/.test(currency) ? currency : fallback;
}

function normalizeCreditPackage(
  raw: unknown,
  fallback?: RuntimeCreditPackage
): RuntimeCreditPackage | null {
  if (!isRecord(raw)) return fallback ?? null;
  const id =
    typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : fallback?.id;
  if (!id) return null;

  const name =
    typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim()
      : fallback?.name || id;
  const description =
    typeof raw.description === "string"
      ? raw.description
      : fallback?.description || "";
  const maxQuantity = parsePositiveInteger(
    raw.maxQuantity,
    fallback?.maxQuantity ?? 1,
    MAX_CREDIT_PACKAGE_QUANTITY
  );

  const normalized: RuntimeCreditPackage = {
    ...(fallback ?? {}),
    id,
    name,
    description,
    currency: normalizeCurrency(raw.currency, fallback?.currency ?? "CNY"),
    credits: parsePositiveInteger(
      raw.credits,
      fallback?.credits ?? 1,
      MAX_CREDIT_PACKAGE_CREDITS
    ),
    price: parsePositiveNumber(
      raw.price,
      fallback?.price ?? 1,
      MAX_CREDIT_PACKAGE_PRICE
    ),
    maxQuantity,
  };
  const popular =
    typeof raw.popular === "boolean" ? raw.popular : fallback?.popular;
  const visible =
    typeof raw.visible === "boolean" ? raw.visible : fallback?.visible;
  const allowQuantity =
    typeof raw.allowQuantity === "boolean"
      ? raw.allowQuantity
      : fallback?.allowQuantity;
  const creemProductId =
    typeof raw.creemProductId === "string" && raw.creemProductId.trim()
      ? raw.creemProductId.trim()
      : fallback?.creemProductId;

  if (popular !== undefined) normalized.popular = popular;
  if (visible !== undefined) normalized.visible = visible;
  if (allowQuantity !== undefined) normalized.allowQuantity = allowQuantity;
  if (creemProductId !== undefined) normalized.creemProductId = creemProductId;

  return normalized;
}

function packageRank(pkg: RuntimeCreditPackage) {
  if (pkg.id === PAY_AS_YOU_GO_PACKAGE_ID) return 0;
  if (pkg.id === ENTERPRISE_RESOURCE_PACKAGE_ID) return 1;
  return 2;
}

function sortCreditPackages(packages: RuntimeCreditPackage[]) {
  return [...packages].sort((a, b) => {
    const rankDelta = packageRank(a) - packageRank(b);
    if (rankDelta !== 0) return rankDelta;
    return a.id.localeCompare(b.id);
  });
}

export async function getRuntimeCreditPackages(options?: {
  includeHidden?: boolean;
}) {
  const payAsYouGoCredits = 5000;
  const payAsYouGoPrice = PAY_AS_YOU_GO_DEFAULT_PRICE;

  const fallbackPackages = CREDIT_PACKAGES.map((pkg) => {
    if (pkg.id === PAY_AS_YOU_GO_PACKAGE_ID) {
      return {
        ...pkg,
        credits: payAsYouGoCredits,
        price: payAsYouGoPrice,
      };
    }

    if (pkg.id === ENTERPRISE_RESOURCE_PACKAGE_ID) {
      return {
        ...pkg,
        credits: ENTERPRISE_RESOURCE_PACKAGE_DEFAULT_CREDITS,
        price: ENTERPRISE_RESOURCE_PACKAGE_DEFAULT_PRICE,
      };
    }

    return pkg;
  }) as RuntimeCreditPackage[];
  const fallbackById = new Map(fallbackPackages.map((pkg) => [pkg.id, pkg]));

  const configured = await getRuntimeSettingJson(
    CREDIT_PACKAGE_MATRIX_SETTING_KEY
  );
  const packagesValue = isRecord(configured) ? configured.packages : configured;
  let packages = fallbackPackages;
  if (Array.isArray(packagesValue)) {
    const configuredPackages = packagesValue
      .map((raw) => {
        const id = isRecord(raw) && typeof raw.id === "string" ? raw.id : "";
        return normalizeCreditPackage(raw, fallbackById.get(id));
      })
      .filter((pkg): pkg is RuntimeCreditPackage => Boolean(pkg));
    if (configuredPackages.length > 0) {
      packages = sortCreditPackages(configuredPackages);
    }
  }

  if (options?.includeHidden) {
    return packages;
  }

  return packages.filter((pkg) => isCreditPackageVisible(pkg));
}

export async function getRuntimeCreditPackageById(
  packageId: string,
  options?: { includeHidden?: boolean }
) {
  const packages = await getRuntimeCreditPackages(options);
  return packages.find((pkg) => pkg.id === packageId);
}

export function getCreditPackagePrice(pkg: RuntimeCreditPackage) {
  return pkg.price;
}

/** 返回积分包的 ISO 4217 结账币种；历史配置未写 currency 时兼容人民币。 */
export function getCreditPackageCurrency(pkg: RuntimeCreditPackage) {
  return normalizeCurrency(pkg.currency, "CNY");
}

export function getCreditPackageCreemProductId(pkg: RuntimeCreditPackage) {
  return pkg.creemProductId || `credits_${pkg.id}`;
}
