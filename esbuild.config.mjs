// Bundles the plugin into a single CommonJS main.js, which is what Obsidian
// loads.
//
// Self-contained on purpose. Sharing this file across the three plugins would
// mean the shared copy had to live outside every plugin folder, where `esbuild`
// is not installed -- and a plugin that cannot be built on its own defeats the
// reason for splitting them up. The duplication is ~40 lines and the externals
// list is the only part that must not drift.
//
// `obsidian`, Electron and the CodeMirror packages stay external: Obsidian
// injects them at runtime, and bundling them would both bloat the file and
// break. The shared sfc-sdk sources ARE bundled in, from ../sdk/src,
// because a plugin must never require another plugin at runtime.
//
// `builtin-modules` lists Node's builtins by their bare names (`http`), and the
// bundle imports the prefixed spelling (`node:http`), which that list does not
// contain -- so the prefixed form has to be added explicitly. Without it esbuild
// tries to resolve the builtin as a package and the build fails with "Are you
// trying to bundle for node?", which reads like a platform mistake rather than a
// missing externals entry.
import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");
const nodeBuiltins = [...builtins, ...builtins.map((name) => `node:${name}`)];

const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  target: "es2021",
  platform: "browser",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  logLevel: "info",
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...nodeBuiltins,
  ],
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("watching src/ ...");
} else {
  await esbuild.build(options);
}