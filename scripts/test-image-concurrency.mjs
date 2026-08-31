#!/usr/bin/env node

/**
 * FluxMedia 文生图并发测试。
 *
 * 这是一个独立的 Node.js 脚本，直接请求线上 FluxMedia HTTP API，不需要启动本项目。
 * 运行前需要 Node.js 20+ 和一个有生图权限的 API key。
 *
 * 参数说明：
 *   --base-url URL
 *     线上服务 origin。默认读取 FLUXMEDIA_BASE_URL，再读取 G2I_BASE，最后使用
 *     https://gpt2image.superapi.buzz。脚本会自动拼接 /v1/images/generations。
 *   --models A,B,C
 *     逗号分隔的模型 ID。默认是 gpt-image-2,nano-banana-2,nano-banana-pro。
 *   --concurrency N
 *     同时在途的最大请求数，默认 3；它是并发上限，不是总请求量。
 *   --requests-per-model N
 *     每个模型发送的请求数，默认 1。
 *   --size WIDTHxHEIGHT
 *     图片尺寸，默认 1024x1024。
 *   --prompt TEXT
 *     固定使用指定提示词。未指定时，从下方内置的 100 条提示词池中随机打散取用；
 *     每轮 100 个请求内不重复，超过 100 个请求后重新打散循环。
 *   --quality VALUE
 *     auto、low、medium 或 high；只有模型为 gpt-image-2 时才会发送此字段。
 *   --response-format VALUE
 *     url 或 b64_json，默认 url。压测建议使用 url，避免结果日志包含大体积 Base64。
 *   --output-format VALUE
 *     可选的 png、jpeg 或 webp；省略时由服务端决定。
 *   --timeout-ms N
 *     每个请求的超时时间，默认 1200000（20 分钟）。
 *   --json
 *     将汇总和逐请求结果输出为 JSON；进度信息输出到 stderr，便于重定向 stdout。
 *   --help
 *     显示命令帮助。
 *
 * 请求量计算：总请求量 = 模型数量 × --requests-per-model；--concurrency 只控制同时
 * 进行的数量。例如 3 个模型、每个 10 次、并发 6 时，总请求量是 30，同时最多 6 个。
 * 默认不会重试失败请求：重试会改变实际并发和请求量，令压测结果失真。
 * API key 只从环境变量读取（命令行参数可能出现在 shell history/process list）。
 * 环境变量：FLUXMEDIA_API_KEY（必填；兼容 G2I_API_KEY）、FLUXMEDIA_BASE_URL（可选；
 * 兼容 G2I_BASE）。
 * 退出码：0 表示全部成功，2 表示至少一个请求失败，1 表示参数或启动错误，130 表示
 * 收到 SIGINT/SIGTERM 后主动中止。
 *
 * 示例：
 *   FLUXMEDIA_API_KEY=... node scripts/test-image-concurrency.mjs
 *   FLUXMEDIA_API_KEY=... node scripts/test-image-concurrency.mjs \
 *     --concurrency 6 --requests-per-model 10 --size 1024x1024
 *   FLUXMEDIA_API_KEY=... node scripts/test-image-concurrency.mjs --json > result.json
 */

import { randomInt, randomUUID } from "node:crypto";

const DEFAULT_MODELS = ["gpt-image-2", "nano-banana-2", "nano-banana-pro"];
const PROMPT_POOL = [
  "A quiet reading room at sunrise, warm window light, wooden shelves, editorial interior photography",
  "A misty mountain lake with a small wooden boat, layered pine forests, cinematic landscape photography",
  "A red fox standing in a snowy birch forest, soft snowfall, natural wildlife photography",
  "A futuristic glass greenhouse on a rooftop at dusk, lush plants, city skyline, architectural visualization",
  "A rustic ceramic mug beside an open notebook on a linen table, morning sunlight, still life photography",
  "A coral reef with colorful fish and rays of sunlight through clear water, detailed underwater photography",
  "A narrow old town street after rain, glowing lanterns, reflective cobblestones, cinematic atmosphere",
  "A majestic white horse running across a windswept beach, golden hour, dynamic fine art photography",
  "A minimalist Japanese tea house in a bamboo grove, soft fog, tranquil architectural photography",
  "A bowl of fresh citrus fruit on a blue tablecloth, crisp shadows, vibrant studio still life",
  "A red vintage bicycle leaning against a weathered brick wall, climbing flowers, afternoon light",
  "A snowy cabin beneath a star-filled sky, warm light in the windows, cozy winter landscape",
  "A graceful white crane beside a lotus pond at dawn, gentle mist, traditional ink wash style",
  "A close-up of a monarch butterfly on a purple flower, sharp details, natural macro photography",
  "A grand library with spiral staircases and glowing lamps, rich wood textures, cinematic interior",
  "A glass sphere resting on black sand beside the ocean, dramatic clouds, surreal fine art",
  "A colorful hot air balloon floating over rolling green hills, clear morning sky, travel photography",
  "A modern concrete villa surrounded by desert plants, strong geometric shadows, architectural photo",
  "A sleepy orange cat curled on a velvet armchair near a sunny window, cozy home photography",
  "A moonlit waterfall in a dense fern forest, blue atmospheric light, fantasy landscape art",
  "A baker shaping bread in a small flour-dusted kitchen, warm natural light, documentary photography",
  "A field of lavender beneath distant mountains, pastel sunset, wide angle landscape photography",
  "A polished brass telescope on a dark observatory balcony, Milky Way overhead, cinematic science scene",
  "A playful otter floating in a calm river, reeds and reflections, expressive wildlife photography",
  "A sculptural spiral staircase in a white gallery, dramatic sunlight and shadow, minimalist architecture",
  "A wooden market stall filled with heirloom tomatoes and herbs, rustic textures, editorial food photo",
  "A lone lighthouse on black volcanic cliffs during a storm, powerful waves, dramatic seascape",
  "A child-sized treehouse hidden among autumn leaves, soft afternoon light, storybook illustration",
  "A delicate glass terrarium with moss and tiny ferns on a studio table, macro product photography",
  "A snow leopard resting on a rocky Himalayan ridge, distant peaks, crisp wildlife portrait",
  "A narrow canal with colorful houses and a small rowboat, calm evening reflections, travel photo",
  "A sculpted marble bust surrounded by wildflowers in a sunlit museum, classical contemporary art",
  "A steaming bowl of ramen on a dark wooden counter, rich textures, moody food photography",
  "A tropical waterfall flowing into a turquoise pool, broad leaves, bright midday nature photography",
  "A sleek electric train crossing a red desert at sunset, long perspective, cinematic travel scene",
  "A pair of red leather gloves beside fallen maple leaves, warm autumn palette, still life photo",
  "A blue whale surfacing in a calm ocean at dawn, distant seabirds, majestic documentary photography",
  "A tiny observatory on a snowy hill under aurora lights, quiet science fiction landscape",
  "A florist arranging fresh peonies in a sunlit workshop, pastel colors, lifestyle photography",
  "A black cat sitting on a rooftop beneath a crescent moon, deep blue night, graphic illustration",
  "A woven basket of wild mushrooms on a forest floor, dappled light, detailed nature still life",
  "A modern art museum reflected in a shallow pool, clear blue sky, clean architectural composition",
  "A hummingbird hovering beside a bright red flower, frozen wing motion, high speed macro photo",
  "A calm alpine meadow with a winding footpath and distant snow peaks, soft morning haze",
  "A copper kettle on a cast iron stove inside a mountain cabin, firelight, cozy rustic interior",
  "A giant ancient tree with lanterns hanging from its branches, twilight mist, magical realism",
  "A sailboat crossing a violet sea beneath a pink sunset, minimalist seascape painting",
  "A detailed close-up of a mechanical watch with visible gears, dark background, luxury product photo",
  "A busy flower market under striped awnings, lively colors, candid street photography",
  "A pair of swans gliding across a glassy lake surrounded by reeds, soft overcast light",
  "A desert oasis with date palms and clear water, distant dunes, warm travel photography",
  "A small robot watering plants in a bright apartment, playful optimistic illustration",
  "A grand staircase leading to a hidden forest temple, moss-covered stone, atmospheric fantasy art",
  "A plate of handmade pasta with basil and tomatoes, rustic ceramic dish, natural food photography",
  "A weathered red barn in a field of tall grass under dramatic clouds, rural landscape photography",
  "A polar bear walking across sea ice beneath pale northern light, minimal wildlife composition",
  "A sculptural white seashell on wet beach sand, delicate reflections, minimalist still life",
  "A lively jazz trio performing in a small velvet theater, warm spotlights, expressive concert photo",
  "A row of colorful umbrellas along a rainy pedestrian street, reflections and soft city lights",
  "A close-up of a honeybee covered in pollen on a sunflower, detailed macro nature photography",
  "A peaceful monastery built into a cliff above clouds, sunrise rays, epic landscape art",
  "A vintage red scooter parked beside a seaside cafe, Mediterranean colors, travel editorial photo",
  "A clear glass bottle with a single green leaf on a white table, precise studio lighting",
  "A herd of elephants walking across a golden savanna at sunset, dust in the air, wildlife photo",
  "A futuristic underwater research station with glowing windows, deep blue ocean, science fiction art",
  "A bowl of ripe peaches on a checked picnic cloth, dappled sunlight, nostalgic still life",
  "A winding river through a canyon covered in autumn trees, aerial landscape photography",
  "A young arctic hare sitting in fresh snow, soft diffused light, intimate wildlife portrait",
  "A spiral galaxy above a silent desert observatory, long exposure astrophotography style",
  "A cozy record shop with wooden shelves and colorful album covers, warm interior photography",
  "A handcrafted paper lantern floating on a dark pond, gentle ripples, poetic night scene",
  "A close-up of a blue eye reflected in a rain-covered window, emotional cinematic portrait",
  "A stone bridge over a clear mountain stream, moss and wildflowers, serene landscape photography",
  "A chef plating a delicate dessert in a bright modern kitchen, editorial culinary photography",
  "A red panda perched on a mossy branch in a cloud forest, soft natural light, wildlife photo",
  "A white sailboat anchored in a turquoise lagoon, palm shadows, crisp tropical travel photo",
  "A geometric arrangement of colorful glass blocks casting rainbow shadows, contemporary still life",
  "A quiet train platform in winter fog, one glowing station clock, cinematic minimalist scene",
  "A field of sunflowers beneath a wide blue sky, gentle breeze, cheerful summer landscape",
  "A moonlit medieval castle above a valley, low clouds and torchlight, detailed fantasy painting",
  "A close-up of a violin resting on sheet music, warm wood grain, intimate studio photography",
  "A family of penguins gathered near an icy blue shore, soft polar daylight, natural documentary photo",
  "A small bookstore cafe with plants and armchairs, afternoon sunbeams, inviting interior photo",
  "A glass of sparkling water with lemon on a marble counter, bright clean commercial photography",
  "A winding boardwalk through a coastal wetland at sunrise, tall grasses, atmospheric landscape",
  "A silver tabby kitten exploring a cardboard box in a bright room, playful pet photography",
  "A traditional red torii gate beside a quiet lake, autumn maples, balanced travel composition",
  "A floating island with waterfalls and a tiny village, bright clouds, whimsical fantasy illustration",
  "A close-up of blue pottery with hand-painted botanical patterns, artisan product photography",
  "A lone hiker on a ridge above a sea of clouds, sunrise backlight, epic outdoor photography",
  "A plate of colorful macarons arranged on a pastel background, soft studio light, food editorial",
  "A snowy owl flying over a frozen marsh, wings spread, sharp wildlife action photography",
  "A modern kitchen with open shelves and herbs by the window, warm Scandinavian interior design",
  "A calm koi pond with orange fish and reflections of maple leaves, tranquil garden photography",
  "A vintage camper van parked under tall redwoods, morning mist, nostalgic road trip photo",
  "A luminous jellyfish drifting through a dark ocean, blue bioluminescence, underwater fine art",
  "A hand-carved wooden mask on a craftsman's workbench, shavings and tools, documentary still life",
  "A coastal village on steep green cliffs, white houses, bright ocean, high angle travel photography",
  "A red umbrella on an empty beach beneath a pale gray sky, minimalist conceptual photography",
  "A greenhouse filled with tropical leaves and hanging vines, humid sunlight, lush botanical photo",
];
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

if (PROMPT_POOL.length !== 100) {
  throw new Error(
    `提示词池必须恰好包含 100 条，当前为 ${PROMPT_POOL.length} 条`
  );
}

function usage() {
  return `
FluxMedia 文生图并发测试

用法:
  FLUXMEDIA_API_KEY=... node scripts/test-image-concurrency.mjs [选项]

选项:
  --base-url URL              线上 origin（默认 FLUXMEDIA_BASE_URL、G2I_BASE 或 https://gpt2image.superapi.buzz）
  --models A,B,C              模型列表（默认 gpt-image-2,nano-banana-2,nano-banana-pro）
  --concurrency N             同时在途请求数（默认 3）
  --requests-per-model N     每个模型请求数（默认 1）
  --size WIDTHxHEIGHT        图片尺寸（默认 1024x1024）
  --prompt TEXT              固定使用指定提示词（默认从内置 100 条提示词池取）
  --quality VALUE             仅对 gpt-image-2 发送：auto|low|medium|high
  --response-format VALUE     url|b64_json（默认 url）
  --output-format VALUE       png|jpeg|webp（默认不发送）
  --timeout-ms N              单请求超时毫秒数（默认 1200000）
  --json                      只输出机器可读 JSON（进度输出改到 stderr）
  --help                      显示帮助

环境变量:
  FLUXMEDIA_API_KEY           必填；兼容已有脚本的 G2I_API_KEY
  FLUXMEDIA_BASE_URL          可选；兼容已有脚本的 G2I_BASE
`;
}

function failUsage(message) {
  throw new Error(`${message}\n${usage()}`);
}

function readOption(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    failUsage(`${name} 需要一个值`);
  }
  return value;
}

function parsePositiveInteger(value, name) {
  if (!/^\d+$/.test(value)) {
    failUsage(`${name} 必须是正整数，收到：${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    failUsage(`${name} 必须是正整数，收到：${value}`);
  }
  return parsed;
}

function readEnvironment(name) {
  return process.env[name];
}

function shuffledPromptIndexes() {
  const indexes = Array.from(
    { length: PROMPT_POOL.length },
    (_, index) => index
  );
  for (let index = indexes.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [indexes[index], indexes[swapIndex]] = [indexes[swapIndex], indexes[index]];
  }
  return indexes;
}

function createPromptAssignments(count, customPrompt) {
  if (customPrompt !== undefined) {
    return Array.from({ length: count }, () => ({
      prompt: customPrompt,
      promptIndex: null,
    }));
  }

  const assignments = [];
  let indexes = [];
  for (let index = 0; index < count; index += 1) {
    if (index % PROMPT_POOL.length === 0) {
      indexes = shuffledPromptIndexes();
    }
    const promptIndex = indexes[index % PROMPT_POOL.length];
    assignments.push({
      prompt: PROMPT_POOL[promptIndex],
      promptIndex,
    });
  }
  return assignments;
}

function parseOptions(argv) {
  const options = {
    apiKey:
      readEnvironment("FLUXMEDIA_API_KEY") || readEnvironment("G2I_API_KEY"),
    baseUrl:
      readEnvironment("FLUXMEDIA_BASE_URL") ||
      readEnvironment("G2I_BASE") ||
      "https://gpt2image.superapi.buzz",
    models: [...DEFAULT_MODELS],
    concurrency: 3,
    requestsPerModel: 1,
    size: "1024x1024",
    prompt: undefined,
    quality: undefined,
    responseFormat: "url",
    outputFormat: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      case "--base-url":
        options.baseUrl = readOption(argv, index, arg);
        index += 1;
        break;
      case "--models":
        options.models = readOption(argv, index, arg)
          .split(",")
          .map((model) => model.trim())
          .filter(Boolean);
        index += 1;
        break;
      case "--concurrency":
        options.concurrency = parsePositiveInteger(
          readOption(argv, index, arg),
          arg
        );
        index += 1;
        break;
      case "--requests-per-model":
        options.requestsPerModel = parsePositiveInteger(
          readOption(argv, index, arg),
          arg
        );
        index += 1;
        break;
      case "--size":
        options.size = readOption(argv, index, arg);
        index += 1;
        break;
      case "--prompt":
        options.prompt = readOption(argv, index, arg);
        index += 1;
        break;
      case "--quality":
        options.quality = readOption(argv, index, arg);
        index += 1;
        break;
      case "--response-format":
        options.responseFormat = readOption(argv, index, arg);
        index += 1;
        break;
      case "--output-format":
        options.outputFormat = readOption(argv, index, arg);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInteger(
          readOption(argv, index, arg),
          arg
        );
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        failUsage(`未知选项：${arg}`);
    }
  }

  if (!options.apiKey) {
    failUsage("缺少 API key，请设置 FLUXMEDIA_API_KEY（或 G2I_API_KEY）");
  }
  if (options.models.length === 0) {
    failUsage("--models 不能为空");
  }
  if (
    options.models.some((model) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model))
  ) {
    failUsage("--models 含有非法模型 ID");
  }
  if (!/^\d+x\d+$/.test(options.size)) {
    failUsage(`--size 必须形如 1024x1024，收到：${options.size}`);
  }
  if (!["url", "b64_json"].includes(options.responseFormat)) {
    failUsage("--response-format 必须是 url 或 b64_json");
  }
  if (
    options.quality !== undefined &&
    !["auto", "low", "medium", "high"].includes(options.quality)
  ) {
    failUsage("--quality 必须是 auto、low、medium 或 high");
  }
  if (
    options.outputFormat !== undefined &&
    !["png", "jpeg", "webp"].includes(options.outputFormat)
  ) {
    failUsage("--output-format 必须是 png、jpeg 或 webp");
  }

  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(options.baseUrl);
  } catch {
    failUsage(`--base-url 不是有效 URL：${options.baseUrl}`);
  }
  if (!["http:", "https:"].includes(parsedBaseUrl.protocol)) {
    failUsage("--base-url 只支持 http 或 https");
  }
  if (parsedBaseUrl.username || parsedBaseUrl.password) {
    failUsage("--base-url 不允许包含用户名或密码");
  }
  if (parsedBaseUrl.search || parsedBaseUrl.hash) {
    failUsage("--base-url 不允许包含 Query 或 Fragment");
  }
  options.baseUrl = parsedBaseUrl.toString().replace(/\/+$/, "");

  return options;
}

function endpointFor(baseUrl) {
  return `${baseUrl}/v1/images/generations`;
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarize(results) {
  const successful = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  const latencies = successful.map((result) => result.latencyMs);
  const stats = {
    total: results.length,
    succeeded: successful.length,
    failed: failed.length,
    successRate: results.length === 0 ? 0 : successful.length / results.length,
    minMs: latencies.length ? Math.min(...latencies) : null,
    maxMs: latencies.length ? Math.max(...latencies) : null,
    avgMs: latencies.length
      ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
      : null,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
  };
  return {
    ...stats,
    errorsByHttpStatus: failed.reduce((counts, result) => {
      const key =
        result.httpStatus === null ? "network" : String(result.httpStatus);
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
  };
}

function byModelSummary(results) {
  const groups = new Map();
  for (const result of results) {
    const group = groups.get(result.model) || [];
    group.push(result);
    groups.set(result.model, group);
  }
  return Object.fromEntries(
    [...groups.entries()].map(([model, modelResults]) => [
      model,
      summarize(modelResults),
    ])
  );
}

function log(options, message) {
  (options.json ? console.error : console.log)(message);
}

async function executeRequest(task, options, endpoint, activeControllers) {
  const requestId = `image-concurrency-${randomUUID()}`;
  const startedAt = Date.now();
  const controller = new AbortController();
  activeControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  const body = {
    model: task.model,
    prompt: task.prompt,
    size: options.size,
    response_format: options.responseFormat,
  };
  // FluxMedia 的公开契约只允许 quality 用于 gpt-image-2；不要把它发给 Banana 模型。
  if (task.model === "gpt-image-2" && options.quality !== undefined) {
    body.quality = options.quality;
  }
  if (options.outputFormat !== undefined) {
    body.output_format = options.outputFormat;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const responseText = await response.text();
    let payload;
    try {
      payload = responseText ? JSON.parse(responseText) : null;
    } catch {
      payload = null;
    }
    const latencyMs = Date.now() - startedAt;
    const data = payload && Array.isArray(payload.data) ? payload.data : null;
    const payloadError =
      payload && typeof payload === "object" && payload.error;
    const ok = response.ok && !payloadError && data && data.length > 0;

    return {
      ok: Boolean(ok),
      model: task.model,
      sequence: task.sequence,
      promptIndex: task.promptIndex,
      requestId,
      httpStatus: response.status,
      latencyMs,
      outputCount: data ? data.length : 0,
      responseBytes: Buffer.byteLength(responseText),
      error: ok
        ? null
        : response.ok
          ? "响应缺少非空 data 数组"
          : `HTTP ${response.status}`,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const timedOut = error?.name === "AbortError";
    return {
      ok: false,
      model: task.model,
      sequence: task.sequence,
      promptIndex: task.promptIndex,
      requestId,
      httpStatus: null,
      latencyMs,
      outputCount: 0,
      responseBytes: 0,
      error: timedOut
        ? `请求超时（${options.timeoutMs} ms）`
        : error instanceof Error
          ? error.message.slice(0, 200)
          : String(error).slice(0, 200),
    };
  } finally {
    clearTimeout(timeout);
    activeControllers.delete(controller);
  }
}

function printHumanReport(report) {
  console.log("\nFluxMedia 文生图并发测试结果");
  console.log(`请求总数: ${report.summary.total}`);
  console.log(`测试并发数: ${report.config.effectiveConcurrency}`);
  console.log(
    `总耗时: ${report.summary.durationMs} ms，` +
      `吞吐: ${report.summary.requestsPerSecond.toFixed(2)} req/s`
  );
  console.log(
    `成功/失败: ${report.summary.succeeded}/${report.summary.failed} ` +
      `(成功率 ${(report.summary.successRate * 100).toFixed(1)}%)`
  );
  if (report.summary.succeeded > 0) {
    console.log(
      `延迟 ms: min ${report.summary.minMs.toFixed(0)}, ` +
        `avg ${report.summary.avgMs.toFixed(0)}, ` +
        `p50 ${report.summary.p50Ms.toFixed(0)}, ` +
        `p95 ${report.summary.p95Ms.toFixed(0)}, ` +
        `max ${report.summary.maxMs.toFixed(0)}`
    );
  }
  console.log("\n按模型:");
  for (const [model, stats] of Object.entries(report.byModel)) {
    console.log(
      `  ${model}: ${stats.succeeded}/${stats.total} 成功` +
        (stats.p95Ms === null ? "" : `，p95 ${stats.p95Ms.toFixed(0)} ms`)
    );
  }
  if (report.failures.length > 0) {
    console.log("\n失败请求（未输出响应正文）:");
    for (const failure of report.failures) {
      console.log(
        `  ${failure.model}#${failure.sequence}: ` +
          `${failure.httpStatus === null ? "network" : `HTTP ${failure.httpStatus}`} ` +
          `${failure.error}`
      );
    }
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const endpoint = endpointFor(options.baseUrl);
  const totalTasks = options.models.length * options.requestsPerModel;
  const effectiveConcurrency = Math.min(options.concurrency, totalTasks);
  const promptAssignments = createPromptAssignments(totalTasks, options.prompt);
  // 按轮次交错模型，避免 requests-per-model 较大时某个模型独占前半段时间窗口。
  const tasks = Array.from({ length: options.requestsPerModel }, (_, index) =>
    options.models.map((model) => ({
      model,
      sequence: index + 1,
    }))
  )
    .flat()
    .map((task, index) => ({
      ...task,
      ...promptAssignments[index],
    }));
  const results = new Array(tasks.length);
  const activeControllers = new Set();
  const runStartedAt = Date.now();
  let nextTask = 0;
  let completed = 0;
  let interrupted = false;

  const onInterrupt = () => {
    if (interrupted) return;
    interrupted = true;
    for (const controller of activeControllers) controller.abort();
    log(options, "收到中断信号，正在取消在途请求……");
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);

  log(
    options,
    `开始测试: ${options.models.join(", ")} | ` +
      `${tasks.length} 请求 | 并发 ${effectiveConcurrency} | ${endpoint}`
  );

  async function worker(workerId) {
    for (;;) {
      if (interrupted) return;
      const taskIndex = nextTask;
      nextTask += 1;
      if (taskIndex >= tasks.length) return;
      const task = tasks[taskIndex];
      const result = await executeRequest(
        task,
        options,
        endpoint,
        activeControllers
      );
      result.worker = workerId;
      results[taskIndex] = result;
      completed += 1;
      log(
        options,
        `[${completed}/${tasks.length}] ${task.model}#${task.sequence} ` +
          `${result.ok ? "成功" : "失败"} ${result.latencyMs} ms` +
          (result.promptIndex === null
            ? ""
            : `（提示词 ${result.promptIndex + 1}/100）`)
      );
    }
  }

  await Promise.all(
    Array.from({ length: effectiveConcurrency }, (_, index) =>
      worker(index + 1)
    )
  );
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onInterrupt);

  const observedResults = results.filter(Boolean);
  const durationMs = Date.now() - runStartedAt;
  const report = {
    generatedAt: new Date().toISOString(),
    endpoint,
    config: {
      models: options.models,
      concurrency: options.concurrency,
      effectiveConcurrency,
      requestsPerModel: options.requestsPerModel,
      size: options.size,
      responseFormat: options.responseFormat,
      outputFormat: options.outputFormat || null,
      timeoutMs: options.timeoutMs,
      promptPoolSize: PROMPT_POOL.length,
      promptSelection:
        options.prompt === undefined ? "random_without_replacement" : "custom",
      // 不输出 prompt 和 API key，避免把测试输入或凭据写入结果文件。
    },
    summary: {
      ...summarize(observedResults),
      durationMs,
      requestsPerSecond:
        observedResults.length === 0 || durationMs === 0
          ? 0
          : observedResults.length / (durationMs / 1000),
    },
    byModel: byModelSummary(observedResults),
    failures: observedResults.filter((result) => !result.ok),
    results: observedResults,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  if (interrupted) process.exitCode = 130;
  else if (report.summary.failed > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
