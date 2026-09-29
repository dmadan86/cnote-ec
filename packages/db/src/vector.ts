/** Dimension of the default embedding space. Changing it requires a migration + re-index (embedding_version). */
export const EMBEDDING_DIM = 256;

/** Serialise an embedding for `$queryRaw`/`$executeRaw`: `${toVectorLiteral(v)}::vector`. */
export function toVectorLiteral(v: number[]): string {
  if (v.length !== EMBEDDING_DIM) throw new Error(`expected ${EMBEDDING_DIM}-dim vector, got ${v.length}`);
  return `[${v.join(",")}]`;
}
