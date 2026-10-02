import { mergeConfig } from "vitest/config";
import { packageConfig } from "../../vitest.shared";

// Serial files: expireOverdueOffers() sweeps every overdue offer in the table, so a sweep in one file can expire (and cascade)
// offers another file has just back-dated, or catch a cascade half-done. Same approach as catalogue/quality/ondc.
export default mergeConfig(packageConfig({ lines: 97, branches: 92, functions: 96, statements: 96 }), { test: { fileParallelism: false } });
