/**
 * Projects the seeded authoring listings into the live (CQRS read) database, exactly like the worker would.
 * Lives outside any workspace package, so workspace packages are resolved from apps/worker (the composition root).
 * Run through tsx with DATABASE_URL / LIVE_DATABASE_URL already exported (see e2e/setup/global-setup.ts).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const req = createRequire(path.resolve(__dirname, "../../apps/worker/package.json"));
const load = <T>(id: string) => import(pathToFileURL(req.resolve(id)).href) as Promise<T>;

async function main() {
  const catalogue = await load<{ backfillLiveListings(): Promise<unknown> }>("@cnote/catalogue");
  const res = await catalogue.backfillLiveListings();
  console.log("[e2e] live projection", JSON.stringify(res));
  // Redis handles from the cache layer would otherwise keep the process alive.
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
