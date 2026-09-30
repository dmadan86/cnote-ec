"use client";
import { useActionState, startTransition, type FormEvent } from "react";
import type { A2aActionResult } from "./actions";

/**
 * Submits a form to a server action without React 19's automatic form reset, so a failed submit keeps everything the buyer typed
 * (WCAG 3.3.7 redundant entry). The result is rendered in an always-mounted live region by <ActionMessage>.
 */
export function useA2aAction(action: (prev: A2aActionResult | null, f: FormData) => Promise<A2aActionResult>) {
  const [state, dispatch, pending] = useActionState<A2aActionResult | null, FormData>(action, null);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => dispatch(fd));
  };
  return { state, pending, onSubmit };
}
