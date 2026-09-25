// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ImageWhiteboard } from "./image-whiteboard";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => {
      callback(new Blob(["png"], { type: "image/png" }));
    }
  );
  vi.stubGlobal("crypto", { randomUUID: () => "drawing-1" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("saves a nonempty drawing as an opaque PNG reference image", async () => {
  const onSave = vi.fn().mockReturnValue(true);
  const onClose = vi.fn();
  act(() => root.render(createElement(ImageWhiteboard, { onSave, onClose })));

  const canvas = document.querySelector<HTMLCanvasElement>(
    'canvas[aria-label="手绘画板"]'
  );
  expect(canvas).not.toBeNull();
  expect(canvas?.getContext("2d")?.fillStyle).toBe("#ffffff");
  expect(canvas?.getContext("2d")?.fillRect).toHaveBeenCalledWith(
    0,
    0,
    1024,
    1024
  );
  const saveButton = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("保存为参考图")
  );
  expect(saveButton?.disabled).toBe(true);
  if (!canvas) throw new Error("画板未渲染");
  canvas.getBoundingClientRect = () =>
    ({ width: 200, height: 200, left: 0, top: 0 }) as DOMRect;
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn().mockReturnValue(true);
  canvas.releasePointerCapture = vi.fn();
  const pointerDown = new Event("pointerdown", { bubbles: true });
  Object.assign(pointerDown, { pointerId: 1, clientX: 50, clientY: 50 });
  act(() => canvas.dispatchEvent(pointerDown));
  expect(saveButton?.disabled).toBe(false);

  await act(async () => saveButton?.click());
  const savedFile = onSave.mock.calls[0]?.[0] as File;
  expect(savedFile.name).toBe("whiteboard-drawing-1.png");
  expect(savedFile.type).toBe("image/png");
  expect(savedFile.size).toBeGreaterThan(0);
  expect(onClose).toHaveBeenCalledOnce();
});

it("undo and clear remove strokes without submitting an empty board", () => {
  const onSave = vi.fn();
  act(() =>
    root.render(createElement(ImageWhiteboard, { onSave, onClose: vi.fn() }))
  );
  const canvas = document.querySelector<HTMLCanvasElement>(
    'canvas[aria-label="手绘画板"]'
  );
  if (!canvas) throw new Error("画板未渲染");
  canvas.getBoundingClientRect = () =>
    ({ width: 200, height: 200, left: 0, top: 0 }) as DOMRect;
  canvas.setPointerCapture = vi.fn();
  const pointerDown = new Event("pointerdown", { bubbles: true });
  Object.assign(pointerDown, { pointerId: 1, clientX: 50, clientY: 50 });
  act(() => canvas.dispatchEvent(pointerDown));
  const undoButton = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("撤销")
  );
  const clearButton = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("清空")
  );
  act(() => undoButton?.click());
  expect(undoButton?.disabled).toBe(true);
  canvas.hasPointerCapture = vi.fn().mockReturnValue(true);
  canvas.releasePointerCapture = vi.fn();
  const pointerUp = new Event("pointerup", { bubbles: true });
  Object.assign(pointerUp, { pointerId: 1 });
  act(() => canvas.dispatchEvent(pointerUp));
  act(() => canvas.dispatchEvent(pointerDown));
  act(() => clearButton?.click());
  expect(clearButton?.disabled).toBe(true);
  expect(onSave).not.toHaveBeenCalled();
});
