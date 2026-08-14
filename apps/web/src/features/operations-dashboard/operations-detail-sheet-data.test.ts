/**
 * 运营总览明细 Sheet 展示模型测试。
 *
 * 使用方：Vitest。锁定增长、Cohort、商业化和内容明细的列、格式化与敏感字段拒绝，
 * 使客户端表格只消费服务端约定的安全记录。
 */
import { resolveOperationsDashboardRange } from "@repo/shared/operations-dashboard/range";
import { describe, expect, it } from "vitest";

import {
  buildOperationsDetailTableModel,
  type OperationsDetailTableLabels,
  parseOperationsDetailPage,
} from "./operations-detail-sheet-data";

const range = resolveOperationsDashboardRange(
  {
    granularity: "day",
    range: { kind: "custom", from: "2026-08-01", to: "2026-08-07" },
  },
  {
    timeZone: "Asia/Shanghai",
    asOf: new Date("2026-08-14T12:00:00.000Z"),
    epochDate: "2026-08-01",
  }
);

/** 固定中文文案，确保纯数据测试不依赖 next-intl 运行时。 */
const labels: OperationsDetailTableLabels = {
  selection: {
    cumulativeUsers: {
      title: "累计用户明细",
      description: "累计用户核对记录。",
    },
    users: { title: "新增用户明细", description: "新增用户核对记录。" },
    loginActivity: {
      title: "登录活跃明细",
      description: "登录活跃用户核对记录。",
    },
    creationActivity: {
      title: "创作活跃明细",
      description: "创作活跃用户核对记录。",
    },
    paymentActivity: {
      title: "付费活跃明细",
      description: "付费活跃用户核对记录。",
    },
    retentionCohorts: {
      title: "2026-08-01 Cohort D7 明细",
      description: "Cohort 留存核对记录。",
    },
    orders: { title: "订单明细", description: "订单核对记录。" },
    fulfilledOrders: {
      title: "已履约订单明细",
      description: "已履约订单核对记录。",
    },
    paymentLifecycle: {
      title: "支付生命周期明细",
      description: "支付事件核对记录。",
    },
    imageOutputs: {
      title: "生图明细",
      description: "成功生图核对记录。",
    },
    videoOutputs: {
      title: "视频明细",
      description: "成功视频核对记录。",
    },
    creditUsage: {
      title: "积分净用量明细",
      description: "积分净用量核对记录。",
    },
  },
  columns: {
    user: "用户",
    email: "完整邮箱",
    role: "角色",
    accountStatus: "账号状态",
    businessTime: "业务时间",
    retention: "D7 留存",
    order: "订单",
    tradeNumber: "交易号",
    userId: "用户 ID",
    amount: "金额",
    orderStatus: "订单状态",
    paymentEvent: "支付事件",
    createdAt: "创建时间",
    fulfilledAt: "履约时间",
    taskId: "任务 ID",
    model: "模型",
    media: "媒体类型",
    quantity: "数量",
    videoSeconds: "视频秒数",
    netCredits: "净积分",
  },
  values: {
    unnamedUser: "未命名用户",
    banned: "已封禁",
    normal: "正常",
    retained: "已留存",
    notRetained: "未留存",
    image: "图片",
    video: "视频",
    seconds: (value) => `${value} 秒`,
    emptyValue: "—",
  },
  roles: {
    user: "普通用户",
    observer_admin: "只读管理员",
    admin: "管理员",
    super_admin: "超级管理员",
  },
  orderStatus: {
    pending: "待支付",
    paid: "已支付",
    fulfilled: "履约成功",
    failed: "失败",
    expired: "已过期",
  },
  paymentEvent: {
    order_created: "订单创建",
    checkout_ready: "结账就绪",
    payment_confirmed: "支付确认",
    fulfillment_succeeded: "履约成功",
    checkout_failed: "结账失败",
    fulfillment_attempt_failed: "履约尝试失败",
    fulfillment_failed_terminal: "履约终止失败",
    expired: "已过期",
  },
};

/** 固定英文文案，确认英文页面不会回退到数据模块内的中文常量。 */
const enLabels: OperationsDetailTableLabels = {
  selection: {
    cumulativeUsers: {
      title: "Cumulative user details",
      description: "Cumulative user copy",
    },
    users: { title: "New user details", description: "New user copy" },
    loginActivity: {
      title: "Login-active user details",
      description: "Login copy",
    },
    creationActivity: {
      title: "Creation-active user details",
      description: "Creation copy",
    },
    paymentActivity: {
      title: "Paying user details",
      description: "Payment copy",
    },
    retentionCohorts: {
      title: "2026-08-01 cohort D7 details",
      description: "Retention copy",
    },
    orders: { title: "Order details", description: "Order copy" },
    fulfilledOrders: {
      title: "Fulfilled order details",
      description: "Fulfilled order copy",
    },
    paymentLifecycle: {
      title: "Payment lifecycle details",
      description: "Lifecycle copy",
    },
    imageOutputs: { title: "Image output details", description: "Image copy" },
    videoOutputs: { title: "Video output details", description: "Video copy" },
    creditUsage: {
      title: "Successful net credit usage details",
      description: "Credit copy",
    },
  },
  columns: {
    user: "User",
    email: "Full email",
    role: "Role",
    accountStatus: "Account status",
    businessTime: "Business time",
    retention: "D7 retained",
    order: "Platform order",
    tradeNumber: "Provider trade number",
    userId: "User ID",
    amount: "Amount",
    orderStatus: "Order status",
    paymentEvent: "Payment event",
    createdAt: "Created at",
    fulfilledAt: "Fulfilled at",
    taskId: "Task ID",
    model: "Model",
    media: "Media",
    quantity: "Quantity",
    videoSeconds: "Video seconds",
    netCredits: "Net credits",
  },
  values: {
    unnamedUser: "Unnamed user",
    banned: "Banned",
    normal: "Normal",
    retained: "Retained",
    notRetained: "Not retained",
    image: "Image",
    video: "Video",
    seconds: (value) => `${value} seconds`,
    emptyValue: "—",
  },
  roles: {
    user: "User",
    observer_admin: "Observer administrator",
    admin: "Administrator",
    super_admin: "Super administrator",
  },
  orderStatus: {
    pending: "Pending payment",
    paid: "Paid",
    fulfilled: "Fulfilled",
    failed: "Failed",
    expired: "Expired",
  },
  paymentEvent: {
    order_created: "Order created",
    checkout_ready: "Checkout ready",
    payment_confirmed: "Payment confirmed",
    fulfillment_succeeded: "Fulfillment succeeded",
    checkout_failed: "Checkout failed",
    fulfillment_attempt_failed: "Fulfillment attempt failed",
    fulfillment_failed_terminal: "Fulfillment failed terminally",
    expired: "Expired",
  },
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
    const model = buildOperationsDetailTableModel(page, "zh-CN", labels);

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
    const model = buildOperationsDetailTableModel(page, "zh-CN", labels);

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
    const model = buildOperationsDetailTableModel(page, "zh-CN", labels);

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
    const model = buildOperationsDetailTableModel(page, "zh-CN", labels);

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
    ).toThrow("运营明细响应无效");
  });

  it("英文展示模型不会混入中文角色、订单状态或支付事件文案", () => {
    const growthPage = parseOperationsDetailPage(
      {
        selection: { module: "growth", detail: "users" },
        range,
        rows: [
          {
            userId: "user-en",
            name: "English User",
            email: "english@example.com",
            role: "admin",
            banned: true,
            businessTime: "2026-08-02T04:30:00.000Z",
            retained: null,
          },
        ],
        nextCursor: null,
      },
      { module: "growth", detail: "users" }
    );
    const paymentPage = parseOperationsDetailPage(
      {
        selection: {
          module: "commercialization",
          detail: "payment_lifecycle",
        },
        range,
        rows: [
          {
            paymentOrderId: "order-en",
            providerTradeNo: null,
            userId: "user-en",
            currency: "USD",
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
    const output = JSON.stringify([
      buildOperationsDetailTableModel(growthPage, "en-US", enLabels),
      buildOperationsDetailTableModel(paymentPage, "en-US", enLabels),
    ]);

    expect(output).toContain("Administrator");
    expect(output).toContain("Banned");
    expect(output).toContain("Fulfilled");
    expect(output).toContain("Fulfillment succeeded");
    expect(output).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
