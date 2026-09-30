import { packageConfig } from "../../vitest.shared";

const config = packageConfig({ lines: 90, branches: 80, functions: 90, statements: 90 });
// Process entry (signals, listen) and the OpenAPI export script are exercised by running the service, not by unit tests.
const cov = (config as { test: { coverage: { exclude: string[] } } }).test.coverage;
cov.exclude = [...cov.exclude, "src/server.ts", "src/scripts/**"];

export default config;
