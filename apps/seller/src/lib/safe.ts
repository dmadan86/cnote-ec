import { unstable_rethrow } from "next/navigation";

export type Loaded<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Wraps a data load so a page can degrade to an inline error instead of a 500.
 * Do not call redirect()/require*() inside `fn`: framework control-flow errors are re-thrown.
 */
export async function load<T>(fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    unstable_rethrow(err);
    console.error("[seller] load failed", err);
    return { ok: false, error: "We could not load this right now. Please try again in a moment." };
  }
}
