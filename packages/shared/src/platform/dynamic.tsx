/**
 * 组件级代码分割。
 *
 * 使用方：替代原 next/dynamic。基于 React.lazy，首次渲染时加载组件模块，
 * 加载期间显示 loading 占位。
 */
import { type ComponentType, lazy, Suspense } from "react";

type LoadedComponent<P> = ComponentType<P> | { default: ComponentType<P> };

type DynamicOptions = {
  loading?: ComponentType<{ isLoading?: boolean; pastDelay?: boolean; error?: Error | null }>;
  ssr?: boolean;
};

export default function dynamic<P extends object>(
  loader: () => Promise<LoadedComponent<P>>,
  options: DynamicOptions = {}
): ComponentType<P> {
  const LazyComponent = lazy(async () => {
    const loaded = await loader();
    return {
      default:
        typeof loaded === "object" && loaded !== null && "default" in loaded
          ? loaded.default
          : (loaded as ComponentType<P>),
    };
  });
  const Loading = options.loading;
  function DynamicComponent(props: P) {
    return (
      <Suspense fallback={Loading ? <Loading isLoading pastDelay error={null} /> : null}>
        <LazyComponent {...(props as P & React.JSX.IntrinsicAttributes)} />
      </Suspense>
    );
  }
  return DynamicComponent;
}
