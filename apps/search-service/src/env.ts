export interface SearchServiceConfig {
  port: number;
  /** SEARCH_SERVICE_TOKEN_SECRET; comma-separated keys allow rotation (first signs, all verify). */
  tokenSecret: string;
  maxInflight: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SearchServiceConfig {
  const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return { port: n(env.PORT, 3006), tokenSecret: env.SEARCH_SERVICE_TOKEN_SECRET ?? "", maxInflight: n(env.SEARCH_SERVICE_MAX_INFLIGHT, 128) };
}
