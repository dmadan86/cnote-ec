import path from "node:path";
import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";

config({ path: path.resolve(import.meta.dirname, "../../.env.local") });
config({ path: path.resolve(import.meta.dirname, "../../.env") });

export default defineConfig({
  // Multi-file schema: one file per module under prisma/schema/ (ADR-006 module ownership).
  schema: "prisma/schema",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  datasource: { url: env("DATABASE_URL") },
});
