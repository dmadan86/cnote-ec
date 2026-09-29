import { packageConfig } from "../../vitest.shared";

// The whole package lives in src/index.ts, which the shared config excludes as a barrel file.
const config = packageConfig({ lines: 100, branches: 95, functions: 100, statements: 100 });
config.test!.coverage!.exclude = ["src/**/*.d.ts"];
export default config;
