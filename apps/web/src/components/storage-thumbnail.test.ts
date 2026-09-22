// @vitest-environment jsdom

import { StorageThumbnail } from "@repo/shared/storage/storage-thumbnail";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let container: HTMLDivElement;
let root: Root;

function renderThumbnail(src: string, thumbnailWidth = 320): HTMLImageElement {
  act(() => {
    root.render(
      createElement(StorageThumbnail, {
        src,
        thumbnailWidth,
        alt: "Image preview",
        width: 160,
        height: 160,
        sizes: "160px",
        className: "object-contain",
        fetchPriority: "low",
      })
    );
  });
  const image = container.querySelector("img");
  if (!image) throw new Error("Image preview was not rendered");
  return image;
}

function failImage(image: HTMLImageElement): void {
  act(() => image.dispatchEvent(new Event("error")));
}

function resolvedSource(src: string): string {
  return new URL(src, document.baseURI).href;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("StorageThumbnail", () => {
  const signedSource =
    "/api/storage/media/user/image.png?sig=a%2Bb%2Fc%3D&exp=9999999999#preview";

  it.each([
    128, 160, 320, 640,
  ])("loads the %i px thumbnail while keeping its signature and image attributes", (thumbnailWidth) => {
    const image = renderThumbnail(signedSource, thumbnailWidth);
    expect(image.src).toBe(
      resolvedSource(
        `/api/storage/media/w${thumbnailWidth}/user/image.png?sig=a%2Bb%2Fc%3D&exp=9999999999#preview`
      )
    );
    expect(image.getAttribute("width")).toBe("160");
    expect(image.getAttribute("height")).toBe("160");
    expect(image.getAttribute("fetchpriority")).toBe("low");
    expect(image.className).toContain("object-contain");
  });

  it("retries the original once and preserves the signed query exactly", () => {
    vi.spyOn(Date, "now").mockReturnValue(12345);
    const image = renderThumbnail(signedSource);
    failImage(image);
    const fallbackSource = image.getAttribute("src");
    expect(fallbackSource).toBe(
      resolvedSource(
        "/api/storage/media/user/image.png?sig=a%2Bb%2Fc%3D&exp=9999999999&fm_fallback=9ix#preview"
      )
    );

    vi.spyOn(Date, "now").mockReturnValue(67890);
    failImage(image);
    failImage(image);
    expect(image.getAttribute("src")).toBe(fallbackSource);
  });

  it.each([
    "https://cdn.example.com/image.png?X-Amz-Signature=a%2Bb&X-Amz-Expires=300",
    "https://cdn.example.com/api/storage/media/image.png?sig=external",
    "data:image/png;base64,iVBORw0KGgo=",
    "blob:http://localhost/preview-1",
    "/images/sample.png",
  ])("keeps untransformed image URLs intact after failure: %s", (src) => {
    const image = renderThumbnail(src);
    expect(image.src).toBe(resolvedSource(src));
    failImage(image);
    failImage(image);
    expect(image.src).toBe(resolvedSource(src));
  });

  it("starts a fresh thumbnail attempt when the source changes after failure", () => {
    failImage(renderThumbnail(signedSource));
    const newSource =
      "/api/storage/media/user/second.png?sig=second&exp=9999999999";
    const image = renderThumbnail(newSource);
    expect(image.src).toBe(
      resolvedSource(
        "/api/storage/media/w320/user/second.png?sig=second&exp=9999999999"
      )
    );
    failImage(image);
    expect(image.getAttribute("src")).toContain(
      "/api/storage/media/user/second.png?sig=second&exp=9999999999&fm_fallback="
    );

    expect(renderThumbnail(signedSource).getAttribute("src")).toContain(
      "/api/storage/media/w320/user/image.png"
    );
  });

  it("retries a new width when the thumbnail size changes after failure", () => {
    failImage(renderThumbnail(signedSource, 128));
    expect(renderThumbnail(signedSource, 640).getAttribute("src")).toContain(
      "/api/storage/media/w640/user/image.png"
    );
  });
});
