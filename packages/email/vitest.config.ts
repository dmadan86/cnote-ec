import { packageConfig } from "../../vitest.shared";

// The module's logic lives in src/index.ts, which the shared config excludes as a barrel file.
const config = packageConfig({ lines: 97, branches: 93, functions: 100, statements: 97 });
config.test!.coverage!.exclude = ["src/**/*.d.ts"];
export default config;
