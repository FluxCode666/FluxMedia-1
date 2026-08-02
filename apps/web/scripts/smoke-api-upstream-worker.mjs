/**
 * API 上游 QuickJS Worker 的 Node 22/standalone 运行 smoke。
 *
 * 使用方：本地构建门、CI 与最终 runner 容器。脚本执行一次真实
 * QuickJS 作业后终止 Worker，不访问数据库、上游网络或凭据。
 */
import { pathToFileURL } from "node:url";

import {
  ApiUpstreamWorkerProbe,
  ApiUpstreamWorkerProbeError,
  parseApiUpstreamProbeRuntimeConfig,
} from "./api-upstream-worker-probe.mjs";

/**
 * 向 stdout 写入无供应商正文的单行 JSON 事件。
 *
 * @param {string} event 稳定事件名。
 * @param {Record<string, unknown>} data 脱敏运行维度。
 * @returns {void} 无返回值。
 * @sideEffects 向标准输出写入一行。
 */
function writeEvent(event, data = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
}

/**
 * 执行真实 Worker 作业并验证受限同步 JavaScript 语义。
 *
 * @param {{ requireNonRoot?: boolean }} options 容器中可强制非 root 用户。
 * @returns {Promise<Record<string, unknown>>} 可安全写入日志的运行摘要。
 */
export async function runApiUpstreamWorkerSmoke(options = {}) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (options.requireNonRoot && (uid === null || uid === 0)) {
    throw new ApiUpstreamWorkerProbeError("worker_job_failed");
  }
  const runtimeConfig = parseApiUpstreamProbeRuntimeConfig();
  const probe = new ApiUpstreamWorkerProbe();
  try {
    const result = await probe.execute(
      `
const twice = (value) => value * 2;
return {
  body: {
    count: twice(request.count),
    operation: context.operation,
  },
};
`,
      { count: 21 },
      {
        operation: "images.generate",
        stage: "request",
        contentType: "application/json",
        platformModelId: "deployment-smoke",
        upstreamModelId: "deployment-smoke",
      }
    );
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !result.body ||
      typeof result.body !== "object" ||
      result.body.count !== 42 ||
      result.body.operation !== "images.generate"
    ) {
      throw new ApiUpstreamWorkerProbeError("worker_job_failed");
    }
    return {
      nodeMajor: Number(process.versions.node.split(".")[0]),
      uid,
      configuredWorkerCount: runtimeConfig.workerCount,
      memoryLimitMb: runtimeConfig.memoryLimitBytes / 1024 / 1024,
      stackLimitKb: runtimeConfig.stackLimitBytes / 1024,
    };
  } finally {
    await probe.close();
  }
}

/**
 * 执行命令行 Worker smoke。
 *
 * @returns {Promise<void>} Worker 已结束并输出结果时完成。
 * @sideEffects 成功与失败均只向 stdout 输出稳定、脱敏字段。
 * @failure 参数或 Worker 失败时设置非零退出码。
 */
async function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList[0] === "--") argumentsList.shift();
  if (
    argumentsList.some((argument) => argument !== "--require-non-root") ||
    argumentsList.filter((argument) => argument === "--require-non-root")
      .length > 1
  ) {
    writeEvent("api_upstream_worker_smoke_failed", {
      code: "invalid_arguments",
    });
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await runApiUpstreamWorkerSmoke({
      requireNonRoot: argumentsList.includes("--require-non-root"),
    });
    writeEvent("api_upstream_worker_smoke_passed", summary);
  } catch (error) {
    writeEvent("api_upstream_worker_smoke_failed", {
      code:
        error instanceof ApiUpstreamWorkerProbeError
          ? error.code
          : "unexpected_worker_failure",
    });
    process.exitCode = 1;
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
