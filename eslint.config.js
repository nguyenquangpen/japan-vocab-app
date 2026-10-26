import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src-tauri"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Quy tắc an toàn trong CLAUDE.md: nội dung dán vào chỉ hiển thị dạng text thuần.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Cấm dangerouslySetInnerHTML: hiển thị nội dung dạng text thuần.",
        },
        {
          selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]",
          message: "Cấm innerHTML/outerHTML: dùng textContent hoặc JSX.",
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: "Cấm insertAdjacentHTML.",
        },
      ],
    },
  },
  {
    // Code giao diện không được dùng module của Node (chỉ test mới dùng).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.ts", "src/db/nodeSqliteDb.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["node:*", "**/nodeSqliteDb"] }],
    },
  },
);
