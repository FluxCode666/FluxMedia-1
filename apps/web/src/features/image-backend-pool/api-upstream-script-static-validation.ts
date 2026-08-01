/**
 * API 上游脚本的保存期静态安全校验。
 *
 * 职责：在 QuickJS 编译前扫描实际代码令牌，明确拒绝运行时契约不支持的异步、
 * Promise 与模块语法；字符串、正则和注释中的同名文本不参与判断。
 */

const FORBIDDEN_IDENTIFIERS = new Set(["async", "await", "Promise"]);

/** 静态安全校验失败；错误不得携带脚本原文。 */
export class ApiUpstreamScriptStaticValidationError extends Error {
  /** 创建不暴露脚本内容的稳定错误。 */
  constructor() {
    super("API 上游处理脚本包含不支持的异步或模块语法");
    this.name = "ApiUpstreamScriptStaticValidationError";
  }
}

/** 判断字符能否出现在 JavaScript 标识符中。 */
function isIdentifierCharacter(character: string | undefined): boolean {
  return Boolean(character && /[a-z0-9_$]/iu.test(character));
}

/** 跳过带反斜杠转义的字符串或正则字面量。 */
function skipQuotedRegion(
  script: string,
  start: number,
  delimiter: "'" | '"' | "/"
): number {
  let index = start + 1;
  while (index < script.length) {
    if (script[index] === "\\") {
      index += 2;
      continue;
    }
    if (script[index] === delimiter) return index + 1;
    index += 1;
  }
  return script.length;
}

/** 跳过单行或块注释，返回下一段代码的起始位置。 */
function skipComment(script: string, start: number): number {
  if (script[start + 1] === "/") {
    const lineEnd = script.indexOf("\n", start + 2);
    return lineEnd === -1 ? script.length : lineEnd + 1;
  }
  const blockEnd = script.indexOf("*/", start + 2);
  return blockEnd === -1 ? script.length : blockEnd + 2;
}

/**
 * 判断当前斜杠是否开启正则字面量。
 *
 * 这是面向安全拒绝的词法启发式：出现在值起始位置的斜杠按正则处理，避免正则
 * 内容误报；其余按除法处理，后续代码仍会逐字符扫描。
 */
function startsRegularExpression(previousToken: string | undefined): boolean {
  return (
    previousToken === undefined ||
    new Set(["(", "[", "{", "=", "!", "?", ":", ",", ";", "return", "case", "=>"]).has(
      previousToken
    )
  );
}

/** 跳过模板文本，并递归扫描其中的 `${...}` 代码表达式。 */
function skipTemplateLiteral(script: string, start: number): number {
  let index = start + 1;
  while (index < script.length) {
    if (script[index] === "\\") {
      index += 2;
      continue;
    }
    if (script[index] === "`") return index + 1;
    if (script[index] === "$" && script[index + 1] === "{") {
      index = scanCode(script, index + 2, true);
      continue;
    }
    index += 1;
  }
  return script.length;
}

/**
 * 扫描一段实际代码，模板插值递归调用时在匹配的右花括号后返回。
 *
 * @param script - 完整管理员脚本。
 * @param start - 当前代码段起点。
 * @param stopAtClosingBrace - 是否在当前层匹配的右花括号处停止。
 * @returns 下一段待扫描字符位置。
 */
function scanCode(
  script: string,
  start: number,
  stopAtClosingBrace: boolean
): number {
  let index = start;
  let braceDepth = 0;
  let previousToken: string | undefined;
  while (index < script.length) {
    const character = script[index];
    if (/\s/u.test(character ?? "")) {
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      index = skipQuotedRegion(script, index, character);
      previousToken = "literal";
      continue;
    }
    if (character === "`") {
      index = skipTemplateLiteral(script, index);
      previousToken = "literal";
      continue;
    }
    if (character === "/" && ["/", "*"].includes(script[index + 1] ?? "")) {
      index = skipComment(script, index);
      continue;
    }
    if (character === "/" && startsRegularExpression(previousToken)) {
      index = skipQuotedRegion(script, index, "/");
      previousToken = "literal";
      while (/[a-z]/iu.test(script[index] ?? "")) index += 1;
      continue;
    }
    if (isIdentifierCharacter(character)) {
      const start = index;
      index += 1;
      while (isIdentifierCharacter(script[index])) index += 1;
      const token = script.slice(start, index);
      if (
        FORBIDDEN_IDENTIFIERS.has(token) ||
        token === "import" ||
        token === "export"
      ) {
        throw new ApiUpstreamScriptStaticValidationError();
      }
      previousToken = token;
      continue;
    }
    if (script.startsWith("=>", index)) {
      previousToken = "=>";
      index += 2;
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
      previousToken = character;
      index += 1;
      continue;
    }
    if (character === "}" && stopAtClosingBrace) {
      if (braceDepth === 0) return index + 1;
      braceDepth -= 1;
      previousToken = character;
      index += 1;
      continue;
    }
    previousToken = character;
    index += 1;
  }
  return index;
}

/**
 * 校验非空管理员脚本不声明异步代码、不使用 Promise，也不包含模块导入导出。
 *
 * @param script - 已通过长度限制、尚未进入 QuickJS 的脚本。
 * @throws ApiUpstreamScriptStaticValidationError 发现禁用代码令牌时失败关闭。
 */
export function assertApiUpstreamScriptStaticContract(script: string): void {
  scanCode(script, 0, false);
}
