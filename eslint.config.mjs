import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  {
    // React Compiler 新规则：现有数据加载 effect 会在 effect 内同步 setState。
    // 重构这些 UI 状态属于独立任务，本轮保留为 warning，避免掩盖真实 lint 错误。
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "data/**",
    "next-env.d.ts",
    "*.tsbuildinfo",
  ]),
]);
