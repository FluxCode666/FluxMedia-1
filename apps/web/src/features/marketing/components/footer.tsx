import { footerNav, siteConfig } from "@repo/shared/config";
import { getLocale } from "next-intl/server";

import { Link } from "@/i18n/routing";

const footerTitleMap = {
  product: {
    Models: "模型广场",
    Docs: "文档",
    "Contact Us": "联系我们",
  },
  legal: {
    "Terms of Service": "服务条款",
    "Privacy Policy": "隐私政策",
    "Cookie Policy": "Cookie 政策",
  },
} as const;

function getFooterLinkTitle(
  title: string,
  group: keyof typeof footerTitleMap,
  isZh: boolean
) {
  if (!isZh) return title;
  return (
    footerTitleMap[group][
      title as keyof (typeof footerTitleMap)[typeof group]
    ] || title
  );
}

/**
 * 判断 Footer 链接是否必须绕过本地化站内 Link。
 *
 * @param href - 共享导航交付的链接。
 * @returns mailto、http、https 等非根路径协议为 true，站内根路径为 false。
 * @sideEffects 无。
 */
export function isExternalFooterHref(href: string): boolean {
  return !href.startsWith("/");
}

/**
 * 渲染普通营销页面 Footer。
 *
 * @returns 本地化品牌说明、模型广场/文档/联系与法律链接。
 * @sideEffects 读取当前请求 locale；不读取会话或运行时模型目录。
 * @failure 未识别语言按英文展示；未知链接标题原样返回。
 */
export async function Footer() {
  const isZh = (await getLocale()) === "zh";

  return (
    <footer className="border-t border-border/60 bg-background">
      <div className="container py-16">
        <div className="grid gap-12 lg:grid-cols-[1fr_1fr]">
          {/* 品牌区 */}
          <div>
            <Link href="/" className="mb-4 inline-block">
              <span className="font-serif text-xl font-medium">FluxMedia</span>
            </Link>
            <p className="text-sm text-muted-foreground">
              {isZh
                ? "面向图像与视频创作的 AI 生成平台。"
                : "An AI generation platform for image and video creation."}
            </p>
          </div>

          {/* 链接区 */}
          <div className="grid grid-cols-2 gap-8">
            {/* 产品 */}
            <div>
              {/* 分组标签:小字大写字距,弱化为 muted */}
              <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {isZh ? "产品" : "Product"}
              </h3>
              <ul className="space-y-3">
                {footerNav.product.map((link) => (
                  <li key={link.href}>
                    {isExternalFooterHref(link.href) ? (
                      <a
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                        href={link.href}
                      >
                        {getFooterLinkTitle(link.title, "product", isZh)}
                      </a>
                    ) : (
                      <Link
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                        href={link.href}
                      >
                        {getFooterLinkTitle(link.title, "product", isZh)}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            {/* 法律 */}
            <div>
              <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {isZh ? "法律" : "Legal"}
              </h3>
              <ul className="space-y-3">
                {footerNav.legal.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {getFooterLinkTitle(link.title, "legal", isZh)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* 底部栏 */}
        <div className="mt-12 flex flex-col items-center justify-center gap-4 border-t border-border/60 pt-8 sm:flex-row sm:justify-start">
          <p className="text-sm text-muted-foreground">
            {isZh
              ? `© ${new Date().getFullYear()} ${siteConfig.name}。保留所有权利。`
              : `© ${new Date().getFullYear()} ${siteConfig.name}. All rights reserved.`}
          </p>
        </div>
      </div>
    </footer>
  );
}
