"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionResult } from "./client";

type JsonFunction = (...args: never[]) => Promise<ActionResult>;
type Result<F extends JsonFunction> = Awaited<ReturnType<F>> & ActionResult;
type Callbacks<F extends JsonFunction> = {
  onSuccess?: (args: { data: NonNullable<Result<F>["data"]>; input: Parameters<F>[0] }) => unknown;
  onError?: (args: { error: Omit<Result<F>, "data">; input: Parameters<F>[0] }) => unknown;
};

/** Stable callbacks and pending state for JSON requests, including overlapping calls. */
export function useJsonAction<F extends JsonFunction>(fn: F, callbacks?: Callbacks<F>) {
  const [result, setResult] = useState<Partial<Result<F>>>({});
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
    setPending((count) => count + 1);
    try {
      const value = await current.current.fn(...args) as Result<F>;
      if (mounted.current) {
        if (sequence.current === call) setResult(value);
        if (value.serverError || value.validationErrors) {
          await current.current.callbacks?.onError?.({ error: value, input: args[0] as Parameters<F>[0] });
        } else if ("data" in value) {
          await current.current.callbacks?.onSuccess?.({ data: value.data as NonNullable<Result<F>["data"]>, input: args[0] as Parameters<F>[0] });
        }
      }
      return value;
    } catch (error) {
      const value = { serverError: error instanceof Error ? error.message : "网络请求失败，请稍后重试" } as Result<F>;
      if (mounted.current) {
        if (sequence.current === call) setResult(value);
        await current.current.callbacks?.onError?.({ error: value, input: args[0] as Parameters<F>[0] });
      }
      return value;
    } finally {
      if (mounted.current) setPending((count) => count - 1);
    }
  }, []);
  const execute = useCallback((...args: Parameters<F>) => { void executeAsync(...args); }, [executeAsync]);
  const reset = useCallback(() => { sequence.current++; setResult({}); }, []);
  return { execute, executeAsync, result, reset, isPending: pending > 0, isExecuting: pending > 0 };
}
