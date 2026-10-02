// Token and latency metering for real-provider eval runs. Wraps the Anthropic client so nothing in src/ changes.
import type { MessagesClient } from "../src/anthropic";
import type { Usage } from "./metrics";

/** USD per million tokens (Anthropic list prices, cached 2026-09). Cache reads cost 0.1x input; 5-minute cache writes 1.25x. */
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

export function priceCall(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.input * 0.1 + u.cacheWrite * p.input * 1.25) / 1_000_000;
}

export class Meter {
  current: string | null = null;
  readonly usage: Record<string, Usage> = {};
  readonly models = new Set<string>();
  readonly unpriced = new Set<string>();

  record(model: string, u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined) {
    const cap = this.current ?? "other";
    const line = (this.usage[cap] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, usd: 0 });
    const t = { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0 };
    line.calls++;
    line.inputTokens += t.input; line.outputTokens += t.output; line.cacheReadTokens += t.cacheRead; line.cacheWriteTokens += t.cacheWrite;
    this.models.add(model);
    const usd = priceCall(model, t);
    if (usd === null) { this.unpriced.add(model); line.usd = null; } else if (line.usd !== null) line.usd += usd;
  }

  wrap(client: MessagesClient): MessagesClient {
    return {
      messages: {
        create: (async (params: { model: string }, options: unknown) => {
          const res = await (client.messages.create as (p: unknown, o: unknown) => Promise<{ usage?: Parameters<Meter["record"]>[1] }>)(params, options);
          this.record(params.model, res.usage);
          return res;
        }) as unknown as MessagesClient["messages"]["create"],
      },
    };
  }
}
