import type { AnchorHTMLAttributes } from "react";

/** Ad links are plain anchors to the click-recording redirect (no locale prefix, no prefetch), marked rel=sponsored per Google's guidance. */
export function SponsoredLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a href={href} rel="sponsored nofollow noopener" {...rest}>
      {children}
    </a>
  );
}
