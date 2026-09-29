import { packageConfig } from "../../vitest.shared";

// The worker entry (src/index.ts) is a composition root with process-level side effects and is excluded
// from coverage; the harness test checks the module wiring it consumes. No coverage gate applies.
export default packageConfig({ lines: 0, branches: 0, functions: 0, statements: 0 });
