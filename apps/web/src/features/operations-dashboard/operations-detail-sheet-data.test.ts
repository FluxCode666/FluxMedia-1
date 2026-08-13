/**
 * 运营总览明细 Sheet 展示模型测试。
 *
 * 使用方：Vitest。锁定增长、Cohort、商业化和内容明细的列、格式化与敏感字段拒绝，
 * 使客户端表格只消费服务端约定的安全记录。
 */
import { describe, expect, it } from "vitest";

import {
  buildOperationsDetailTableModel,
  parseOperationsDetailPage,
} from "./operations-detail-sheet-data";

const range = {
  from: "2026-08-01",
  to: "2026-08-07",
  timeZone: "Asia/Shanghai",
};

describe("operations detail sheet data", () => {
  it("把增长用户明细格式化为包含完整邮箱的管理员核对表", () => {
    const page = parseOperationsDetailPage(
      {
        selection: { module: "growth", detail: "users" },
        range,
        rows: [
          {
            userId: "user-1",
            name: "测试用户",
            email: "user@example.com",
            role: "user",
            banned: false,
            businessTime: "2026-08-02T04:30:00.000Z",
            retained: null,
          },
        ],
        nextCursor: "next-page",
      },
      { module: "growth", detail: "users" }
    );
    const model = buildOperationsDetailTableModel(page, "zh-CN");

    expect(model.title).toBe("新增用户明细");
    expect(model.columns.map((column) => column.label)).toEqual([
      "用户",
      "完整邮箱",
      "角色",
      "账号状态",
      "业务时间",
    ]);
    expect(model.rows[0]?.cells).toEqual([
      "测试用户\nuser-1",
      "user@example.com",
      "普通用户",
      "正常",
      "2026年8月2日 12:30",
    ]);
    expect(page.nextCursor).toBe("next-page");
  });

  it("Cohort 明细明确区分留存与未留存", () => {
    const page = parseOperationsDetailPage(
      {
        selection: {
          module: "growth",
          detail: "retention_cohorts",
          cohortDate: "2026-08-01",
          retentionDay: 7,
        },
        range,
        rows: [
          {
            userId: "user-1",
            name: "留存用户",
            email: "retained@example.com",
            role: "user",
            banned: false,
            businessTime: "2026-08-01T00:00:00.000Z",
            retained: true,
          },
          {
            userId: "user-2",
            name: "未留存用户",
            email: "lost@example.com",
            role: "user",
            banned: false,
            businessTime: "2026-08-01T01:00:00.000Z",
            retained: false,
          },
        ],
        nextCursor: null,
      },
      {
        module: "growth",
        detail: "retention_cohorts",
        cohortDate: "2026-08-01",
        retentionDay: 7,
      }
    );
    const model = buildOperationsDetailTableModel(page, "zh-CN");

    expect(model.title).toBe("2026-08-01 Cohort D7 明细");
    expect(model.columns.map((column) => column.label)).toContain("D7 留存");
    expect(model.rows.map((row) => row.cells.at(-1))).toEqual([
      "已留存",
      "未留存",
    ]);
  });

  it("商业化明细显示可核对金额和支付事件但不需要 provider payload", () => {
    const page = parseOperationsDetailPage(
      {
        selection: {
          module: "commercialization",
          detail: "payment_lifecycle",
        },
        range,
        rows: [
          {
            paymentOrderId: "order-1",
            providerTradeNo: "trade-1",
            userId: "user-1",
            currency: "CNY",
            amountMinor: 1_200,
            orderStatus: "fulfilled",
            createdAt: "2026-08-02T01:00:00.000Z",
            fulfilledAt: "2026-08-02T02:00:00.000Z",
            businessTime: "2026-08-02T02:00:00.000Z",
            eventType: "fulfillment_succeeded",
          },
        ],
        nextCursor: null,
      },
      { module: "commercialization", detail: "payment_lifecycle" }
    );
    const model = buildOperationsDetailTableModel(page, "zh-CN");

    expect(model.title).toBe("支付生命周期明细");
    expect(model.rows[0]?.cells).toContain("¥12.00");
    expect(model.rows[0]?.cells).toContain("履约成功");
    expect(model.rows[0]?.cells).toContain("trade-1");
  });

  it("内容明细按成功产物展示数量、秒数与净积分", () => {
    const page = parseOperationsDetailPage(
      {
        selection: { module: "content", detail: "video_outputs" },
        range,
        rows: [
          {
            taskId: "video-1",
            userId: "user-1",
            model: "video-model",
            mediaType: "video",
            businessTime: "2026-08-02T02:00:00.000Z",
            status: "completed",
            quantity: 1,
            videoSeconds: 8,
            netCredits: 12.25,
          },
        ],
        nextCursor: null,
      },
      { module: "content", detail: "video_outputs" }
    );
    const model = buildOperationsDetailTableModel(page, "zh-CN");

    expect(model.title).toBe("视频明细");
    expect(model.rows[0]?.cells).toEqual([
      "video-1",
      "user-1",
      "video-model",
      "视频",
      "1",
      "8 秒",
      "12.25",
      "2026年8月2日 10:00",
    ]);
  });

  it("拒绝选择不一致、非法字段和可能泄露内容的记录", () => {
    expect(() =>
      parseOperationsDetailPage(
        {
          selection: { module: "growth", detail: "users" },
          range,
          rows: [],
          nextCursor: null,
        },
        { module: "content", detail: "image_outputs" }
      )
    ).toThrow("运营明细选择不一致");

    expect(() =>
      parseOperationsDetailPage(
        {
          selection: { module: "content", detail: "image_outputs" },
          range,
          rows: [
            {
              taskId: "image-1",
              userId: "user-1",
              model: "image-model",
              mediaType: "image",
              businessTime: "2026-08-02T02:00:00.000Z",
              status: "completed",
              quantity: 2,
              videoSeconds: 0,
              netCredits: 4,
              prompt: "不应进入明细",
            },
          ],
          nextCursor: null,
        },
        { module: "content", detail: "image_outputs" }
      )
    ).toThrow("运营明细记录无效");
  });
});
