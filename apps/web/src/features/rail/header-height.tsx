"use client";
import { useEffect } from "react";

/**
 * Publishes the sticky site header's height as `--site-header-h` on <html> (it is one row at 2xl and two rows between
 * lg and 2xl, and the top bar shows from sm up), so the rail can stick right under it without hard-coded pixels.
 */
export function HeaderHeightVar() {
  useEffect(() => {
    const header = document.querySelector("body > header, header.sticky");
    if (!header) return;
    const set = () => document.documentElement.style.setProperty("--site-header-h", `${Math.round(header.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(header);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--site-header-h");
    };
  }, []);
  return null;
}
