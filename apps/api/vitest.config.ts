import { packageConfig } from "../../vitest.shared";

// server.ts (process entry) and scripts/export-openapi.ts are not unit-testable, which caps achievable coverage.
export default packageConfig({ lines: 93, branches: 80, functions: 90, statements: 90 });
