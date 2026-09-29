import { cached, redis } from "@cnote/core";

// Published versions are immutable, so version content is cached by version id and never needs busting.
// Pointers (which version is live) are cached briefly and DELETED on publish/rollback/enable/layout change.
export const PTR_TTL = 300;
export const VERSION_TTL = 86_400;

export const tplPtrKey = (key: string, channel: string, locale: string) => `tpl:ptr:${key}:${channel}:${locale}`;
export const layoutPtrKey = (layoutKey: string) => `tpl:layout-ptr:${layoutKey}`;
export const tplVersionKey = (id: string) => `tpl:v:${id}`;
export const layoutVersionKey = (id: string) => `tpl:lv:${id}`;

/** Redis is an optimisation: when it is unavailable we read straight from the database. */
export async function softCached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  try {
    return await cached(key, ttl, load);
  } catch (e) {
    if (e instanceof Error && /redis|connection|ECONN|Stream isn't writeable|max retries/i.test(e.message)) return load();
    throw e;
  }
}

export async function bust(...keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    await redis.del(...keys);
  } catch (e) {
    console.error("[templates] cache bust failed", e);
  }
}
