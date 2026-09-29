/**
 * 页面加载阶段的国际化读取。
 *
 * 使用方：页面与布局的异步加载函数（原服务端组件）。应用启动与切换语言时由
 * setIntlState 写入当前语言与消息；客户端组件继续使用 use-intl 的 hooks。
 */
import { type AbstractIntlMessages, createTranslator } from "use-intl/core";

type IntlState = { locale: string; messages: AbstractIntlMessages; timeZone?: string };

let state: IntlState = { locale: "en", messages: {} };

/** 写入当前语言与消息，供后续加载函数读取。 */
export function setIntlState(next: IntlState): void {
  state = next;
}

/** 当前语言。 */
export async function getLocale(): Promise<string> {
  return state.locale;
}

/** 当前语言的全部消息。 */
export async function getMessages(): Promise<AbstractIntlMessages> {
  return state.messages;
}

type TranslationsOptions = { locale?: string; namespace?: string };

/**
 * 创建与 useTranslations 行为一致的翻译函数。
 *
 * @param options - 命名空间字符串，或包含 locale/namespace 的对象；locale 必须是已加载语言。
 */
export async function getTranslations(options?: string | TranslationsOptions) {
  const namespace = typeof options === "string" ? options : options?.namespace;
  return createTranslator({
    locale: state.locale,
    messages: state.messages,
    ...(state.timeZone ? { timeZone: state.timeZone } : {}),
    ...(namespace ? { namespace } : {}),
  } as Parameters<typeof createTranslator>[0]);
}
