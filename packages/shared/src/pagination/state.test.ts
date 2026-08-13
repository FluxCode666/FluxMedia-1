/**
 * 通用分页状态的 DB-free 契约测试。
 *
 * 使用方：列表 operation 与 URL adapter；覆盖严格解析、精确总页数、越界收敛
 * 和固定页码窗口，防止业务页面重新实现不同规则。
 */
import { describe, expect, it } from "vitest";
import { parsePaginationConfig } from "./config";
import {
  calculateTotalPages,
  getPaginationWindow,
  parsePaginationState,
  parsePositivePageInteger,
  resolvePaginationState,
} from "./state";

const paginationConfig = parsePaginationConfig([10, 20, 50]);

describe("pagination state", () => {
  it.each([
    [undefined, 1],
    ["1", 1],
    ["0001", 1],
    ["0002", 2],
    ["0", 1],
    ["-2", 1],
    ["1.5", 1],
    [["2"], 1],
    ["9007199254740992", 1],
    ["41", 41],
  ])("严格解析页码 %o", (value, expected) => {
    expect(parsePositivePageInteger(value)).toBe(expected);
  });

  it("按白名单解析页大小并拒绝数组或已下线选项", () => {
    expect(
      parsePaginationState({ page: "3", pageSize: "50" }, paginationConfig)
    ).toEqual({ page: 3, pageSize: 50 });
    expect(
      parsePaginationState({ page: ["3"], pageSize: ["10"] }, paginationConfig)
    ).toEqual({ page: 1, pageSize: 20 });
    expect(
      parsePaginationState({ page: "2", pageSize: "40" }, paginationConfig)
    ).toEqual({ page: 2, pageSize: 20 });
  });

  it.each([
    [0, 20, 1],
    [1, 20, 1],
    [20, 20, 1],
    [21, 20, 2],
    [41, 20, 3],
  ])("由 total=%i 和 pageSize=%i 计算 %i 页", (total, size, pages) => {
    expect(calculateTotalPages(total, size)).toBe(pages);
  });

  it("将空结果和越界页收敛到最后一个有效页", () => {
    expect(resolvePaginationState({ page: 99, pageSize: 20 }, 41)).toEqual({
      page: 3,
      pageSize: 20,
      totalCount: 41,
      totalPages: 3,
      hasNavigation: true,
    });
    expect(resolvePaginationState({ page: 99, pageSize: 20 }, 0)).toEqual({
      page: 1,
      pageSize: 20,
      totalCount: 0,
      totalPages: 1,
      hasNavigation: false,
    });
  });

  it("拒绝无法作为精确计数或页大小的数值", () => {
    expect(() => calculateTotalPages(-1, 20)).toThrow(RangeError);
    expect(() => calculateTotalPages(1, 0)).toThrow(RangeError);
    expect(() => calculateTotalPages(Number.NaN, 20)).toThrow(RangeError);
  });

  it("在首页、中间页和末页生成有界窗口", () => {
    expect(getPaginationWindow(1, 8)).toEqual([
      1,
      2,
      3,
      4,
      5,
      "end-ellipsis",
      8,
    ]);
    expect(getPaginationWindow(5, 10)).toEqual([
      1,
      "start-ellipsis",
      4,
      5,
      6,
      "end-ellipsis",
      10,
    ]);
    expect(getPaginationWindow(99, 10)).toEqual([
      1,
      "start-ellipsis",
      6,
      7,
      8,
      9,
      10,
    ]);
  });
});
