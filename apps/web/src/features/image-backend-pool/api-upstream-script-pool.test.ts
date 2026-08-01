/**
 * API 上游脚本 Worker Pool 测试。
 *
 * 职责：锁定进程单例初始化、未来响应许可、高优先级调度、脱敏诊断和显式关闭
 * 生命周期；测试只执行本地 QuickJS，不访问网络或账号配置。
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  ensureApiUpstreamScriptPool,
  shutdownApiUpstreamScriptPool,
} from "./api-upstream-script-pool";

describe("API upstream script worker pool", () => {
  afterAll(async () => {
    await shutdownApiUpstreamScriptPool();
  });

  it("并发初始化只建立并返回一个进程 Pool", async () => {
    const [first, second, third] = await Promise.all([
      ensureApiUpstreamScriptPool(),
      ensureApiUpstreamScriptPool(),
      ensureApiUpstreamScriptPool(),
    ]);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first.diagnostics()).toMatchObject({
      state: "ready",
      configuredWorkers: 1,
      readyWorkers: 1,
      responsePermitCapacity: 16,
    });
  });

  it("响应许可不绑定 Worker，结算后恰好释放一次", async () => {
    const pool = await ensureApiUpstreamScriptPool();
    const permit = await pool.reserveResponsePermit();
    expect(pool.diagnostics().activeResponsePermits).toBe(1);

    await expect(
      permit.run({
        kind: "execute",
        script: "response.ok = true; return response;",
        inputJson: "{}",
        contextJson: "{}",
        operation: "videos.generate",
      })
    ).resolves.toBe('{"ok":true}');
    expect(pool.diagnostics().activeResponsePermits).toBe(0);

    permit.release();
    expect(pool.diagnostics().activeResponsePermits).toBe(0);
  });

  it("真实响应越过已排队的低优先级管理作业", async () => {
    const pool = await ensureApiUpstreamScriptPool();
    const completionOrder: string[] = [];
    const active = pool
      .run({
        kind: "execute",
        script: "while (true) {}",
        inputJson: "{}",
        contextJson: "{}",
        priority: "admin",
        operation: "images.generate",
        stage: "request",
      })
      .catch(() => undefined);
    const queued = pool
      .run({
        kind: "execute",
        script: "return input;",
        inputJson: "{}",
        contextJson: "{}",
        priority: "admin",
        operation: "images.generate",
        stage: "request",
      })
      .then(() => {
        completionOrder.push("admin");
      });
    const permit = await pool.reserveResponsePermit();
    const response = permit
      .run({
        kind: "execute",
        script: "return response;",
        inputJson: "{}",
        contextJson: "{}",
        operation: "images.generate",
      })
      .then(() => {
        completionOrder.push("response");
      });

    await Promise.all([active, queued, response]);
    expect(completionOrder).toEqual(["response", "admin"]);
  });

  it("诊断快照只包含容量与状态计数", async () => {
    const pool = await ensureApiUpstreamScriptPool();
    expect(Object.keys(pool.diagnostics()).sort()).toEqual(
      [
        "activeResponsePermits",
        "busyWorkers",
        "configuredWorkers",
        "queuedBytes",
        "queuedRequests",
        "queuedResponses",
        "readyWorkers",
        "responsePermitCapacity",
        "state",
      ].sort()
    );
  });
});
