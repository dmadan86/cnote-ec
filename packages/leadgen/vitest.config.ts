import { packageConfig } from "../../vitest.shared";

const config = packageConfig({ lines: 97, branches: 92, functions: 97, statements: 97 });
// The abandonment sweep and the retention purge both act on ALL stale captures in the shared test DB (as they do in
// production); running files in parallel lets one test's sweep touch another test's rows mid-assertion.
config.test = { ...config.test, fileParallelism: false };
export default config;
