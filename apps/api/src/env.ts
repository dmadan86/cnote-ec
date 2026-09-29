export const config = {
  port: Number(process.env.PORT ?? 3003),
  publicUrl: (process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3003}`).replace(/\/$/, ""),
  corsOrigins: (process.env.API_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  /** Requests per key per minute (REST + MCP combined). */
  ratePerMinute: Number(process.env.API_RATE_LIMIT_PER_MIN ?? 120),
};
export const API_VERSION = "1.0.0";
