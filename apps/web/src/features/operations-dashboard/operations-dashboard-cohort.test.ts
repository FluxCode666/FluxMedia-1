/**
 * 运营总览 Cohort 明细可用性测试。
 *
 * 使用方：Vitest。锁定上线前与尚未成熟状态均不能触发记录级下钻，避免把不可用
 * 留存单元格误解释为真实零值。
 */
import { describe, expect, it } from "vitest";

import { canOpenOperationsCohortDetail } from "./operations-dashboard-cohort";

describe("operations dashboard cohort", () => {
  it("只允许真实值和无样本的已成熟 Cohort 下钻", () => {
    expect(canOpenOperationsCohortDetail({ status: "value" })).toBe(true);
    expect(canOpenOperationsCohortDetail({ status: "no_data" })).toBe(true);
    expect(canOpenOperationsCohortDetail({ status: "pre_epoch" })).toBe(false);
    expect(canOpenOperationsCohortDetail({ status: "immature" })).toBe(false);
  });
});
