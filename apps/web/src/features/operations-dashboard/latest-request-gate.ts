/**
 * 客户端最新请求门。
 *
 * 使用方：运营总览快照与明细 Sheet。通过单调请求号使旧响应失效，不负责取消
 * 请求或持久化状态。
 */

export type LatestRequestGate = {
  begin: () => number;
  invalidate: () => void;
  isLatest: (requestId: number) => boolean;
};

/**
 * 创建单调递增请求门，延迟返回的旧请求不会覆盖最新状态。
 *
 * @returns 可开始、失效和校验请求号的内存门。
 * @sideEffects 只修改闭包内请求号，不取消网络请求。
 */
export function createLatestRequestGate(): LatestRequestGate {
  let latestRequestId = 0;
  return {
    begin() {
      latestRequestId += 1;
      return latestRequestId;
    },
    invalidate() {
      latestRequestId += 1;
    },
    isLatest(requestId) {
      return requestId === latestRequestId;
    },
  };
}
