import { packageConfig } from "../../vitest.shared";

const base = packageConfig({ lines: 97, branches: 95, functions: 98, statements: 97 });

// Client-only React components (need a DOM/browser: "use client" forms, widgets, dialogs) are excluded here;
// their server actions and pure logic are unit-tested, the UI itself is covered by later browser/e2e tests.
export default {
  ...base,
  test: {
    ...base.test,
    coverage: {
      ...base.test!.coverage,
      exclude: [...(base.test!.coverage!.exclude as string[]), "src/client.ts", "src/**/*-client.tsx", "src/forms.tsx", "src/consent/**"],
    },
  },
};
