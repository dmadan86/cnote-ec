import { mergeConfig } from "vitest/config";
import { packageConfig } from "../../vitest.shared";

// DB test files share one period's benchmark rows (a run replaces the period), so they must not run concurrently.
export default mergeConfig(packageConfig({ lines: 90, branches: 80, functions: 90, statements: 90 }), { test: { fileParallelism: false } });
