import { defineConfig } from "rollup";
import terser from "@rollup/plugin-terser";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));

// 把根证书中未退役的密钥公钥注入 SW，用作 nos-lib.json 的信任锚。
// 每次 transform 时重新读取，保证 watch 模式下轮换密钥后也能生效。
const injectNosLibPins = {
  name: "inject-noslib-pins",
  transform(code, id) {
    if (!id.endsWith("noslib-verify.js")) return null;
    if (!code.includes("__NOSLIB_PINNED_KEYS__")) return null;
    const rootCert = JSON.parse(
      readFileSync(join(__dirname, "nos/root-cert.json"), "utf-8"),
    );
    const pinned = rootCert.keys
      .filter((key) => key.status !== "retired")
      .map((key) => key.publicKey);
    return {
      code: code.replace("__NOSLIB_PINNED_KEYS__", JSON.stringify(pinned)),
      map: null,
    };
  },
};

export default defineConfig({
  input: "sw/src/main.js",
  plugins: [injectNosLibPins],
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
