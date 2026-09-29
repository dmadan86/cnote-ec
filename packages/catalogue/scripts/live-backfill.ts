// Projects every listing that is already published + approved in the authoring DB into the LIVE read DB as
// version 1 (idempotent: listings that already have a live version are skipped).
//   pnpm --filter @cnote/catalogue live:backfill
// Run after `pnpm db:seed` and after migrating LIVE (`pnpm --filter @cnote/live-db migrate:deploy`).
import { backfillLiveListings } from "../src/live";

const started = Date.now();
const r = await backfillLiveListings();
console.log(`live backfill: ${r.projected} projected, ${r.skipped} skipped in ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(0);
