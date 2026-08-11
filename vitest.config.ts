import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // No test may reach Azure or spend tokens. The LLM is always mocked.
    testTimeout: 15_000,
  },
});
