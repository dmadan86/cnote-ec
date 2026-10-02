import { mergeConfig } from "vitest/config";
import { packageConfig } from "../../vitest.shared";

// quality.db.test.ts resets the global `quality_categories` allow-list (the first enabled category becomes the pilot), so
// its DB files must not run concurrently with the others.
export default mergeConfig(packageConfig({ lines: 90, branches: 80, functions: 90, statements: 90 }), { test: { fileParallelism: false } });
