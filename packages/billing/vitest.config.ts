import { mergeConfig } from "vitest/config";
import { packageConfig } from "../../vitest.shared";

// Serial files: the billing sweeps (expireLapsedCredits, grantDueAnnualCredits, endLapsedSubscriptions, retryDueRefunds) touch every
// business in the table, so one file could write ledger rows for another file's businesses in the middle of its cleanup (FK violation).
export default mergeConfig(packageConfig({ lines: 96, branches: 90, functions: 95, statements: 96 }), { test: { fileParallelism: false } });
