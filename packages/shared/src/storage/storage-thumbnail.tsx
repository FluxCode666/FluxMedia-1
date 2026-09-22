"use client";

import Image, { type ImageProps } from "next/image";
import { useState } from "react";
import { buildStorageThumbnailUrl } from "./image-url";

type StorageThumbnailProps = Omit<ImageProps, "src"> & {
  src: string;
  thumbnailWidth: number;
};

/** Keep the original signature while bypassing a cached failed local image. */
function originalImageFallbackUrl(src: string): string {
  const hashIndex = src.indexOf("#");
  const hash = hashIndex >= 0 ? src.slice(hashIndex) : "";
  const base = hashIndex >= 0 ? src.slice(0, hashIndex) : src;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}fm_fallback=${Date.now().toString(36)}${hash}`;
}

function StorageThumbnailImage({
  src,
  thumbnailWidth,
  onError,
  ...imageProps
}: StorageThumbnailProps) {
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const thumbnailUrl = buildStorageThumbnailUrl(src, thumbnailWidth) ?? src;

  return (
    <Image
      unoptimized
      {...imageProps}
      src={fallbackUrl ?? thumbnailUrl}
      onError={(event) => {
        // Only transformed local thumbnails have an alternative to retry.
        // External signed URLs, data URLs and blob URLs stay byte-for-byte intact.
        if (thumbnailUrl !== src) {
          setFallbackUrl((current) => current ?? originalImageFallbackUrl(src));
        }
        onError?.(event);
      }}
    />
  );
}

/** Render a local storage thumbnail, retrying its original image only once. */
export function StorageThumbnail(props: StorageThumbnailProps) {
  // Remount before painting a new source so an earlier failure cannot retain the
  // previous image or suppress the new source's thumbnail attempt.
  return (
    <StorageThumbnailImage
      key={`${props.thumbnailWidth}:${props.src}`}
      {...props}
    />
  );
}
