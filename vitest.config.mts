import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(process.cwd()),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["lib/**/*.ts", "app/api/**/route.ts"],
      exclude: ["lib/types.ts"],
      reportOnFailure: true,
      // 第七阶段基线约为 statements 62% / branches 52% / functions 66% / lines 65%。
      // 设置略低于基线的门槛，防止覆盖率大幅回退，同时避免平台差异造成误报。
      thresholds: {
        statements: 60,
        branches: 48,
        functions: 62,
        lines: 62,
      },
    },
  },
});
