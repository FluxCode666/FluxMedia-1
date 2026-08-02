/**
 * API 上游 Worker 最终 runner 镜像的容器 smoke。
 *
 * 使用方：CI 在已加载临时镜像后调用。先以镜像默认非 root 用户导入
 * 生产迁移预检并执行真实 QuickJS 作业，再启动最终 CMD 并验证 SIGTERM
 * 可在 Compose 同等的 30 秒宽限内结束进程。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DOCKER_COMMAND_TIMEOUT_MS = 60_000;

/** 只暴露稳定代码的容器 smoke 错误。 */
class ApiUpstreamContainerSmokeError extends Error {
  /** @param {string} code 供 CI 分类的稳定错误码。 */
  constructor(code) {
    super("API 上游 Worker 容器 smoke 失败");
    this.name = "ApiUpstreamContainerSmokeError";
    this.code = code;
  }
}

/**
 * 向 stdout 写入单行脱敏 JSON 事件。
 *
 * @param {string} event 稳定事件名。
 * @param {Record<string, unknown>} data 可安全采集的容器维度。
 * @returns {void} 无返回值。
 * @sideEffects 向标准输出写入一行。
 */
function writeEvent(event, data = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
}

/**
 * 以参数数组执行 Docker CLI，禁止 shell 解析并限制输出大小。
 *
 * @param {string[]} argumentsList Docker 参数。
 * @param {{ allowFailure?: boolean }} [options] 清理路径可忽略非零退出。
 * @returns {Promise<{ stdout: string, exitCode: number }>} 受限制的命令结果。
 */
async function runDocker(argumentsList, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", argumentsList, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let outputBytes = 0;
    let overflowed = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ApiUpstreamContainerSmokeError("docker_command_timeout"));
    }, DOCKER_COMMAND_TIMEOUT_MS);
    const collect = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        overflowed = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        overflowed = true;
        child.kill("SIGKILL");
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new ApiUpstreamContainerSmokeError("docker_unavailable"));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (overflowed) {
        reject(new ApiUpstreamContainerSmokeError("docker_output_too_large"));
        return;
      }
      const normalizedExitCode = exitCode ?? 1;
      if (normalizedExitCode !== 0 && !options.allowFailure) {
        reject(new ApiUpstreamContainerSmokeError("docker_command_failed"));
        return;
      }
      resolve({ stdout, exitCode: normalizedExitCode });
    });
  });
}

/**
 * 验证容器内真实 Worker 作业的结构化成功事件。
 *
 * @param {string} output 受限制的容器 stdout。
 * @returns {void} 事件和非 root 维度正确时无返回值。
 * @throws {ApiUpstreamContainerSmokeError} 输出非 JSON、事件错误或容器为 root 时拒绝。
 */
function assertWorkerSmokeOutput(output) {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let lastEvent;
  try {
    lastEvent = JSON.parse(lines.at(-1) ?? "null");
  } catch {
    throw new ApiUpstreamContainerSmokeError("worker_smoke_output_invalid");
  }
  if (
    !lastEvent ||
    typeof lastEvent !== "object" ||
    lastEvent.event !== "api_upstream_worker_smoke_passed" ||
    lastEvent.uid === 0
  ) {
    throw new ApiUpstreamContainerSmokeError("worker_smoke_output_invalid");
  }
}

/**
 * 运行完整镜像 smoke，并在所有失败路径删除临时容器。
 *
 * @param {string} image 已由 Docker build 加载的本地镜像引用。
 * @returns {Promise<void>} Worker 与最终 CMD 均通过时完成。
 */
export async function runApiUpstreamContainerSmoke(image) {
  if (
    typeof image !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(image)
  ) {
    throw new ApiUpstreamContainerSmokeError("image_reference_invalid");
  }

  // 只导入模块，不执行数据库预检。这里验证预检脚本及其 pg、QuickJS
  // 依赖在最终 standalone 镜像中确实可由 Node 解析。
  await runDocker([
    "run",
    "--rm",
    "--init",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "--eval",
    "await import('./apps/web/scripts/preflight-api-upstream-adapter-migration.mjs')",
  ]);

  const workerResult = await runDocker([
    "run",
    "--rm",
    "--init",
    "--entrypoint",
    "node",
    "--env",
    "API_UPSTREAM_SCRIPT_WORKER_COUNT=1",
    "--env",
    "API_UPSTREAM_SCRIPT_MEMORY_LIMIT_MB=32",
    "--env",
    "API_UPSTREAM_SCRIPT_STACK_LIMIT_KB=512",
    image,
    "apps/web/scripts/smoke-api-upstream-worker.mjs",
    "--require-non-root",
  ]);
  assertWorkerSmokeOutput(workerResult.stdout);

  const containerName = `fluxmedia-api-adapter-smoke-${randomUUID().slice(0, 8)}`;
  try {
    await runDocker([
      "run",
      "--detach",
      "--init",
      "--name",
      containerName,
      "--env",
      "DATABASE_URL=postgresql://smoke:smoke@127.0.0.1:1/smoke",
      "--env",
      "BETTER_AUTH_SECRET=container-smoke-secret-not-for-production",
      "--env",
      "BETTER_AUTH_URL=http://127.0.0.1:3000",
      "--env",
      "NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000",
      "--env",
      "API_UPSTREAM_SCRIPT_WORKER_COUNT=1",
      "--env",
      "API_UPSTREAM_SCRIPT_MEMORY_LIMIT_MB=32",
      "--env",
      "API_UPSTREAM_SCRIPT_STACK_LIMIT_KB=512",
      image,
    ]);
    const running = await runDocker([
      "inspect",
      "--format",
      "{{.State.Running}}",
      containerName,
    ]);
    if (running.stdout.trim() !== "true") {
      throw new ApiUpstreamContainerSmokeError("runner_cmd_not_running");
    }
    await runDocker(["stop", "--time", "30", containerName]);
    const stopped = await runDocker([
      "inspect",
      "--format",
      "{{.State.Running}}",
      containerName,
    ]);
    if (stopped.stdout.trim() !== "false") {
      throw new ApiUpstreamContainerSmokeError("runner_cmd_did_not_stop");
    }
  } finally {
    await runDocker(["rm", "--force", containerName], {
      allowFailure: true,
    }).catch(() => undefined);
  }
}

/**
 * 执行命令行容器 smoke。
 *
 * @returns {Promise<void>} 临时容器已清理且结果已输出时完成。
 * @sideEffects 只接受一个镜像引用，调用 Docker CLI 并输出稳定 JSON。
 * @failure Docker 或契约失败时设置非零退出码。
 */
async function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList[0] === "--") argumentsList.shift();
  const [image, ...extraArguments] = argumentsList;
  if (!image || extraArguments.length > 0) {
    writeEvent("api_upstream_container_smoke_failed", {
      code: "invalid_arguments",
    });
    process.exitCode = 1;
    return;
  }
  try {
    await runApiUpstreamContainerSmoke(image);
    writeEvent("api_upstream_container_smoke_passed", {
      workerCountPerNodeProcess: 1,
    });
  } catch (error) {
    writeEvent("api_upstream_container_smoke_failed", {
      code:
        error instanceof ApiUpstreamContainerSmokeError
          ? error.code
          : "unexpected_container_failure",
    });
    process.exitCode = 1;
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
