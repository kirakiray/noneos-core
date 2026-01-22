import { defineConfig } from "rollup";
import terser from "@rollup/plugin-terser";

export default defineConfig({
  input: "sw/src/main.js",
  output: {
    file: "sw/dist.js",
    format: "iife",
    sourcemap: true,
  },
  plugins: [
    terser()
  ],
  watch: {
    include: "sw/src/**",
  },
});
