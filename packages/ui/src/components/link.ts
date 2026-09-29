import type { AnchorHTMLAttributes, ComponentType } from "react";

/**
 * Anything that renders like `<a href>`. The UI package has no Next dependency, so apps pass
 * `next/link` here (`linkComponent={Link}`) to get client-side navigation and prefetching.
 */
export type LinkComponent = ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>;
