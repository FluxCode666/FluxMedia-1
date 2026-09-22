/** Inventory every HTTP route, server action, and operation requiring Go parity. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(resolve(root, "apps/web/package.json"))("typescript");
const workspacePackages = ["shared", "ui"].map((name) => ({
  directory: `packages/${name}`,
  manifest: JSON.parse(readFileSync(resolve(root, `packages/${name}/package.json`), "utf8")),
}));
function files(directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${directory}/${entry.name}`;
      return entry.isDirectory() ? files(path) : [path];
    }
  );
}
function parse(path) {
  return ts.createSourceFile(
    path,
    readFileSync(resolve(root, path), "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}
// Recognize Node's createRequire aliases as well as direct require/import.
// Otherwise a legacyRequire("@repo/database") call would evade the boundary.
function loaderNames(source) {
  const factories = new Set(["createRequire"]);
  const names = new Set(["require"]);
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === "node:module" &&
      node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const entry of node.importClause.namedBindings.elements)
        if ((entry.propertyName?.text ?? entry.name.text) === "createRequire") factories.add(entry.name.text);
    }
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.initializer && ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) && factories.has(node.initializer.expression.text)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return names;
}
function isLoaderCall(node, names) {
  return ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && names.has(node.expression.text))) &&
    node.arguments[0] && ts.isStringLiteral(node.arguments[0]);
}
function isRuntimeImport(node) {
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly || !node.moduleSpecifier) return false;
    return !node.exportClause || !ts.isNamedExports(node.exportClause) ||
      node.exportClause.elements.some((entry) => !entry.isTypeOnly);
  }
  if (!ts.isImportDeclaration(node)) return false;
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    return clause.namedBindings.elements.some((entry) => !entry.isTypeOnly);
  }
  return true;
}
function resolveSourceImport(from, specifier) {
  let base;
  if (specifier.startsWith("@/")) {
    base = `apps/web/src/${specifier.slice(2)}`;
  } else if (specifier.startsWith("@repo/")) {
    const pkg = workspacePackages.find(({ manifest }) => specifier === manifest.name || specifier.startsWith(`${manifest.name}/`));
    if (!pkg) return null;
    const subpath = specifier.slice(pkg.manifest.name.length);
    const exported = pkg.manifest.exports?.[subpath ? `.${subpath}` : "."];
    if (typeof exported !== "string") return null;
    base = `${pkg.directory}/${exported.replace(/^\.\//, "")}`;
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = resolve(dirname(resolve(root, from)), specifier);
    base = relative(root, base);
  } else {
    return null;
  }
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.ts`]) {
    try {
      readFileSync(resolve(root, candidate));
      return candidate;
    } catch {}
  }
  return null;
}
const runtimeEntryFiles = [
  ...files("apps/web/src/app").filter((file) => /\.tsx?$/.test(file) && !/\.(test|spec)\./.test(file)),
  "apps/web/src/instrumentation.ts",
  "apps/web/src/proxy.ts",
  "apps/web/src/middleware.ts",
  "apps/web/src/server/uol-init.ts",
  "apps/web/src/server/uol-bindings.ts",
];
const runtimeReachable = new Set();
const pendingRuntimeFiles = [...runtimeEntryFiles];
while (pendingRuntimeFiles.length) {
  const file = pendingRuntimeFiles.pop();
  if (!file || runtimeReachable.has(file)) continue;
  let source;
  try { source = parse(file); } catch { continue; }
  runtimeReachable.add(file);
  for (const node of source.statements) {
    if (!isRuntimeImport(node)) continue;
    const target = resolveSourceImport(file, node.moduleSpecifier.text);
    if (target) pendingRuntimeFiles.push(target);
  }
  const loaders = loaderNames(source);
  function visitDynamicImports(node) {
    if (isLoaderCall(node, loaders)) {
      const target = resolveSourceImport(file, node.arguments[0].text);
      if (target) pendingRuntimeFiles.push(target);
    }
    ts.forEachChild(node, visitDynamicImports);
  }
  visitDynamicImports(source);
}
const routes = files("apps/web/src/app")
  .filter((p) => p.endsWith("/route.ts"))
  .map((file) => {
    const source = parse(file);
    const methods = new Set();
    const exported = (name) => {
      if (/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(name))
        methods.add(name);
    };
    for (const node of source.statements) {
      if (
        ts.isExportDeclaration(node) &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      ) {
        for (const entry of node.exportClause.elements)
          exported(entry.name.text);
      }
      if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        if (ts.isFunctionDeclaration(node) && node.name)
          exported(node.name.text);
        if (ts.isVariableStatement(node))
          for (const entry of node.declarationList.declarations)
            if (ts.isIdentifier(entry.name)) exported(entry.name.text);
      }
    }
    return {
      path: `/${relative("apps/web/src/app", file).replace(/\/route\.ts$/, "")}`,
      methods: [...methods].sort(),
      source: file,
    };
  })
  .sort((a, b) => a.path.localeCompare(b.path));
const actions = [];
const operations = [];
const directDatabaseImports = [];
const legacyDatabaseImports = [];
const runtimeInfrastructureImports = [];
const serverGoRequests = [];
const dynamicGoRequests = [];
const goRequestHelpers = new Map([
  ["requestGoJson", 0], ["requestGoResponse", 0],
  ["requestGoBackendJson", 0], ["requestGoBackendInternalJson", 0],
  ["requestGoJsonForPrincipal", 1], ["requestAnalyticsGo", 0],
  ["requestAnalyticsGoForPrincipal", 1],
]);

// Check direct server-action paths too: many Go endpoints have no route.ts counterpart.
// Dynamic wrappers are recorded separately and never presented as route coverage.
function collectGoRequests(source, file) {
  function literalPath(node) {
    if (!node) return null;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return node.head.text + node.templateSpans.map((span) => `audit-value${span.literal.text}`).join("");
    }
    return null;
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && goRequestHelpers.has(node.expression.text)) {
      const offset = goRequestHelpers.get(node.expression.text);
      const path = literalPath(node.arguments[offset])?.split("?")[0];
      const init = node.arguments[offset + 1];
      let method = "GET";
      if (init && init.kind !== ts.SyntaxKind.UndefinedKeyword && init.getText(source) !== "undefined") {
        method = null;
        if (ts.isObjectLiteralExpression(init)) {
          const property = init.properties.find((entry) => ts.isPropertyAssignment(entry) && entry.name.getText(source) === "method");
          if (property && ts.isStringLiteralLike(property.initializer)) method = property.initializer.text.toUpperCase();
          else if (!property && !init.properties.some(ts.isSpreadAssignment)) method = "GET";
        }
      }
      const location = { source: file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 };
      if (path?.startsWith("/") && method) serverGoRequests.push({ path, method, ...location });
      else dynamicGoRequests.push({ helper: node.expression.text, ...location });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
function infrastructureKind(specifier) {
  if (/^(?:pg|postgres|mysql2|better-sqlite3|mongodb)(?:\/|$)/.test(specifier)) return "database-driver";
  if (/^(?:ioredis|redis|@upstash\/redis|@upstash\/ratelimit|bullmq)(?:\/|$)/.test(specifier)) return "redis-or-queue";
  return null;
}
for (const file of new Set([
  ...files("apps/web/src"),
  ...files("packages/shared/src"),
  ...runtimeReachable,
])) {
  if (!/\.(?:[cm]?js|tsx?)$/.test(file) || /\.(test|spec)\./.test(file)) continue;
  const source = parse(file);
  let hasDatabaseImport = (
    source.statements.some(
      (n) =>
        isRuntimeImport(n) &&
        n.moduleSpecifier?.text?.startsWith("@repo/database")
    )
  );
  const loaders = loaderNames(source);
  const imports = new Set(source.statements.filter(isRuntimeImport).map((node) => node.moduleSpecifier.text));
  function visitDatabaseImport(node) {
    if (isLoaderCall(node, loaders)) {
      imports.add(node.arguments[0].text);
      if (node.arguments[0].text.startsWith("@repo/database")) hasDatabaseImport = true;
    }
    ts.forEachChild(node, visitDatabaseImport);
  }
  visitDatabaseImport(source);
  if (runtimeReachable.has(file)) {
    collectGoRequests(source, file);
    for (const specifier of imports) {
      const kind = infrastructureKind(specifier);
      if (kind) runtimeInfrastructureImports.push({ source: file, module: specifier, kind });
    }
  }
  if (hasDatabaseImport) {
    if (runtimeReachable.has(file)) directDatabaseImports.push(file);
    else legacyDatabaseImports.push(file);
  }
  if (
    source.statements.some(
      (n) =>
        ts.isExpressionStatement(n) &&
        ts.isStringLiteral(n.expression) &&
        n.expression.text === "use server"
    )
  ) {
    const exports = [];
    for (const n of source.statements) {
      if (!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
        continue;
      if (ts.isFunctionDeclaration(n) && n.name) exports.push(n.name.text);
      if (ts.isVariableStatement(n))
        for (const d of n.declarationList.declarations)
          if (ts.isIdentifier(d.name)) exports.push(d.name.text);
    }
    actions.push({ source: file, exports });
  }
  // Some operations are registered through typed factories (for example one
  // first-payment operation per provider). Resolve literal factory arguments
  // against template names instead of losing those registrations in the count.
  function evaluate(node, bindings) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isIdentifier(node)) return bindings[node.text];
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const value = evaluate(span.expression, bindings);
        if (value === undefined) return undefined;
        text += String(value) + span.literal.text;
      }
      return text;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const out = {};
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) out[property.name.getText(source)] = evaluate(property.initializer, bindings);
        else if (ts.isShorthandPropertyAssignment(property)) out[property.name.text] = bindings[property.name.text];
      }
      return out;
    }
    return undefined;
  }
  const factories = new Map();
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    function findDefinition(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineOperation" &&
        node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        factories.set(statement.name.text, { definition: node.arguments[0], parameters: statement.parameters });
      }
      ts.forEachChild(node, findDefinition);
    }
    findDefinition(statement.body);
  }
  function register(definition, bindings = {}) {
    const properties = definition.properties;
    const nameNode = properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(source) === "name")?.initializer;
    const accessNode = properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(source) === "access")?.initializer;
    const name = nameNode && evaluate(nameNode, bindings);
    if (typeof name !== "string") return;
    if (operations.some((operation) => operation.name === name)) return;
    operations.push({ name, access: Object.keys(bindings).length && accessNode
      ? JSON.stringify(evaluate(accessNode, bindings)) : accessNode?.getText(source), source: file });
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "defineOperation" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) register(node.arguments[0]);
      const factory = factories.get(node.expression.text);
      if (factory) {
        const bindings = {};
        factory.parameters.forEach((parameter, index) => {
          if (ts.isIdentifier(parameter.name) && node.arguments[index]) bindings[parameter.name.text] = evaluate(node.arguments[index], {});
        });
        register(factory.definition, bindings);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const inventory = {
  schemaVersion: 2,
  routes,
  actions,
  operations: operations.sort((a, b) => a.name.localeCompare(b.name)),
  directDatabaseImports,
  legacyDatabaseImports,
  runtimeInfrastructureImports,
  serverGoRequests,
  dynamicGoRequests,
};
const output = resolve(root, "docs/go-migration-inventory.json");
if (process.argv.includes("--write"))
  writeFileSync(output, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      routes: routes.length,
      httpMethods: routes.reduce((sum, r) => sum + r.methods.length, 0),
      serverActionFiles: actions.length,
      serverActions: actions.reduce((sum, a) => sum + a.exports.length, 0),
      operations: operations.length,
      directDatabaseImports: directDatabaseImports.length,
      ...(process.argv.includes("--details") ? { databaseImportFiles: directDatabaseImports } : {}),
      legacyDatabaseImports: legacyDatabaseImports.length,
      runtimeInfrastructureImports: runtimeInfrastructureImports.length,
      serverGoRequests: serverGoRequests.length,
      dynamicGoRequests: dynamicGoRequests.length,
      ...(process.argv.includes("--details") ? { infrastructureImportFiles: runtimeInfrastructureImports } : {}),
    },
    null,
    2
  )
);
