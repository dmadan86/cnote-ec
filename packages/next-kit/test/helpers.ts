import { vi } from "vitest";

/** In-memory next/headers cookie jar + header bag shared by tests. */
export function makeJar() {
  const map = new Map<string, string>();
  const sets: Array<Record<string, unknown>> = [];
  const store = {
    get: (n: string) => (map.has(n) ? { name: n, value: map.get(n)! } : undefined),
    set: vi.fn((o: { name: string; value: string }) => {
      map.set(o.name, o.value);
      sets.push(o);
    }),
    delete: vi.fn((n: string) => void map.delete(n)),
  };
  return { map, sets, store };
}
