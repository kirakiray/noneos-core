import { defineConfig } from "rollup";
// import nodeResolve from '@rollup/plugin-node-resolve';
// import commonjs from '@rollup/plugin-commonjs';

export default defineConfig({
  input: "sw/src/main.js",
  output: {
    file: "sw/dist.js",
    format: "iife",
    sourcemap: true,
  },
  plugins: [
    // nodeResolve(),
    // commonjs()
  ],
  watch: {
    include: "sw/src/**",
  },
});
