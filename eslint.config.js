const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");

const tsRecommended = tsPlugin.configs["recommended"];

module.exports = [
  {
    files: ["**/*.ts"],
    ignores: ["dist/**", "vendor/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsRecommended.rules,
    },
  },
];
