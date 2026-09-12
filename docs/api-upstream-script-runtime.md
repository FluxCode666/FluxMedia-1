# API 上游脚本运行时

请求脚本和响应脚本属于上游协议适配层。最终架构由 Go backend 拥有这条链路：Go 负责鉴权、计费、任务状态、供应商 URL、认证 Header、媒体令牌和结果 schema；脚本运行时只负责执行管理员提供的转换脚本。

## 部署边界

`api-upstream-script-runtime` 是只允许 backend 访问的私有服务，默认监听 8090，不发布宿主机端口。它使用 Node.js Worker Thread 和 QuickJS，每个作业建立独立的 QuickJS Runtime。Go 通过 `GO_SCRIPT_RUNTIME_URL` 调用 `POST /v1/execute`，并可通过 `GO_SCRIPT_RUNTIME_TOKEN` 设置内部 Bearer 鉴权。

```json
{
  "script": "return { body: { prompt: input.body.prompt } };",
  "operation": "images.generate",
  "stage": "request",
  "input": { "query": {}, "body": {} },
  "context": {
    "platformModelId": "model-id",
    "upstreamModelId": "vendor-model-id"
  }
}
```

成功响应为 `{ "data": { "output": ... } }`；失败响应为 `{ "error": { "code": ..., "message": ... } }`。Runtime 不执行网络请求，也不会收到 API Key、完整 URL、用户身份或真实媒体。

## 运行限制

- 脚本最多 32,768 个字符；同步 CPU 预算 50ms；Worker 墙钟预算 500ms。
- 默认 32MiB QuickJS 内存、512KiB 栈、1 个 Worker，可按部署环境调整到既定安全范围。
- 输入和输出为普通 JSON，单边最多 2MiB，限制深度和节点数。
- 禁止 Node、文件、网络、定时器、Promise、动态代码执行、时间和随机数能力。
- Runtime 只返回 JSON 结果；Go 必须再次校验请求信封、认证 Header、媒体令牌和供应商响应。

## 迁移切换

当前仓库的图片/视频业务仍有部分 Next.js UOL binding，因此 Web 容器暂时仍拥有旧的本地 Worker Pool。新增 Runtime 是 Go 业务接管后的唯一执行目标；Go 生图执行器接入前，不应把 Web 的 `runApiUpstreamScript` 改成无条件远程调用，否则尚未迁移的任务链路会被切断。

完成 Go 生图路由后，切换顺序为：

1. Go 请求执行器调用 Runtime 的 `/v1/execute`。
2. 在 Go 中保留所有上游请求和响应的安全校验。
3. 停止 Web 容器中的本地脚本 Worker 和相关 UOL binding。
4. 生产 Compose 只允许 backend 访问 Runtime，Runtime 不对公网暴露端口。
