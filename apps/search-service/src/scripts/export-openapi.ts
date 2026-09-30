import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildOpenApi } from "../openapi";

const out = path.resolve(import.meta.dirname, "../../../../docs/design/search-service.openapi.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(buildOpenApi(), null, 2) + "\n");
console.log(`wrote ${out}`);
