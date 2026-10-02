"use client";
import { useEffect } from "react";

/**
 * Registers /sw.js after load, in production only (a worker would get in the way of hot reload in development, and
 * e2e runs the production build, which is where it is meant to be exercised). Failure is silent: the site works the same
 * without a worker. The worker caches no personal data (see src/features/pwa/sw-rules.ts), so it needs no consent entry.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const register = () => void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined);
    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);
  return null;
}
