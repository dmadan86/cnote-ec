import { mergeConfig } from "vitest/config";
import { packageConfig } from "../../vitest.shared";

// The ONDC kill switch (`ondc_controls`) is a global singleton that live.db.test.ts flips on and off; every other DB file that
// publishes or processes while it is on would silently skip. DB files therefore must not run concurrently.
export default mergeConfig(packageConfig({ lines: 90, branches: 80, functions: 90, statements: 90 }), { test: { fileParallelism: false } });
