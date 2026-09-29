// Process approved listing images that have no derivatives yet.
//   pnpm --filter @cnote/catalogue images:backfill            (inline; default 500 per run)
//   pnpm --filter @cnote/catalogue images:backfill -- --limit 100 --enqueue   (hand off to the worker queue)
import { backfillImageVariants } from "../src/image-variants";

const args = process.argv.slice(2);
const li = args.indexOf("--limit");
const limit = li >= 0 ? Number(args[li + 1]) : 500;
const result = await backfillImageVariants({ limit: Number.isFinite(limit) && limit > 0 ? limit : 500, inline: !args.includes("--enqueue") });
console.log(JSON.stringify(result));
process.exit(result.failed ? 1 : 0);
