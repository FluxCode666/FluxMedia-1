/** Inventory every HTTP route, server action, and operation requiring Go parity. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(resolve(root, "apps/web/package.json"))("typescript");
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
for (const file of [
  ...files("apps/web/src"),
  ...files("packages/shared/src"),
]) {
  if (!/\.tsx?$/.test(file) || /\.(test|spec)\./.test(file)) continue;
  const source = parse(file);
  if (
    source.statements.some(
      (n) =>
        ts.isImportDeclaration(n) &&
        n.moduleSpecifier.text?.startsWith("@repo/database")
    )
  )
    directDatabaseImports.push(file);
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
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineOperation" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const properties = node.arguments[0].properties;
      const name = properties.find(
        (p) => ts.isPropertyAssignment(p) && p.name.getText(source) === "name"
      )?.initializer;
      const access = properties.find(
        (p) => ts.isPropertyAssignment(p) && p.name.getText(source) === "access"
      )?.initializer;
      if (name && ts.isStringLiteral(name))
        operations.push({
          name: name.text,
          access: access?.getText(source),
          source: file,
        });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const inventory = {
  routes,
  actions,
  operations: operations.sort((a, b) => a.name.localeCompare(b.name)),
  directDatabaseImports,
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
    },
    null,
    2
  )
);
