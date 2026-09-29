/**
 * 由 src/app 目录生成 React Router 路由树。
 *
 * 使用方：main.tsx。约定与原 App Router 一致：`(group)` 不进入 URL，`[param]` 为动态段，
 * `[...slug]` 为 catch-all，`[[...slug]]` 为可选 catch-all；每段可带 layout.tsx、page.tsx、
 * loading.tsx。页面与布局模块按路由懒加载，loading 骨架随入口一起打包以便立即显示。
 */
import type { ComponentType } from "react";
import type { RouteObject } from "react-router";

import {
  LayoutRoute,
  MetadataManager,
  NotFoundPage,
  RouteErrorBoundary,
  type SegmentLoader,
  createLayoutLoader,
  createLayoutRevalidation,
  createPageLoader,
  createPageRoute,
} from "./route-runtime";
import { Outlet } from "react-router";

const APP_PREFIX = "../app/";

const pageModules = import.meta.glob("../app/**/page.tsx") as Record<string, SegmentLoader>;
const layoutModules = import.meta.glob("../app/**/layout.tsx") as Record<string, SegmentLoader>;
const loadingModules = import.meta.glob<ComponentType>("../app/**/loading.tsx", {
  eager: true,
  import: "default",
});

type DirNode = {
  segment: string;
  layout?: SegmentLoader;
  page?: SegmentLoader;
  loading?: ComponentType;
  children: Map<string, DirNode>;
};

function createNode(segment: string): DirNode {
  return { segment, children: new Map() };
}

/** 把 glob 结果按目录层级组织成树。 */
function buildTree(): DirNode {
  const root = createNode("");
  const insert = (file: string, apply: (node: DirNode) => void) => {
    const segments = file.slice(APP_PREFIX.length).split("/").slice(0, -1);
    let node = root;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (!child) {
        child = createNode(segment);
        node.children.set(segment, child);
      }
      node = child;
    }
    apply(node);
  };
  for (const [file, load] of Object.entries(layoutModules)) insert(file, (node) => { node.layout = load; });
  for (const [file, load] of Object.entries(pageModules)) insert(file, (node) => { node.page = load; });
  for (const [file, Loading] of Object.entries(loadingModules)) insert(file, (node) => { node.loading = Loading; });
  return root;
}

type SegmentKind =
  | { kind: "group" }
  | { kind: "static"; path: string }
  | { kind: "param"; name: string }
  | { kind: "catchAll"; name: string; optional: boolean };

function parseSegment(segment: string): SegmentKind {
  if (segment.startsWith("(") && segment.endsWith(")")) return { kind: "group" };
  const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
  if (optionalCatchAll?.[1]) return { kind: "catchAll", name: optionalCatchAll[1], optional: true };
  const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
  if (catchAll?.[1]) return { kind: "catchAll", name: catchAll[1], optional: false };
  const param = /^\[(.+)\]$/.exec(segment);
  if (param?.[1]) return { kind: "param", name: param[1] };
  return { kind: "static", path: segment };
}

type WalkState = {
  /** 距最近一个路由对象累积的相对路径段。 */
  pending: string[];
  /** 当前段及祖先声明的参数名，用于布局的重新执行判定。 */
  paramNames: string[];
  catchAll: string | undefined;
  loading: ComponentType | null;
};

function joinPath(parts: readonly string[]): string {
  return parts.join("/");
}

function pageRoutes(node: DirNode, state: WalkState, optionalCatchAll: boolean): RouteObject[] {
  if (!node.page) return [];
  const loading = state.loading;
  const base = {
    loader: createPageLoader({ load: node.page, catchAll: state.catchAll, deferred: loading !== null }),
    Component: createPageRoute(loading),
    HydrateFallback: loading ?? (() => null),
    errorElement: <RouteErrorBoundary />,
    handle: { catchAll: state.catchAll },
  };
  if (!optionalCatchAll) {
    const path = joinPath(state.pending);
    return [path ? { ...base, path } : { ...base, index: true }];
  }
  // 可选 catch-all 同时匹配无后缀路径（index）与任意后缀（*）。
  const prefix = state.pending.slice(0, -1);
  const indexRoute: RouteObject = prefix.length
    ? { ...base, path: joinPath(prefix) }
    : { ...base, index: true };
  return [indexRoute, { ...base, path: joinPath(state.pending) }];
}

function walk(node: DirNode, parent: WalkState, isRoot: boolean): RouteObject[] {
  const state: WalkState = { ...parent, pending: [...parent.pending], paramNames: [...parent.paramNames] };
  let optionalCatchAll = false;
  if (!isRoot) {
    const parsed = parseSegment(node.segment);
    if (parsed.kind === "static") state.pending.push(parsed.path);
    if (parsed.kind === "param") {
      state.pending.push(`:${parsed.name}`);
      state.paramNames.push(parsed.name);
    }
    if (parsed.kind === "catchAll") {
      state.pending.push("*");
      state.paramNames.push("*");
      state.catchAll = parsed.name;
      optionalCatchAll = parsed.optional;
    }
  }
  if (node.loading) state.loading = node.loading;

  if (node.layout) {
    const childState: WalkState = { ...state, pending: [] };
    const children = [
      ...pageRoutes(node, childState, false),
      ...[...node.children.values()].flatMap((child) => walk(child, childState, false)),
    ];
    const path = joinPath(state.pending);
    return [
      {
        ...(path ? { path } : {}),
        loader: createLayoutLoader({ load: node.layout, catchAll: state.catchAll }),
        shouldRevalidate: createLayoutRevalidation(state.paramNames),
        Component: LayoutRoute,
        HydrateFallback: state.loading ?? (() => null),
        children,
      },
    ];
  }
  return [
    ...pageRoutes(node, state, optionalCatchAll),
    ...[...node.children.values()].flatMap((child) => walk(child, state, false)),
  ];
}

function RootRoute() {
  return (
    <>
      <MetadataManager />
      <Outlet />
    </>
  );
}

/** 完整路由表：app 目录路由 + 全局 404。 */
export function createAppRoutes(): RouteObject[] {
  const tree = buildTree();
  const rootState: WalkState = { pending: [], paramNames: [], catchAll: undefined, loading: null };
  return [
    {
      id: "root",
      Component: RootRoute,
      errorElement: <RouteErrorBoundary />,
      children: [...walk(tree, rootState, true), { path: "*", Component: NotFoundPage }],
    },
  ];
}
