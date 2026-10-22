import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  // the client's schema is generated from the OpenAPI document
  { ignores: ["**/node_modules/**", "**/dist/**", "apps/harness/results/**", "packages/client/src/schema.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
  },
);
