/**
 * 首页 SLA 可见性的最小管理员 client island。
 *
 * 使用方：服务端可靠性区；只接收初始布尔值，文案在客户端按当前 locale 读取，提交
 * 后刷新 Server Component 重新取得真实配置和统计，不在浏览器持有角色或会话对象。
 */
import { Button } from "@repo/ui/components/button";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useTranslations } from "use-intl";
import { useAction } from "@repo/shared/platform/use-action";
import { toast } from "sonner";

import { updateMarketingSlaStatusVisibilityAction } from "@/features/marketing/actions/sla-status";
import { useRouter } from "@/i18n/routing";

/**
 * 提交首页 SLA 展示状态并在成功后刷新服务端真相。
 *
 * @param props.initiallyEnabled - 服务端已读取并收窄的当前布尔状态。
 * @returns 管理员专用按钮；请求期间禁用，成功和失败都有可感知反馈。
 */
export function HomepageSlaToggle({
  initiallyEnabled,
}: {
  initiallyEnabled: boolean;
}) {
  const t = useTranslations("Homepage.reliability.toggle");
  const router = useRouter();
  const { execute, isPending } = useAction(
    updateMarketingSlaStatusVisibilityAction,
    {
      onSuccess: ({ data }) => {
        toast.success(data?.enabled ? t("enabled") : t("disabled"));
        router.refresh();
      },
      onError: ({ error }) => {
        toast.error(error.serverError || t("failed"));
      },
    }
  );

  return (
    <Button
      className="self-start rounded-full"
      disabled={isPending}
      onClick={() => execute({ enabled: !initiallyEnabled })}
      size="sm"
      type="button"
      variant="outline"
    >
      {isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : initiallyEnabled ? (
        <EyeOff className="size-4" />
      ) : (
        <Eye className="size-4" />
      )}
      {initiallyEnabled ? t("hide") : t("show")}
    </Button>
  );
}
