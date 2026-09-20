import { defineConfig } from "vitest/config";

// Pure-logic unit tests run in node (no DOM needed). Colocated *.test.ts under src.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
});
