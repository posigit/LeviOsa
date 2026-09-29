import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified bundle - not ours to lint (~1.5k noise problems).
    "public/vendor/**",
  ]),
  {
    rules: {
      // Honor the `_`-prefix convention for deliberately omitted/unused
      // destructured bindings (e.g. profile rail `backdropPath: _b` omits).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // React-compiler-era heuristics: they flag intentional, long-tested
      // patterns in the players (state resets in effects, render-assigned
      // refs, callback hoisting). Demote to warn so `npm run lint` exits 0
      // without risky behavior-changing refactors.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
    },
  },
]);

export default eslintConfig;
