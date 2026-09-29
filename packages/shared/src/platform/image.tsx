/**
 * 图片组件。
 *
 * 使用方：替代原 next/image。SPA 不做运行时图片优化，这里只保留布局语义：
 * fill 铺满父容器、priority 提前加载、其余情况懒加载并异步解码。
 */
import { type CSSProperties, forwardRef, type ImgHTMLAttributes } from "react";

export type StaticImageData = {
  src: string;
  width?: number;
  height?: number;
  blurDataURL?: string;
};

export type ImageProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height" | "loading"
> & {
  src: string | StaticImageData;
  alt: string;
  width?: number | `${number}`;
  height?: number | `${number}`;
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  unoptimized?: boolean;
  placeholder?: string;
  blurDataURL?: string;
  loading?: "lazy" | "eager";
};

const FILL_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  color: "transparent",
};

const Image = forwardRef<HTMLImageElement, ImageProps>(function Image(
  {
    src,
    width,
    height,
    fill,
    priority,
    quality: _quality,
    unoptimized: _unoptimized,
    placeholder: _placeholder,
    blurDataURL: _blurDataURL,
    loading,
    style,
    ...rest
  },
  ref
) {
  const resolved = typeof src === "string" ? { src } : src;
  return (
    <img
      ref={ref}
      src={resolved.src}
      width={fill ? undefined : (width ?? resolved.width)}
      height={fill ? undefined : (height ?? resolved.height)}
      loading={priority ? "eager" : (loading ?? "lazy")}
      decoding="async"
      fetchPriority={priority ? "high" : undefined}
      style={fill ? { ...FILL_STYLE, ...style } : style}
      {...rest}
    />
  );
});

export default Image;
