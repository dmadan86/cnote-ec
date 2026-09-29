import path from "node:path";
import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";

config({ path: path.resolve(import.meta.dirname, "../../.env.local") });
config({ path: path.resolve(import.meta.dirname, "../../.env") });

// The LIVE read database: a separate Postgres (own migrations, own generated client). It holds only
// published projections and can live on another cluster/cloud; nothing here references the authoring DB.
export default defineConfig({
  schema: "prisma/schema",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("LIVE_DATABASE_URL") },
});
