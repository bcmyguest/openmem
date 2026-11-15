import js from "@eslint/js";

/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: [
      "node_modules/**",
      "wizard/node_modules/**",
      "site/**",
      "site/dist/**",
      ".venv/**",
      "**/__pycache__/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        structuredClone: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        FormData: "readonly",
        Blob: "readonly",
      },
    },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // Sanitizers strip control characters on purpose.
      "no-control-regex": "off",
      // Literal spaces mirror the YAML indentation the patterns match.
      "no-regex-spaces": "off",
    },
  },
];
