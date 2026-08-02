/**
 * API 上游宿主不透明值保护测试。
 *
 * 职责：锁定媒体令牌化、移动完整性以及循环、深度和节点资源边界；测试不访问
 * 数据库、网络或真实供应商。
 */
import { describe, expect, it } from "vitest";

import {
  ApiUpstreamOpaqueValueError,
  assertApiUpstreamOpaqueValuesPreserved,
  restoreApiUpstreamOpaqueValues,
  tokenizeApiUpstreamOpaqueValues,
} from "./api-upstream-opaque-values";

/** 只保护测试字段中的字符串媒体。 */
function protectMediaField(
  _value: string,
  fieldName: string | undefined
): boolean {
  return fieldName === "media";
}

describe("API upstream opaque values", () => {
  it("令牌化嵌套媒体并在移动后恢复宿主真实值", () => {
    const original = {
      data: [{ nested: { media: "data:image/png;base64,c2FmZQ==" } }],
    };
    const protectedTree = tokenizeApiUpstreamOpaqueValues(
      original,
      protectMediaField
    );
    const token = (protectedTree.value as typeof original).data[0]?.nested
      .media;

    expect(token).toMatch(/^__fluxmedia_opaque_/u);
    expect(JSON.stringify(protectedTree.value)).not.toContain("c2FmZQ==");
    const moved = { outputs: [{ base64: token }] };
    assertApiUpstreamOpaqueValuesPreserved(moved, protectedTree.opaqueValues);
    expect(
      restoreApiUpstreamOpaqueValues(moved, protectedTree.opaqueValues)
    ).toEqual({
      outputs: [{ base64: "data:image/png;base64,c2FmZQ==" }],
    });
  });

  it.each([
    { name: "丢失", build: () => ({ outputs: [] }) },
    {
      name: "复制",
      build: (token: string) => ({ outputs: [token, token] }),
    },
    {
      name: "伪造",
      build: () => ({ outputs: ["__fluxmedia_opaque_forged"] }),
    },
  ])("拒绝媒体令牌$name", ({ build }) => {
    const protectedTree = tokenizeApiUpstreamOpaqueValues(
      { media: "protected-media" },
      protectMediaField
    );
    const token = (protectedTree.value as { media: string }).media;

    expect(() =>
      assertApiUpstreamOpaqueValuesPreserved(
        build(token),
        protectedTree.opaqueValues
      )
    ).toThrow(ApiUpstreamOpaqueValueError);
  });

  it("拒绝循环、超深和节点过多的宿主树", () => {
    const circular: { child?: unknown } = {};
    circular.child = circular;
    let tooDeep: unknown = "leaf";
    for (let index = 0; index < 17; index += 1) {
      tooDeep = { child: tooDeep };
    }
    const tooManyNodes = Array.from({ length: 10_001 }, () => null);

    for (const value of [circular, tooDeep, tooManyNodes]) {
      expect(() =>
        tokenizeApiUpstreamOpaqueValues(value, protectMediaField)
      ).toThrow(ApiUpstreamOpaqueValueError);
    }
  });
});
