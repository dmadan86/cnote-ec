import { packageConfig } from "../../vitest.shared";

// Staff tests mutate the global set of active super_admins (last-super-admin guard), so files run serially.
const config = packageConfig({ lines: 95, branches: 90, functions: 90, statements: 95 });
config.test = { ...config.test, fileParallelism: false };
export default config;
