export interface AiServiceConfig {
  port: number;
  /** AI_SERVICE_TOKEN_SECRET; comma-separated keys allow rotation (first signs, all verify). */
  tokenSecret: string;
  /** concurrent capability calls before the service sheds load with 503 (clients then fall back / the HPA scales out) */
  maxInflight: number;
  /** request body cap; photos/audio travel as base64 JSON */
  maxBodyBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AiServiceConfig {
  const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    port: n(env.PORT, 3005),
    tokenSecret: env.AI_SERVICE_TOKEN_SECRET ?? "",
    maxInflight: n(env.AI_SERVICE_MAX_INFLIGHT, 64),
    maxBodyBytes: n(env.AI_SERVICE_MAX_BODY_BYTES, 24 * 1024 * 1024),
  };
}
