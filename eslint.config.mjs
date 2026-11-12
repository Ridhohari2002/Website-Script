import next from "eslint-config-next";

export default [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "coverage/**",
      "*.config.mjs",
      "next-env.d.ts",
    ],
  },
  ...next,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // Every network boundary validates its own input; unused args are noise.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["test/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
];
