/**
 * 已移除的旧视频人工核对入口。
 * 视频供应商统一使用 API 账号，任务提交结果由自动恢复状态机处理。
 */
export async function GET(): Promise<Response> {
  return Response.json(
    { error: "视频人工核对入口已移除" },
    { status: 410 }
  );
}

export async function POST(): Promise<Response> {
  return Response.json(
    { error: "视频人工核对入口已移除" },
    { status: 410 }
  );
}
