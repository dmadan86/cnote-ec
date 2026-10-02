import { mergeConfig } from "vitest/config";
import { packageConfig } from "../../vitest.shared";

// Serial files: processPayouts()/runAutoRelease() sweep every due row in the table, so a sweep from one file settles payouts another
// file is about to assert on (and trialBalance() is global). Same approach as catalogue/quality/ondc/credit.
export default mergeConfig(packageConfig({ lines: 90, branches: 80, functions: 90, statements: 90 }), { test: { fileParallelism: false } });
