/**
 * 视频 API 新旧地址兼容性端到端测试。
 *
 * 使用方：开发者或发布前检查。脚本使用同一个 client_request_id 调用四个创建地址，
 * 因而按服务端幂等契约只创建并计费一个任务；随后核对两种查询地址和四态响应。
 * 关键依赖：Node.js 22 原生 fetch、可访问的 FluxMedia 部署和具备视频权限的 API Key。
 */
import { randomUUID } from "node:crypto";

const PUBLIC_STATUSES = new Set([
  "queued",
  "in_progress",
  "completed",
  "failed",
]);
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

/**
 * 读取必填环境变量。
 *
 * @param {string} name 环境变量名称。
 * @returns {string} 去除首尾空白后的配置值。
 * @throws 未配置或只包含空白时终止测试，避免发出不完整请求。
 */
function readRequiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少必填环境变量 ${name}`);
  return value;
}

/**
 * 解析有界整数环境变量。
 *
 * @param {string} name 环境变量名称。
 * @param {number} fallback 未配置时的默认值。
 * @param {number} minimum 闭区间下界。
 * @param {number} maximum 闭区间上界。
 * @returns {number} 已校验的整数。
 * @throws 值不是十进制整数或越界时终止测试。
 */
function readBoundedInteger(name, fallback, minimum, maximum) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return fallback;
  if (!/^[0-9]+$/u.test(rawValue)) {
    throw new Error(`${name} 必须是十进制整数`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须在 ${minimum}-${maximum} 之间`);
  }
  return value;
}

/**
 * 解析可选布尔环境变量。
 *
 * @param {string} name 环境变量名称。
 * @param {boolean} fallback 未配置时的默认值。
 * @returns {boolean} 已校验的布尔值。
 * @throws 仅接受 true 或 false，防止误以为测试会等待终态。
 */
function readBoolean(name, fallback) {
  const rawValue = process.env[name]?.trim().toLowerCase();
  if (!rawValue) return fallback;
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  throw new Error(`${name} 只能是 true 或 false`);
}

/**
 * 把部署地址归一为无尾斜杠 URL。
 *
 * @param {string} value 用户提供的部署地址。
 * @returns {string} 可安全拼接 API 路径的绝对地址。
 * @throws 非 http/https 地址时拒绝，避免向意外协议发送凭据。
 */
function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("FLUXMEDIA_BASE_URL 只支持 http 或 https");
  }
  return url.toString().replace(/\/$/u, "");
}

/**
 * 向 stdout 输出单行结构化测试事件。
 *
 * @param {string} event 稳定事件名称。
 * @param {Record<string, unknown>} data 不含 API Key 的结果字段。
 * @returns {void} 无返回值。
 * @sideEffects 向标准输出写入一行 JSON。
 */
function writeEvent(event, data = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
}

/**
 * 读取 JSON 响应；非 JSON 正文只保留有界摘要。
 *
 * @param {Response} response fetch 响应。
 * @returns {Promise<unknown>} JSON 值或安全的正文摘要对象。
 * @sideEffects 消费一次响应正文。
 */
async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { nonJsonBody: text.slice(0, 500) };
  }
}

/**
 * 验证未知值是普通对象。
 *
 * @param {unknown} value 外部 API 返回值。
 * @returns {Record<string, unknown>} 可安全读取字段的对象。
 * @throws 数组、null 或标量响应不符合视频任务协议时终止测试。
 */
function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("API 响应不是 JSON 对象");
  }
  return value;
}

/**
 * 从视频任务对象提取并核对三个等价 ID。
 *
 * @param {Record<string, unknown>} payload 视频任务响应。
 * @returns {string} 持久视频任务 ID。
 * @throws ID 缺失或三个别名不一致时终止测试。
 */
function requireTaskId(payload) {
  const taskId = payload.task_id;
  if (typeof taskId !== "string" || !taskId) {
    throw new Error("响应缺少 task_id");
  }
  if (payload.id !== taskId || payload.generation_id !== taskId) {
    throw new Error("id、task_id 与 generation_id 不一致");
  }
  return taskId;
}

/**
 * 验证响应仅公开 OpenAI 四态。
 *
 * @param {Record<string, unknown>} payload 视频任务响应。
 * @returns {string} 当前公开状态。
 * @throws 状态缺失或仍返回旧状态时终止测试。
 */
function requirePublicStatus(payload) {
  const status = payload.status;
  if (typeof status !== "string" || !PUBLIC_STATUSES.has(status)) {
    throw new Error(`响应包含非法公开视频状态：${String(status)}`);
  }
  return status;
}

/**
 * 发出带 API Key 的 JSON 请求并验证 HTTP 状态。
 *
 * @param {{ baseUrl: string, apiKey: string, path: string, method: "GET" | "POST", body?: Record<string, unknown>, expectedStatus: number, requestTimeoutMs: number }} input
 *   请求参数；API Key 只进入 Authorization，不写入日志。
 * @returns {Promise<Record<string, unknown>>} 已验证为对象的响应。
 * @sideEffects 访问目标 FluxMedia 部署；POST 可能创建真实生成任务并产生费用。
 * @throws 网络、超时、非预期 HTTP 状态或非法 JSON 对象时失败。
 */
async function requestJson(input) {
  const response = await fetch(`${input.baseUrl}${input.path}`, {
    method: input.method,
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      ...(input.body ? { "Content-Type": "application/json" } : {}),
      "X-Request-Id": `video-api-compat-${randomUUID()}`,
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    signal: AbortSignal.timeout(input.requestTimeoutMs),
  });
  const responseBody = await readResponseBody(response);
  if (response.status !== input.expectedStatus) {
    throw new Error(
      `${input.method} ${input.path} 返回 HTTP ${response.status}：${JSON.stringify(responseBody)}`
    );
  }
  return requireObject(responseBody);
}

/**
 * 等待指定毫秒数。
 *
 * @param {number} milliseconds 等待时长。
 * @returns {Promise<void>} 计时器完成时兑现。
 * @sideEffects 暂停下一次轮询，不阻塞 Node.js 事件循环。
 */
async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * 执行四地址幂等创建、查询别名和可选终态轮询测试。
 *
 * @returns {Promise<void>} 全部断言通过时完成。
 * @sideEffects 创建一个真实视频任务、读取任务状态，并可能产生一次视频生成费用。
 * @throws 任一兼容地址、幂等 ID、公开状态或查询结果不符合契约时失败。
 */
async function main() {
  const baseUrl = normalizeBaseUrl(
    readRequiredEnvironment("FLUXMEDIA_BASE_URL")
  );
  const apiKey = readRequiredEnvironment("FLUXMEDIA_API_KEY");
  const model = readRequiredEnvironment("VIDEO_TEST_MODEL");
  const seconds = readBoundedInteger("VIDEO_TEST_SECONDS", 8, 1, 1800);
  const aspectRatio = process.env.VIDEO_TEST_ASPECT_RATIO?.trim() || "16:9";
  const resolution = process.env.VIDEO_TEST_RESOLUTION?.trim() || "1080p";
  const prompt =
    process.env.VIDEO_TEST_PROMPT?.trim() ||
    "A paper airplane gliding through warm studio light";
  const waitForTerminal = readBoolean("VIDEO_TEST_WAIT_FOR_TERMINAL", true);
  const pollIntervalSeconds = readBoundedInteger(
    "VIDEO_TEST_POLL_INTERVAL_SECONDS",
    5,
    1,
    300
  );
  const terminalTimeoutSeconds = readBoundedInteger(
    "VIDEO_TEST_TERMINAL_TIMEOUT_SECONDS",
    600,
    1,
    3600
  );
  const requestTimeoutSeconds = readBoundedInteger(
    "VIDEO_TEST_REQUEST_TIMEOUT_SECONDS",
    60,
    1,
    300
  );
  const clientRequestId =
    process.env.VIDEO_TEST_CLIENT_REQUEST_ID?.trim() ||
    `video-api-compat-${randomUUID()}`;
  const commonBody = {
    client_request_id: clientRequestId,
    model,
    prompt,
    aspect_ratio: aspectRatio,
    resolution,
  };
  const createCases = [
    { path: "/v1/videos", body: { ...commonBody, seconds } },
    {
      path: "/api/v1/videos",
      body: { ...commonBody, seconds: String(seconds) },
    },
    {
      path: "/v1/videos/generations",
      body: { ...commonBody, duration: seconds },
    },
    {
      path: "/api/v1/videos/generations",
      body: { ...commonBody, duration_seconds: seconds },
    },
  ];
  let expectedTaskId;
  for (const createCase of createCases) {
    const payload = await requestJson({
      baseUrl,
      apiKey,
      path: createCase.path,
      method: "POST",
      body: createCase.body,
      expectedStatus: 202,
      requestTimeoutMs: requestTimeoutSeconds * 1000,
    });
    const taskId = requireTaskId(payload);
    const status = requirePublicStatus(payload);
    if (payload.object !== "video.task") {
      throw new Error(`${createCase.path} 未返回 object=video.task`);
    }
    if (expectedTaskId && taskId !== expectedTaskId) {
      throw new Error("四个创建地址未命中同一个幂等视频任务");
    }
    expectedTaskId = taskId;
    writeEvent("video_api_create_route_passed", {
      path: createCase.path,
      taskId,
      status,
    });
  }
  if (!expectedTaskId) throw new Error("创建地址测试未返回任务 ID");

  for (const queryPrefix of ["/v1/videos/", "/api/v1/videos/"]) {
    const path = `${queryPrefix}${encodeURIComponent(expectedTaskId)}`;
    const payload = await requestJson({
      baseUrl,
      apiKey,
      path,
      method: "GET",
      expectedStatus: 200,
      requestTimeoutMs: requestTimeoutSeconds * 1000,
    });
    const taskId = requireTaskId(payload);
    const status = requirePublicStatus(payload);
    if (taskId !== expectedTaskId) {
      throw new Error(`${path} 返回了不同的视频任务`);
    }
    writeEvent("video_api_query_route_passed", { path, taskId, status });
  }

  if (!waitForTerminal) {
    writeEvent("video_api_compat_test_passed", {
      taskId: expectedTaskId,
      terminalStatus: null,
      terminalWaitSkipped: true,
    });
    return;
  }

  const deadline = Date.now() + terminalTimeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const payload = await requestJson({
      baseUrl,
      apiKey,
      path: `/v1/videos/${encodeURIComponent(expectedTaskId)}`,
      method: "GET",
      expectedStatus: 200,
      requestTimeoutMs: requestTimeoutSeconds * 1000,
    });
    const status = requirePublicStatus(payload);
    writeEvent("video_api_terminal_poll", {
      taskId: expectedTaskId,
      status,
    });
    if (TERMINAL_STATUSES.has(status)) {
      writeEvent("video_api_compat_test_passed", {
        taskId: expectedTaskId,
        terminalStatus: status,
        terminalWaitSkipped: false,
      });
      return;
    }
    await delay(pollIntervalSeconds * 1000);
  }
  throw new Error(
    `视频任务 ${expectedTaskId} 在 ${terminalTimeoutSeconds} 秒内未进入终态`
  );
}

try {
  await main();
} catch (error) {
  writeEvent("video_api_compat_test_failed", {
    message: error instanceof Error ? error.message : "未知测试错误",
  });
  process.exitCode = 1;
}
