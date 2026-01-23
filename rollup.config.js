import { defineConfig } from "rollup";
import terser from "@rollup/plugin-terser";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));

export default defineConfig({
  input: "sw/src/main.js",
  output: [
    {
      file: "sw/dist.js",
      format: "iife",
      sourcemap: true,
      banner: `/* noneos-core version: ${pkg.version} */`,
    },
    {
      file: "sw/dist.min.js",
      format: "iife",
      sourcemap: true,
      banner: `/* noneos-core version: ${pkg.version} */`,
      plugins: [
        terser({
          format: {
            comments: /version:/,
          },
        }),
      ],
    },
  ],
  watch: {
    include: "sw/src/**",
  },
});
