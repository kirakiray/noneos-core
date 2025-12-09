import { defineConfig } from 'rollup';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default defineConfig({
  input: 'sw/main.js',
  output: {
    file: 'sw.js',
    format: 'iife'
  },
  plugins: [
    nodeResolve(),
    commonjs()
  ]
});