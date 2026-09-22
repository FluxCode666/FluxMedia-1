// Real Worker Thread transport with deterministic delays/faults for HTTP tests.
import { parentPort, workerData } from "node:worker_threads";
parentPort.on("message", job => {
  if (job.script === "hang") return;
  if (job.script === "exit") process.exit(0);
  if (job.script === "wrong-id") return parentPort.postMessage({ type: "result", id: "wrong", ok: true, outputJson: "{}" });
  if (job.script === "cleanup-failed") return parentPort.postMessage({ type: "result", id: job.id, ok: false, replaceWorker: true });
  const finish = () => parentPort.postMessage({ type: "result", id: job.id, ok: true, outputJson: job.inputJson });
  if (job.script === "hold" && workerData?.holdGate) {
    const gate = new Int32Array(workerData.holdGate);
    Atomics.wait(gate, 0, 0);
    finish();
  } else if (job.script === "hold") setTimeout(finish, 350);
  else finish();
});
parentPort.postMessage({ type: "ready" });
