import type { ReactNode } from "react";

/**
 * next-intl renders React elements passed as `t.rich` values (e.g. a <Money /> inside a sentence) but its types only admit
 * strings and tag functions. This keeps the call sites honest about what they pass.
 */
export const el = (node: ReactNode): string => node as unknown as string;
