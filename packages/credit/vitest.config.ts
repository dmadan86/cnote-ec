import { mergeConfig } from "vitest/config";
import { packageConfig } from "../../vitest.shared";

// Serial files: the loan-book jobs (expire-offers, nightly-scores, update-dpd) sweep the WHOLE table, so a job run in
// book.db.test.ts would expire back-dated offers or re-score businesses that credit.db.test.ts is mid-test on.
export default mergeConfig(packageConfig({ lines: 90, branches: 80, functions: 90, statements: 90 }), { test: { fileParallelism: false } });
