/**
 * Creem 实付金额/币种反欺诈校验 -- 纯函数模块（DB-free，无副作用）
 *
 * 职责：将 Creem webhook 实付金额与服务端期望金额做比对，给出裁决结果。
 * 使用方：apps/web Creem webhook route、单元测试。
 * 关键依赖：无外部依赖（纯计算）。
 *
 * WHY 独立模块：route.ts 中内联纯函数无法被 vitest 单测（依赖 Next.js 运行时），
 * 抽离到此处后可直接 import 并覆盖全部分支。
 */

// ============================================
// 类型
// ============================================

/**
 * 实付金额/币种校验裁决结果。
 *
 * - comparable=false 表示输入缺失或无法解析（order 缺失、amount 非数字、期望价目不可用），
 *   调用方应放行 + 告警，绝不硬拒真实支付。
 * - comparable=true 时 matches 才有意义。
 */
export interface CreemAmountMatchResult {
  /** 是否具备可比条件（双方金额/币种均可用且合法） */
  comparable: boolean;
  /** 金额是否在容差范围内匹配（仅 comparable=true 时有意义） */
  matches: boolean;
  /** 服务端期望金额（最小货币单位） */
  expectedMinor: number;
  /** Creem 实付金额（最小货币单位） */
  actualMinor: number;
  /** 服务端期望币种（大写） */
  currency: string;
  /** Creem 实付币种（大写） */
  actualCurrency: string;
}

/**
 * shouldGrantAfterAmountCheck 的返回值。
 */
export interface CreemGrantDecision {
  /** 是否允许发放积分 */
  grant: boolean;
  /** 人类可读原因（用于日志，不含机密） */
  reason: string;
}

// ============================================
// 常量
// ============================================

/**
 * 实付金额比对容差（最小货币单位）。
 *
 * WHY：Creem 的 order.amount 以最小货币单位返回，服务端积分订单价目以主单位配置。
 * 换算后允许实付不低于期望、且不超出期望 + 容差，容忍上游四舍五入/手续费导致
 * 的轻微多付，避免误拒真实支付。
 */
export const CREEM_AMOUNT_TOLERANCE_MINOR_UNITS = 10;

/**
 * 零小数位币种（1 主单位 = 1 最小单位）。
 * 日元、韩元、越南盾等无"分"的概念。
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

/**
 * 三小数位币种（1 主单位 = 1000 最小单位）。
 * 巴林第纳尔、科威特第纳尔、阿曼里亚尔等。
 */
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "KWD", "OMR"]);

// ============================================
// 纯函数
// ============================================

/**
 * 将主单位金额转换为最小货币单位（分/钱/fils 等）。
 *
 * 规则：
 * - 零小数位币种（JPY, KRW 等）：乘数为 1（主单位即最小单位）
 * - 三小数位币种（BHD, KWD, OMR）：乘数为 1000
 * - 其他（USD, EUR, CNY 等）：乘数为 100
 *
 * 只接受有限非负数；非法输入（NaN、Infinity、负数）返回 NaN，
 * 交由调用方按"不可比"处理。四舍五入到整数，避免浮点误差
 * （如 0.1 * 100 = 10.000000000000002）造成的边界误判。
 *
 * @param amount - 主单位金额（元/美元/日元等）
 * @param currency - ISO 4217 币种代码（大小写不敏感）
 * @returns 最小货币单位金额，非法输入返回 NaN
 */
export function creemMajorToMinorUnits(
  amount: number,
  currency: string
): number {
  if (!Number.isFinite(amount) || amount < 0) {
    return Number.NaN;
  }

  const upper = currency.trim().toUpperCase();

  if (ZERO_DECIMAL_CURRENCIES.has(upper)) {
    return Math.round(amount);
  }

  if (THREE_DECIMAL_CURRENCIES.has(upper)) {
    return Math.round(amount * 1000);
  }

  // 默认 2 小数位
  return Math.round(amount * 100);
}

/**
 * 比对 Creem 实付金额/币种与服务端期望，给出裁决结果（纯逻辑，无副作用）。
 *
 * WHY：webhook 仅经签名校验无法防止 checkout 阶段被篡改的价格/数量套取高额积分订单，
 * 须在发放积分前用服务端积分订单价格重算期望金额并与 Creem 实付额比对。本函数只判定，
 * 不决定放行/拒付；信息不可比时返回 comparable=false 由调用方放行 + 告警。
 *
 * @param expected - 服务端期望（amount 为主单位，currency 为 ISO 4217）
 * @param actual - Creem 实付（amount 为最小货币单位，currency 为 ISO 4217）
 * @returns 裁决结果
 */
export function evaluateCreemAmountMatch(
  expected: { amount: number; currency: string },
  actual: { amount: number; currency: string }
): CreemAmountMatchResult {
  const expectedCurrency = expected.currency?.trim().toUpperCase() || "";
  const actualCurrency = actual.currency?.trim().toUpperCase() || "";

  const expectedMinor = creemMajorToMinorUnits(
    expected.amount,
    expected.currency
  );
  const actualMinor = actual.amount;

  // 期望金额无法换算（NaN）：不可比
  if (!Number.isFinite(expectedMinor)) {
    return {
      comparable: false,
      matches: false,
      expectedMinor: Number.NaN,
      actualMinor: Number.isFinite(actualMinor) ? actualMinor : Number.NaN,
      currency: expectedCurrency,
      actualCurrency,
    };
  }

  // 实付金额缺失或非法：不可比
  if (!Number.isFinite(actualMinor)) {
    return {
      comparable: false,
      matches: false,
      expectedMinor,
      actualMinor: Number.NaN,
      currency: expectedCurrency,
      actualCurrency,
    };
  }

  // 币种不匹配（双方均存在时才比对）：可比但不匹配
  if (expectedCurrency && actualCurrency) {
    if (expectedCurrency !== actualCurrency) {
      return {
        comparable: false,
        matches: false,
        expectedMinor,
        actualMinor,
        currency: expectedCurrency,
        actualCurrency,
      };
    }
  }

  // 金额比对：允许实付不低于期望、且不超出期望 + 容差。
  // 低于期望视为可能的低价套取；超出过多视为币种/单位不一致。
  const matches =
    actualMinor >= expectedMinor &&
    actualMinor <= expectedMinor + CREEM_AMOUNT_TOLERANCE_MINOR_UNITS;

  return {
    comparable: true,
    matches,
    expectedMinor,
    actualMinor,
    currency: expectedCurrency,
    actualCurrency: actualCurrency || expectedCurrency,
  };
}

/**
 * 对金额/币种裁决落地处置：决定是否发放积分。
 *
 * WHY 软门闩：
 * - comparable=false（信息缺失/价目未配置）一律放行 + 告警，避免误拒真实支付。
 * - comparable=true 且匹配 → 放行。
 * - comparable=true 且不匹配：
 *   - enforceReject=false → 放行 + 告警（软门闩，给运维核对窗口）。
 *   - enforceReject=true → 拒绝发放（硬拒，阻止低价/篡改套取）。
 *
 * @param match - evaluateCreemAmountMatch 的裁决结果
 * @param enforceReject - 是否开启硬拒模式（对应 env CREEM_WEBHOOK_ENFORCE_AMOUNT）
 * @returns 发放决策与原因
 */
export function shouldGrantAfterAmountCheck(
  match: CreemAmountMatchResult,
  enforceReject: boolean
): CreemGrantDecision {
  // 匹配：放行
  if (match.comparable && match.matches) {
    return {
      grant: true,
      reason: "amount-match",
    };
  }

  // 不可比（信息缺失/无法换算/币种不同无法对比）：一律放行 + 告警
  if (!match.comparable) {
    return {
      grant: true,
      reason: "not-comparable-grant-with-warning",
    };
  }

  // 可比但不匹配
  if (!enforceReject) {
    // 软门闩：照常发放并告警
    return {
      grant: true,
      reason: "mismatch-soft-gate-grant-with-warning",
    };
  }

  // 硬拒：已确认配置无误并开启强制校验
  return {
    grant: false,
    reason: "mismatch-enforced-reject",
  };
}
