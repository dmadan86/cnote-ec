import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createApp, openApiConfig } from "../app";

// Uses a fixed public URL placeholder unless API_PUBLIC_URL is set, so the committed file is stable.
const out = path.resolve(import.meta.dirname, "../../../../docs/api/openapi.json");
const spec = createApp().getOpenAPI31Document(openApiConfig());
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(spec, null, 2) + "\n");
console.log(`wrote ${out} (${Object.keys(spec.paths ?? {}).length} paths)`);
process.exit(0); // ioredis (via @cnote/core) keeps the loop alive
