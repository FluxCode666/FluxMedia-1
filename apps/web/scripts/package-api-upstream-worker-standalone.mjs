/**
 * API 上游 Worker 与迁移预检的 standalone 运行时打包器。
 *
 * 使用方：Web postbuild。Next 的文件 trace 能拷贝被显式列出的 pnpm
 * 文件，但不会为独立 Worker 和预检脚本的裸模块导入重建包元数据和
 * 解析链接。本脚本从已锁定的工作区递归收集 QuickJS、PostgreSQL 客户端
 * 及其生产依赖，并复制成可移植的标准 node_modules 布局，供裸机
 * standalone 与最终 Docker 镜像共用。
 */
import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDirectory, "..");
const standaloneRoot = resolve(webRoot, ".next/standalone");
const standaloneNodeModules = resolve(standaloneRoot, "apps/web/node_modules");
const standaloneRuntimePackages = ["pg", "quickjs-emscripten"];

/**
 * 把 npm 包名拆成安全路径段。
 *
 * @param {string} packageName 从已安装 manifest 读取的包名。
 * @returns {string[]} 一段非作用域包名或两段作用域包名。
 * @throws {Error} 包名可能逃逸目标 node_modules 时失败关闭。
 */
function packageNameSegments(packageName) {
  if (typeof packageName !== "string" || packageName.includes("\\")) {
    throw new Error("standalone 运行时依赖包名无效");
  }
  const segments = packageName.split("/");
  const scoped = packageName.startsWith("@");
  if (
    (scoped ? segments.length !== 2 : segments.length !== 1) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("standalone 运行时依赖包名无效");
  }
  return segments;
}

/**
 * 读取并验证一个包 manifest 的最小形状。
 *
 * @param {string} packageRoot 包根目录。
 * @param {string} expectedName 解析时请求的包名。
 * @returns {Promise<{ name: string, dependencies: Record<string, string> }>}
 *   已收窄的包名与生产依赖。
 * @throws {Error} manifest 缺失、损坏或包名不一致时失败关闭。
 */
async function readPackageManifest(packageRoot, expectedName) {
  const rawManifest = await readFile(
    resolve(packageRoot, "package.json"),
    "utf8"
  );
  const parsedManifest = JSON.parse(rawManifest);
  if (
    !parsedManifest ||
    typeof parsedManifest !== "object" ||
    Array.isArray(parsedManifest) ||
    parsedManifest.name !== expectedName
  ) {
    throw new Error("QuickJS 运行时依赖 manifest 无效");
  }
  const rawDependencies = parsedManifest.dependencies;
  if (rawDependencies === undefined) {
    return { name: expectedName, dependencies: {} };
  }
  if (
    !rawDependencies ||
    typeof rawDependencies !== "object" ||
    Array.isArray(rawDependencies) ||
    Object.values(rawDependencies).some((value) => typeof value !== "string")
  ) {
    throw new Error("QuickJS 运行时依赖 manifest 无效");
  }
  return { name: expectedName, dependencies: rawDependencies };
}

/**
 * 从 Node 解析到的入口向上定位匹配包根。
 *
 * @param {string} resolvedEntry Node 返回的包入口或 package.json。
 * @param {string} packageName 期望包名。
 * @returns {Promise<string>} 真实包根绝对路径。
 * @throws {Error} 无法找到匹配 manifest 时失败关闭。
 */
async function findPackageRoot(resolvedEntry, packageName) {
  let currentDirectory = dirname(resolvedEntry);
  const filesystemRoot = parse(currentDirectory).root;
  while (currentDirectory !== filesystemRoot) {
    try {
      await readPackageManifest(currentDirectory, packageName);
      return currentDirectory;
    } catch {
      currentDirectory = dirname(currentDirectory);
    }
  }
  throw new Error(`无法定位 standalone 运行时依赖：${packageName}`);
}

/**
 * 以指定 manifest 为起点按 Node 规则解析依赖包。
 *
 * @param {string} packageName 待解析包名。
 * @param {string | URL} resolverBase import.meta.url 或依赖包 manifest 路径。
 * @returns {Promise<{ root: string, manifest: { name: string, dependencies: Record<string, string> } }>}
 *   包根和已验证 manifest。
 */
async function resolvePackageRecord(packageName, resolverBase) {
  packageNameSegments(packageName);
  const resolver = createRequire(resolverBase);
  let resolvedEntry;
  try {
    resolvedEntry = resolver.resolve(`${packageName}/package.json`);
  } catch {
    resolvedEntry = resolver.resolve(packageName);
  }
  const root = await findPackageRoot(resolvedEntry, packageName);
  return {
    root,
    manifest: await readPackageManifest(root, packageName),
  };
}

/**
 * 收集根包的完整生产依赖图。
 *
 * @param {readonly string[]} rootPackages 运行时直接导入的根包。
 * @returns {Promise<Map<string, string>>} 包名到物理包根的唯一映射。
 * @throws {Error} 同名包需要多个物理版本时拒绝不安全的扁平化。
 */
async function collectProductionDependencyGraph(rootPackages) {
  const packageRoots = new Map();
  const pending = rootPackages.map((packageName) => ({
    packageName,
    resolverBase: import.meta.url,
  }));
  while (pending.length > 0) {
    const nextPackage = pending.shift();
    if (!nextPackage) break;
    const record = await resolvePackageRecord(
      nextPackage.packageName,
      nextPackage.resolverBase
    );
    const existingRoot = packageRoots.get(nextPackage.packageName);
    if (existingRoot) {
      if (existingRoot !== record.root) {
        throw new Error(
          `standalone 无法扁平化同名多版本依赖：${nextPackage.packageName}`
        );
      }
      continue;
    }
    packageRoots.set(nextPackage.packageName, record.root);
    const dependencyResolver = resolve(record.root, "package.json");
    for (const dependencyName of Object.keys(
      record.manifest.dependencies
    ).sort()) {
      pending.push({
        packageName: dependencyName,
        resolverBase: dependencyResolver,
      });
    }
  }
  return packageRoots;
}

/**
 * 将 QuickJS 依赖图复制为 standalone 的标准扁平布局。
 *
 * @returns {Promise<number>} 复制的唯一包数。
 * @sideEffects 只替换 `.next/standalone/apps/web/node_modules` 中的对应包。
 */
export async function packageApiUpstreamWorkerStandalone() {
  await access(standaloneRoot);
  const packageRoots =
    await collectProductionDependencyGraph(standaloneRuntimePackages);
  for (const [packageName, packageRoot] of [...packageRoots.entries()].sort()) {
    const destination = resolve(
      standaloneNodeModules,
      ...packageNameSegments(packageName)
    );
    await rm(destination, { recursive: true, force: true });
    await mkdir(dirname(destination), { recursive: true });
    await cp(packageRoot, destination, {
      recursive: true,
      dereference: true,
    });
  }
  return packageRoots.size;
}

/**
 * 执行 postbuild 打包并输出不含路径或依赖名的稳定摘要。
 *
 * @returns {Promise<void>} standalone 已可独立解析 QuickJS 时完成。
 */
async function main() {
  const packageCount = await packageApiUpstreamWorkerStandalone();
  process.stdout.write(
    `${JSON.stringify({
      event: "api_upstream_standalone_runtime_packaged",
      packageCount,
    })}\n`
  );
}

const isMain =
  typeof process.argv[1] === "string" &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
