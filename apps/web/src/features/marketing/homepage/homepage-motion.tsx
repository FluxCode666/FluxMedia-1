/**
 * 官网首页 GSAP 渐进增强边界。
 *
 * 使用方：服务端 `HomepageContent`；本文件是首页唯一注册和执行 GSAP、useGSAP 与
 * ScrollTrigger 的位置。内容默认保持完成态，动画失败、减动效、断点变化和卸载时
 * 都清除本组件写入的内联样式与异步资源。
 */
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type { ReactNode } from "react";
import { useRef } from "react";

import { getHomepageMotionPolicy } from "./homepage-motion-policy";

const MOTION_QUERIES = {
  isDesktop: "(min-width: 1024px)",
  isMobile: "(max-width: 1023px)",
  reduceMotion: "(prefers-reduced-motion: reduce)",
} as const;

const MOTION_SELECTORS = {
  hero: '[data-homepage-motion="hero"]',
  heroArtwork: '[data-homepage-motion="hero-artwork"]',
  heroCopy: '[data-homepage-motion="hero-copy"]',
  heroParallax: '[data-homepage-motion="hero-parallax"]',
  model: '[data-homepage-motion="model"]',
  reveal: '[data-homepage-motion="reveal"]',
  artwork: '[data-homepage-motion="artwork"]',
} as const;

let homepageGsapAvailable = false;

if (typeof window !== "undefined") {
  try {
    gsap.registerPlugin(useGSAP, ScrollTrigger);
    homepageGsapAvailable = true;
  } catch {
    homepageGsapAvailable = false;
  }
}

/** 记录实际被本组件写入动效样式的节点，供失败恢复和卸载清理使用。 */
function rememberHomepageMotionTargets(
  collection: Set<HTMLElement>,
  targets: readonly HTMLElement[]
): void {
  for (const target of targets) collection.add(target);
}

/** 仅撤销合成层提示，不改变仍由滚动进度维护的 transform。 */
function clearHomepageWillChange(targets: Iterable<HTMLElement>): void {
  for (const target of targets) target.style.removeProperty("will-change");
}

/** 只为当前正在动画的节点设置短期合成层提示。 */
function setHomepageWillChange(
  targets: Iterable<HTMLElement>,
  value: "transform" | "transform, opacity"
): void {
  for (const target of targets) target.style.willChange = value;
}

/**
 * 恢复服务端完成态，确保异常或卸载后没有隐藏内容和组件遗留的合成层样式。
 */
function clearHomepageMotionStyles(targets: Iterable<HTMLElement>): void {
  for (const target of targets) {
    target.style.removeProperty("transform");
    target.style.removeProperty("opacity");
    target.style.removeProperty("visibility");
    target.style.removeProperty("will-change");
  }
}

/**
 * 为服务端首页增加受约束的短动效。
 *
 * @param props - 服务端已经渲染完成态的首页 children。
 * @returns 带根作用域 ref 的透明容器；无 JavaScript 时 children 原样可读和可操作。
 * @sideEffects 客户端挂载后创建局部 GSAP context、媒体查询、少量 ScrollTrigger 和
 * 根节点事件监听；所有资源在断点切换或卸载时撤销。
 * @failure GSAP 注册、初始化或刷新失败时直接保留服务端完成态并清除局部样式。
 */
export function HomepageMotion({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useGSAP(
    (_context, contextSafe) => {
      const root = rootRef.current;
      const view = root?.ownerDocument.defaultView;
      if (!root || !view || !homepageGsapAvailable || !contextSafe) return;

      const allOwnedTargets = new Set<HTMLElement>();
      const select = gsap.utils.selector(root);
      let motionMedia: gsap.MatchMedia | null = null;
      let refreshFrame: number | null = null;
      let allowScrollTrigger = false;

      /** 合并动态布局变化，单帧内最多刷新一次本页 ScrollTrigger。 */
      const refreshOnNextFrame = contextSafe(() => {
        refreshFrame = null;
        if (!allowScrollTrigger) return;

        try {
          ScrollTrigger.refresh();
        } catch {
          allowScrollTrigger = false;
          try {
            motionMedia?.revert();
          } finally {
            clearHomepageMotionStyles(allOwnedTargets);
          }
        }
      });

      /** 仅在桌面滚动增强实际启用时安排刷新。 */
      const scheduleRefresh = contextSafe(() => {
        if (!allowScrollTrigger || refreshFrame !== null) return;
        refreshFrame = view.requestAnimationFrame(refreshOnNextFrame);
      });

      /** 图片完成解码并改变局部布局时安排一次合并刷新。 */
      const handleImageLoad = contextSafe((event: Event) => {
        if (event.target instanceof HTMLImageElement) scheduleRefresh();
      });

      try {
        motionMedia = gsap.matchMedia(root);
        motionMedia.add(MOTION_QUERIES, (mediaContext) => {
          const policy = getHomepageMotionPolicy({
            isDesktop: Boolean(mediaContext.conditions?.isDesktop),
            reduceMotion: Boolean(mediaContext.conditions?.reduceMotion),
          });
          allowScrollTrigger = policy.allowScrollTrigger;

          if (policy.mode === "disabled") return;

          const branchTargets = new Set<HTMLElement>();
          const introTargets = new Set<HTMLElement>();
          const hero = select<HTMLElement>(MOTION_SELECTORS.hero)[0];
          const heroCopy = select<HTMLElement>(MOTION_SELECTORS.heroCopy);
          const heroArtwork = select<HTMLElement>(MOTION_SELECTORS.heroArtwork);
          const heroParallax = select<HTMLElement>(
            MOTION_SELECTORS.heroParallax
          );
          const model = select<HTMLElement>(MOTION_SELECTORS.model)[0];
          const revealTargets = select<HTMLElement>(MOTION_SELECTORS.reveal);
          const artworkTargets = select<HTMLElement>(MOTION_SELECTORS.artwork);

          rememberHomepageMotionTargets(introTargets, heroCopy);
          rememberHomepageMotionTargets(introTargets, heroArtwork);
          rememberHomepageMotionTargets(branchTargets, heroCopy);
          rememberHomepageMotionTargets(branchTargets, heroArtwork);
          rememberHomepageMotionTargets(allOwnedTargets, heroCopy);
          rememberHomepageMotionTargets(allOwnedTargets, heroArtwork);

          try {
            gsap.set(heroCopy, {
              autoAlpha: 0,
              willChange: "transform, opacity",
              y: policy.mode === "full" ? 18 : 10,
            });
            gsap.set(heroArtwork, {
              autoAlpha: 0,
              scale: policy.mode === "full" ? 0.985 : 0.995,
              willChange: "transform, opacity",
              y: policy.mode === "full" ? 20 : 10,
            });

            const introTimeline = gsap.timeline({
              defaults: {
                duration: policy.mode === "full" ? 0.58 : 0.42,
                ease: "power2.out",
              },
              onComplete: () => clearHomepageMotionStyles(introTargets),
            });
            introTimeline
              .to(heroCopy, { autoAlpha: 1, stagger: 0.055, y: 0 }, 0)
              .to(
                heroArtwork,
                {
                  autoAlpha: 1,
                  duration: policy.mode === "full" ? 0.72 : 0.5,
                  scale: 1,
                  y: 0,
                },
                0.08
              );

            if (
              policy.allowScrollTrigger &&
              hero &&
              model &&
              heroParallax.length > 0
            ) {
              const bridgeTargets = [...heroParallax, model];
              rememberHomepageMotionTargets(branchTargets, bridgeTargets);
              rememberHomepageMotionTargets(allOwnedTargets, bridgeTargets);

              const setBridgeWillChange = () => {
                setHomepageWillChange(bridgeTargets, "transform");
              };
              const clearBridgeWillChange = () => {
                clearHomepageWillChange(bridgeTargets);
              };
              const bridgeTimeline = gsap.timeline({
                defaults: { ease: "none" },
                scrollTrigger: {
                  end: "bottom 35%",
                  onEnter: setBridgeWillChange,
                  onEnterBack: setBridgeWillChange,
                  onLeave: clearBridgeWillChange,
                  onLeaveBack: clearBridgeWillChange,
                  scrub: 0.35,
                  start: "top top",
                  trigger: hero,
                },
              });
              bridgeTimeline
                .to(heroParallax, { y: 18 }, 0)
                .fromTo(model, { y: 10 }, { y: 0 }, 0);
            }

            if (policy.allowScrollTrigger) {
              rememberHomepageMotionTargets(branchTargets, revealTargets);
              rememberHomepageMotionTargets(allOwnedTargets, revealTargets);
              gsap.set(revealTargets, { autoAlpha: 0, y: 18 });

              for (const target of revealTargets) {
                gsap.to(target, {
                  autoAlpha: 1,
                  duration: 0.56,
                  ease: "power2.out",
                  onComplete: () => clearHomepageMotionStyles([target]),
                  onStart: () => {
                    setHomepageWillChange([target], "transform, opacity");
                  },
                  scrollTrigger: {
                    once: true,
                    start: "top 88%",
                    trigger: target,
                  },
                  y: 0,
                });
              }

              rememberHomepageMotionTargets(branchTargets, artworkTargets);
              rememberHomepageMotionTargets(allOwnedTargets, artworkTargets);

              // 交错方向只制造轻微纵深，不改变文档流，也不与图片悬停 transform 竞争。
              for (const [index, target] of artworkTargets.entries()) {
                const setArtworkWillChange = () => {
                  setHomepageWillChange([target], "transform");
                };
                const clearArtworkWillChange = () => {
                  clearHomepageWillChange([target]);
                };

                gsap.fromTo(
                  target,
                  { yPercent: index % 2 === 0 ? 7 : -3 },
                  {
                    ease: "none",
                    scrollTrigger: {
                      end: "bottom top",
                      onEnter: setArtworkWillChange,
                      onEnterBack: setArtworkWillChange,
                      onLeave: clearArtworkWillChange,
                      onLeaveBack: clearArtworkWillChange,
                      scrub: 0.6,
                      start: "top bottom",
                      trigger: target,
                    },
                    yPercent: index % 2 === 0 ? -7 : 4,
                  }
                );
              }
            }
          } catch {
            allowScrollTrigger = false;
            try {
              mediaContext.revert();
            } finally {
              clearHomepageMotionStyles(branchTargets);
            }
            return;
          }

          return () => {
            allowScrollTrigger = false;
            clearHomepageMotionStyles(branchTargets);
          };
        });
      } catch {
        allowScrollTrigger = false;
        try {
          motionMedia?.revert();
        } finally {
          clearHomepageMotionStyles(allOwnedTargets);
        }
        return;
      }

      root.addEventListener("load", handleImageLoad, true);
      scheduleRefresh();

      return () => {
        root.removeEventListener("load", handleImageLoad, true);
        if (refreshFrame !== null) view.cancelAnimationFrame(refreshFrame);
        motionMedia?.revert();
        clearHomepageMotionStyles(allOwnedTargets);
      };
    },
    { scope: rootRef }
  );

  return (
    <div className="bg-background text-foreground" ref={rootRef}>
      {children}
    </div>
  );
}
