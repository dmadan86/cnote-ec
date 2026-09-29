import { EMBEDDING_DIM } from "@cnote/db";
import { tokenize } from "./text";
import type { Embedder } from "./types";

export const EMBEDDER_VERSION = "hash-v1";

/** FNV-1a 32-bit followed by murmur3 fmix32 so the low bits (bucket) and bit 16 (sign) are well mixed. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const W_UNI = 1.0;
const W_BI = 0.8;
const W_CHAR = 0.2; // char n-grams add typo/morphology tolerance without swamping word matches

function add(v: Float64Array, feature: string, weight: number) {
  const h = hash32(feature);
  v[h % EMBEDDING_DIM]! += (h & 0x10000 ? 1 : -1) * weight; // signed hashing keeps collisions zero-mean
}

/** Deterministic feature-hashing embedding (ADR-008: local, vendor-free; swap behind `Embedder` later). */
export function embedText(text: string): number[] {
  const v = new Float64Array(EMBEDDING_DIM);
  const toks = tokenize(text);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    add(v, "u:" + t, W_UNI);
    if (i + 1 < toks.length) add(v, "b:" + t + " " + toks[i + 1], W_BI);
    if (!/^\d+$/.test(t) && t.length >= 3) {
      const p = `^${t}$`;
      for (let n = 3; n <= 5; n++) {
        for (let j = 0; j + n <= p.length; j++) add(v, "c:" + p.slice(j, j + n), W_CHAR);
      }
    }
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  if (norm === 0) { v[hash32("__empty__") % EMBEDDING_DIM] = 1; norm = 1; } // pgvector cosine rejects zero vectors
  const inv = 1 / Math.sqrt(norm);
  return Array.from(v, (x) => x * inv);
}

export const localEmbedder: Embedder = {
  version: EMBEDDER_VERSION,
  async embed(texts) {
    return texts.map(embedText);
  },
};
