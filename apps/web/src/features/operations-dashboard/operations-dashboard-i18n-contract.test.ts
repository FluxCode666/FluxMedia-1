/**
 * 运营总览中英文消息和动态枚举契约测试。
 *
 * 使用方：apps/web Vitest。保证两个 locale 的 OperationsDashboard 键树完全一致、
 * 叶子均为非空字符串，并覆盖组件按领域契约动态拼接的所有键。
 */

import {
  operationsExportStatusSchema,
  operationsExportTypeSchema,
  operationsGranularitySchema,
  operationsSpecialStatusSchema,
} from "@repo/shared/operations-dashboard/contracts";
import { describe, expect, it } from "vitest";

import enMessages from "../../../messages/en.json";
import zhMessages from "../../../messages/zh.json";

/** 递归收集点分叶子路径；数组不属于运营总览消息契约。 */
function collectLeafPaths(
  value: unknown,
  prefix = ""
): Array<{ path: string; value: unknown }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [{ path: prefix, value }];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    collectLeafPaths(child, prefix ? `${prefix}.${key}` : key)
  );
}

/** 从未知消息对象安全读取点分路径；缺失路径返回 undefined。 */
function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

describe("OperationsDashboard i18n contract", () => {
  it("中英文键结构一致且所有叶子都是非空字符串", () => {
    const enLeaves = collectLeafPaths(enMessages.OperationsDashboard);
    const zhLeaves = collectLeafPaths(zhMessages.OperationsDashboard);

    expect(enLeaves.map((leaf) => leaf.path).sort()).toEqual(
      zhLeaves.map((leaf) => leaf.path).sort()
    );
    for (const leaf of [...enLeaves, ...zhLeaves]) {
      expect(typeof leaf.value, leaf.path).toBe("string");
      expect(String(leaf.value).trim().length, leaf.path).toBeGreaterThan(0);
    }
  });

  it("覆盖粒度、快捷范围、状态、导出类型和导出状态动态键", () => {
    const dynamicPaths = [
      ...operationsGranularitySchema.options.map(
        (value) => `filter.granularity.${value}`
      ),
      ...["this_week", "this_month", "this_year"].map(
        (value) => `filter.preset.${value}`
      ),
      ...operationsSpecialStatusSchema.options.map(
        (value) => `status.${value}`
      ),
      ...operationsExportTypeSchema.options.map(
        (value) => `exports.types.${value}`
      ),
      ...operationsExportStatusSchema.options.map(
        (value) => `exports.status.${value}`
      ),
    ];

    for (const path of dynamicPaths) {
      expect(readPath(enMessages.OperationsDashboard, path), path).toEqual(
        expect.any(String)
      );
      expect(readPath(zhMessages.OperationsDashboard, path), path).toEqual(
        expect.any(String)
      );
    }
  });

  it("覆盖详情角色、订单状态和支付事件动态键", () => {
    const detailPaths = [
      ...["user", "observer_admin", "admin", "super_admin"].map(
        (value) => `detail.roles.${value}`
      ),
      ...["pending", "paid", "fulfilled", "failed", "expired"].map(
        (value) => `detail.orderStatus.${value}`
      ),
      ...[
        "order_created",
        "checkout_ready",
        "payment_confirmed",
        "fulfillment_succeeded",
        "checkout_failed",
        "fulfillment_attempt_failed",
        "fulfillment_failed_terminal",
        "expired",
      ].map((value) => `detail.paymentEvent.${value}`),
    ];

    for (const path of detailPaths) {
      expect(readPath(enMessages.OperationsDashboard, path), path).toEqual(
        expect.any(String)
      );
      expect(readPath(zhMessages.OperationsDashboard, path), path).toEqual(
        expect.any(String)
      );
    }
  });
});
