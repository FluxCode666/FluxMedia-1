/**
 * API 文档电梯模块折叠的组件级回归测试。
 *
 * 使用方是 Vitest；挂载真实客户端组件，验证模块按钮只改变目录可见性，不触发正文
 * 锚点或滚动。测试不访问网络、数据库或真实浏览器导航。
 */
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiDocsElevator } from "./api-docs-elevator";

const ENDPOINTS = [
  {
    id: "models",
    method: "GET" as const,
    path: "/v1/models",
    title: "查询可用模型",
  },
  {
    id: "image-generations",
    method: "POST" as const,
    path: "/v1/images/generations",
    title: "创建图片",
  },
] as const;

const GROUPS = [
  {
    id: "api-basics",
    title: "接入基础",
    endpointIds: ["models"],
  },
  {
    id: "image-api",
    title: "生成图片",
    endpointIds: ["image-generations"],
  },
] as const;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/**
 * 挂载使用固定模块与端点夹具的真实 API 文档电梯。
 *
 * @returns 包含电梯 DOM 的根容器。
 * @sideEffects 向 document.body 添加 React 根节点并注册组件滚动监听。
 * @failure 组件渲染失败时由 React 或测试环境直接抛错。
 */
function mountElevator(): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(ApiDocsElevator, {
        ariaLabel: "接口目录",
        description: "展开模块后，点击具体接口定位。",
        endpoints: ENDPOINTS,
        groups: GROUPS,
        standaloneSections: [{ id: "image-size-table", title: "图片尺寸表" }],
      })
    );
  });
  return container;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/zh/api-docs");
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("ApiDocsElevator", () => {
  it("模块按钮只切换接口列表，不改变 hash 或滚动位置", () => {
    const mounted = mountElevator();
    const imageButton = Array.from(
      mounted.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent?.includes("生成图片"));

    expect(imageButton).toBeDefined();
    if (!imageButton) return;

    const endpointListId = imageButton.getAttribute("aria-controls");
    const endpointList = endpointListId
      ? mounted.querySelector<HTMLElement>(`#${endpointListId}`)
      : null;
    const initialHash = window.location.hash;
    const initialScrollY = window.scrollY;

    expect(imageButton.getAttribute("aria-expanded")).toBe("true");
    expect(endpointList?.classList.contains("hidden")).toBe(false);

    act(() => imageButton.click());

    expect(imageButton.getAttribute("aria-expanded")).toBe("false");
    expect(endpointList?.classList.contains("hidden")).toBe(true);
    expect(window.location.hash).toBe(initialHash);
    expect(window.scrollY).toBe(initialScrollY);

    act(() => imageButton.click());

    expect(imageButton.getAttribute("aria-expanded")).toBe("true");
    expect(endpointList?.classList.contains("hidden")).toBe(false);
  });

  it("展示独立正文章节入口", () => {
    const mounted = mountElevator();
    const link = Array.from(
      mounted.querySelectorAll<HTMLAnchorElement>("a")
    ).find((item) => item.textContent?.includes("图片尺寸表"));

    expect(link?.getAttribute("href")).toBe("#image-size-table");
  });
});
