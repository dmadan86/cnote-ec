import { mergeConfig } from "vitest/config";
import { packageConfig } from "../../vitest.shared";

// DB files must not run concurrently: versions.db.test.ts runs publishDueVersions() (a global sweep that takes any approved
// version in the DB live), the draft-from-text/photo/voice fallback picks the first category in the DB, and the shared
// categories cache is rebuilt from whatever rows exist. Each of those reaches into other files' fixtures.
export default mergeConfig(packageConfig({ lines: 96, branches: 87, functions: 92, statements: 92 }), { test: { fileParallelism: false } });
