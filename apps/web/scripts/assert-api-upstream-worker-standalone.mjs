/**
 * Next.js standalone 中 API 上游脚本 Worker 资产断言。
 *
 * 使用方：镜像构建和发布门。脚本只读取构建目录，确认 Worker 入口、QuickJS JS
 * 桥接和 WASM 同时存在；容器运行 smoke 由部署验证在 Node 22 中另行执行。
 */
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const standaloneRoot = resolve(
  process.cwd(),
  process.argv[2] ?? ".next/standalone"
);

/**
 * 递归收集目录内文件的绝对路径。
 *
 * @param directory - 当前扫描目录。
 * @returns 当前目录及所有子目录中的文件路径。
 */
async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? collectFiles(path) : [path];
    })
  );
  return nested.flat();
}

const files = await collectFiles(standaloneRoot);
const normalized = files.map((file) => file.replaceAll("\\", "/"));
const requiredAssets = [
  {
    name: "Worker 入口",
    matches: (file) => file.endsWith("/api-upstream-script-worker.ts"),
  },
  {
    name: "QuickJS JavaScript 桥接",
    matches: (file) =>
      file.includes("/quickjs-emscripten/") &&
      /\/dist\/index\.(?:js|mjs)$/.test(file),
  },
  {
    name: "QuickJS WebAssembly",
    matches: (file) =>
      file.includes("/quickjs-wasmfile-release-sync/") &&
      file.endsWith("/dist/emscripten-module.wasm"),
  },
];

const missing = requiredAssets
  .filter((asset) => !normalized.some(asset.matches))
  .map((asset) => asset.name);

if (missing.length > 0) {
  throw new Error(
    `standalone 缺少 API 上游 Worker 资产：${missing.join("、")}`
  );
}

process.stdout.write("API 上游脚本 Worker standalone 资产断言通过\n");
