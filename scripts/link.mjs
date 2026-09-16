// Copy the built plugin into a vault's plugin folder.
//
//   node scripts/link.mjs "F:\\Study\\Anki"
//
// A copy rather than a symlink on purpose: the target is often on a different
// drive, and on Windows a symlink needs either elevation or developer mode.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const vault = process.argv[2];
if (!vault) {
  console.error("usage: node scripts/link.mjs <vault-root>");
  process.exit(2);
}

const here = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8"));
const target = path.join(vault, ".obsidian", "plugins", manifest.id);

fs.mkdirSync(target, { recursive: true });
for (const file of ["manifest.json", "main.js", "styles.css"]) {
  const source = path.join(here, file);
  if (!fs.existsSync(source)) {
    console.warn(`skip ${file}: not built yet (run npm run build)`);
    continue;
  }
  fs.copyFileSync(source, path.join(target, file));
  console.log(`copied ${file} -> ${target}`);
}
console.log(`\nEnable "${manifest.name}" in Settings -> Community plugins.`);