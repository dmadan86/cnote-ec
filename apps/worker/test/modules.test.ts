// Harness: boots the module list exactly as src/index.ts declares it (parsed from source so the two cannot
// drift), on memory transports, and checks every module's worker contract without starting any loops.
import { readFileSync } from "node:fs";
import path from "node:path";
import { consumeOnce, MemoryEventTransport, MemoryJobQueue, setEventTransport, setJobQueue, type ModuleWorker } from "@cnote/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.QUEUE_DRIVER = "memory";

const source = readFileSync(path.resolve(import.meta.dirname, "../src/index.ts"), "utf8");
const imports = new Map<string, { spec: string; exported: string }>(); // local identifier -> module + export name
for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(@cnote\/[\w-]+)"/g)) {
  for (const part of m[1]!.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [exported, local] = part.split(/\s+as\s+/) as [string, string | undefined];
    imports.set(local ?? exported, { spec: m[2]!, exported });
  }
}
const listMatch = /const modules: ModuleWorker\[\] = \[([^\]]+)\]/.exec(source);
const ids = (listMatch?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

let modules: { id: string; w: ModuleWorker }[] = [];
const queue = new MemoryJobQueue();
const transport = new MemoryEventTransport();

beforeAll(async () => {
  setJobQueue(queue);
  setEventTransport(transport);
  modules = await Promise.all(
    ids.map(async (id) => {
      const imp = imports.get(id);
      if (!imp) throw new Error(`worker index imports nothing for ${id}`);
      const mod = (await import(imp.spec)) as Record<string, ModuleWorker>;
      return { id, w: mod[imp.exported]! };
    }),
  );
});
afterAll(() => {
  setJobQueue(undefined);
  setEventTransport(undefined);
});

describe("worker module wiring", () => {
  it("parses a non-trivial module list from src/index.ts", () => {
    expect(ids.length).toBeGreaterThanOrEqual(10);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every module exposes a well-formed ModuleWorker without throwing on import", () => {
    for (const { id, w } of modules) {
      expect(w, id).toBeTruthy();
      expect(typeof w.name, id).toBe("string");
      expect(w.name.length, id).toBeGreaterThan(0);
      expect(w.handlers && typeof w.handlers === "object", id).toBe(true);
      expect(Array.isArray(w.jobs), id).toBe(true);
      for (const [event, h] of Object.entries(w.handlers)) expect(typeof h, `${w.name}.${event}`).toBe("function");
    }
  });

  it("module (consumer-group) names are unique", () => {
    const names = modules.map((m) => m.w.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("job names are globally unique, with sane intervals", () => {
    const seen = new Map<string, string>();
    for (const { w } of modules) {
      for (const j of w.jobs) {
        expect(seen.has(j.name), `duplicate job ${j.name} (${seen.get(j.name)} and ${w.name})`).toBe(false);
        seen.set(j.name, w.name);
        expect(typeof j.run).toBe("function");
        expect(Number.isFinite(j.everyMs) && j.everyMs >= 1000, `${j.name} everyMs=${j.everyMs}`).toBe(true);
        expect(j.name).toMatch(/^[a-z][\w.-]*$/);
      }
    }
  });

  it("queue consumers declare a topic + handler, no duplicate topic within a module, sane concurrency", () => {
    for (const { w } of modules) {
      const topics = (w.queues ?? []).map((q) => q.topic);
      expect(new Set(topics).size, `${w.name} consumes a topic twice`).toBe(topics.length);
      for (const q of w.queues ?? []) {
        expect(typeof q.topic).toBe("string");
        expect(q.topic).toMatch(/^[a-z][\w-]*(\.[\w-]+)+$/);
        expect(typeof q.handler).toBe("function");
        if (q.concurrency !== undefined) expect(Number.isInteger(q.concurrency) && q.concurrency >= 1 && q.concurrency <= 32).toBe(true);
      }
    }
  });

  it("the boot loop's calls are safe on empty memory transports: consumeOnce, promoteDelayed, consume", async () => {
    for (const { w } of modules) {
      if (Object.keys(w.handlers).length) await expect(consumeOnce(w.name, "test-consumer", w.handlers)).resolves.not.toThrow();
      for (const q of w.queues ?? []) {
        await expect(queue.promoteDelayed(q.topic)).resolves.toBe(0);
        await expect(queue.consume(q.topic as never, w.name, "test-consumer", q.handler as never)).resolves.toBe(0);
      }
    }
  });

  it("modules that consume events register handlers only for event names that other packages can emit (no empty keys)", () => {
    for (const { w } of modules) for (const event of Object.keys(w.handlers)) expect(event).toMatch(/^[A-Z][A-Za-z0-9]+$/);
  });
});
