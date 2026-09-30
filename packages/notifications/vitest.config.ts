import { packageConfig } from "../../vitest.shared";

const config = packageConfig({ lines: 94, branches: 90, functions: 87, statements: 94 });
// The prune-read job and the retention purge both act on ALL old read notifications in the shared test DB (as in
// production); running files in parallel lets one file's prune delete another file's rows mid-assertion.
config.test = { ...config.test, fileParallelism: false };
export default config;
