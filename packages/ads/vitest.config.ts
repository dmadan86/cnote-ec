import { packageConfig } from "../../vitest.shared";

// Ads tests share Redis keys (snapshot, kill switches) and sweep every campaign in the test DB, so files run one at a time.
const base = packageConfig({ lines: 90, branches: 80, functions: 90, statements: 90 });
export default { ...base, test: { ...base.test, fileParallelism: false, env: { ADS_TOKEN_SECRET: "test-secret" } } };
