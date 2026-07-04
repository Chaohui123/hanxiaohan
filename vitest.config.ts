import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/tests/**/*.test.ts",
      "apps/*/tests/**/*.test.ts",
      "apps/*/tests/services/*.test.ts",
      "apps/*/tests/middleware/*.test.ts",
      "apps/*/src/services/tests/*.test.ts",
    ],
    globals: true,
    coverage: {
      provider: "v8",
      include: [
        "packages/ai/src/**/*.ts",
        "packages/scraper/src/**/*.ts",
        "packages/ozon-order/src/**/*.ts",
        "packages/ozon-api-wrapper/src/**/*.ts",
        "apps/api-services/src/services/**/*.ts",
        "apps/api-services/src/middleware/**/*.ts",
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 55,
        lines: 60,
      },
      reporter: ["text", "lcov"],
    },
  },
});
