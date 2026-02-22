/**
 * esbuild bundler — produces a single dist/index.js with all dependencies inlined.
 *
 * Eliminates the need for `npm install` at plugin install time.
 * openclaw/plugin-sdk is kept external (peer dependency provided by the host).
 */
import esbuild from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

await esbuild.build({
  entryPoints: ["index.ts"],
  bundle: true,
  outfile: "dist/index.js",
  format: "esm",
  platform: "node",
  target: "es2022",
  external: ["openclaw", "openclaw/*"],
  sourcemap: true,
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pkg.version),
    __PACKAGE_NAME__: JSON.stringify(pkg.name),
  },
});

console.log(`Built dist/index.js (${pkg.name}@${pkg.version})`);
