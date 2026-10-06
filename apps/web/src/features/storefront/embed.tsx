"use client";

import type { EmbedProps } from "@cnote/storefront/render";
import { ConsentGate } from "@/features/consent/consent-gate";

/**
 * The buyer web's `embed` block: a third-party video or map frame behind the consent gate. Nothing from YouTube / OpenStreetMap is
 * requested until the visitor allows the category or loads that one item. The URL is built by the platform from a fixed privacy-enhanced
 * host (youtube-nocookie.com, openstreetmap.org: @cnote/storefront embedSpec), never taken from the seller, and the CSP `frame-src` allows
 * only those hosts. This file is the ONLY place a storefront third-party `<iframe>` is rendered, and it is inside <ConsentGate>.
 */
export function StoreEmbed({ kind, src, title, provider, category }: EmbedProps) {
  return (
    <ConsentGate category={category} provider={provider} classes={{ root: "sf-embed-gate", primary: "sf-btn", secondary: "sf-btn sf-btn-ghost" }}>
      <iframe
        src={src}
        title={title}
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        // allow-same-origin is required for the providers' own player/tile scripts; they are on other origins, so this never grants ours.
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
        allow={kind !== "map" ? "encrypted-media; picture-in-picture; fullscreen" : undefined}
        allowFullScreen={kind !== "map"}
      />
    </ConsentGate>
  );
}
