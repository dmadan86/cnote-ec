import { mergeConfig } from "vitest/config";
import { packageConfig } from "../../vitest.shared";

export default mergeConfig(packageConfig({ lines: 85, branches: 75, functions: 85, statements: 85 }), { test: { fileParallelism: false } });
