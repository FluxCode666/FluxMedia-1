import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionResult } from "./client";

type JsonFunction = (...args: never[]) => Promise<ActionResult>;
type Result<F extends JsonFunction> = Awaited<ReturnType<F>> & ActionResult;
type Input<F extends JsonFunction> = Parameters<F>[0];
type Callbacks<F extends JsonFunction> = {
  onExecute?: (args: { input: Input<F> }) => unknown;
  onSuccess?: (args: { data: NonNullable<Result<F>["data"]>; input: Input<F> }) => unknown;
  onError?: (args: { error: Omit<Result<F>, "data">; input: Input<F> }) => unknown;
  onSettled?: (args: { result: Result<F>; input: Input<F> }) => unknown;
};
type Status = "idle" | "executing" | "hasSucceeded" | "hasErrored";

/** Stable callbacks and pending state for JSON requests, including overlapping calls. */
export function useJsonAction<F extends JsonFunction>(fn: F, callbacks?: Callbacks<F>) {
  const [result, setResult] = useState<Partial<Result<F>>>({});
  const [input, setInput] = useState<Input<F> | undefined>(undefined);
  const [pending, setPending] = useState(0);
  const current = useRef({ fn, callbacks });
  current.current = { fn, callbacks };
  const mounted = useRef(true);
  const sequence = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const executeAsync = useCallback(async (...args: Parameters<F>) => {
    const call = ++sequence.current;
    const callInput = args[0] as Input<F>;
    setPending((count) => count + 1);
    setInput(callInput);
    await current.current.callbacks?.onExecute?.({ input: callInput });
    let value: Result<F>;
    try {
      value = await current.current.fn(...args) as Result<F>;
    } catch (error) {
      value = { serverError: error instanceof Error ? error.message : "网络请求失败，请稍后重试" } as Result<F>;
    }
    try {
      if (mounted.current) {
        if (sequence.current === call) setResult(value);
        if (value.serverError || value.validationErrors) {
          await current.current.callbacks?.onError?.({ error: value, input: callInput });
        } else {
          await current.current.callbacks?.onSuccess?.({ data: value.data as NonNullable<Result<F>["data"]>, input: callInput });
        }
        await current.current.callbacks?.onSettled?.({ result: value, input: callInput });
      }
      return value;
    } finally {
      if (mounted.current) setPending((count) => count - 1);
    }
  }, []);
  const execute = useCallback((...args: Parameters<F>) => { void executeAsync(...args); }, [executeAsync]);
  const reset = useCallback(() => { sequence.current++; setResult({}); setInput(undefined); }, []);
  const status: Status =
    pending > 0
      ? "executing"
      : result.serverError || result.validationErrors
        ? "hasErrored"
        : "data" in result
          ? "hasSucceeded"
          : "idle";
  return {
    execute,
    executeAsync,
    result,
    input,
    status,
    reset,
    isIdle: status === "idle",
    isPending: pending > 0,
    isExecuting: pending > 0,
    hasSucceeded: status === "hasSucceeded",
    hasErrored: status === "hasErrored",
  };
}
