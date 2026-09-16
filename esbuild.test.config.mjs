// Compiles the Obsidian-free parts to plain ESM so `node --test` can import
// them directly. Only modules with no `obsidian` import may be bundled here:
// stubbing the Obsidian API would only test the stub.
//
// The list is **discovered**, not written by hand. A hand-written list was how a
// new module's tests would silently stop running: the module was added, the tests
// were added, the suite stayed green, and nothing said the module had never been
// built or run. Discovery cannot forget -- it found `obsidianFs.ts` on its first
// run, which had never been listed, and which imports Node's `fs`.
//
// A module declares that it needs Obsidian (or a Node builtin) by importing it,
// and is then skipped -- and named below, with the reason, so "not tested" is
// visible rather than implied. A module that reaches either only *transitively*
// fails the build with `Could not resolve "obsidian"`, which is the intended
// signal: the seam has to be explicit, because the caller is what the tests
// substitute.
import fs from "node:fs";
import builtins from "builtin-modules";
import esbuild from "esbuild";

const SPECIFIER = /(?:\bfrom\s*|^\s*import\s*|\brequire\(\s*)["']([^"']+)["']/gm;
const BUILTINS = new Set([...builtins, "obsidian"]);

/** Why this module cannot be bundled for `node --test`, or null when it can. */
function externalReason(text) {
  for (const match of text.matchAll(SPECIFIER)) {
    const name = match[1];
    if (name.startsWith("node:") || BUILTINS.has(name)) {
      return name === "obsidian" ? "obsidian" : `node builtin ${name}`;
    }
  }
  return null;
}

const entryPoints = [];
const skipped = [];
for (const name of fs.readdirSync("src").sort()) {
  if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
  const reason = externalReason(fs.readFileSync(`src/${name}`, "utf8"));
  if (reason) skipped.push(`${name} (${reason})`);
  else entryPoints.push(`src/${name}`);
}

await esbuild.build({
  entryPoints,
  bundle: true,
  outdir: ".build",
  format: "esm",
  target: "es2021",
  platform: "neutral",
  logLevel: "info",
});

console.log(`test bundles: ${entryPoints.length} module(s). Skipped, so exercised only inside Obsidian:`);
for (const item of skipped) console.log(`  - ${item}`);
