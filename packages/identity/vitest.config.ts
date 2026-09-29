import { packageConfig } from "../../vitest.shared";

// Security-critical package: thresholds sit at the achieved level so coverage cannot silently regress.
export default packageConfig({ lines: 99, branches: 96, functions: 99, statements: 99 });
