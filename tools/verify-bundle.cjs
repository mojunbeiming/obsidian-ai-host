// Shared bundle verifier for all sfc-* plugins.
//
// The invariant is twofold, and the host migration is what split it:
//
//   * **the host** (`sfc-ai`) is the only bundle allowed to open a socket or
//     name a remote endpoint. Its checks assert the HTTP clients are present,
//     the declared hosts are the only remote hosts, and the credential fields
//     are read through typeof guards.
//   * **a domain plugin** must contain *no* network path at all: no Node HTTP
//     client, no remote hostname, no credential header. Its model calls go
//     through the host's published API, which is a registry lookup, not a
//     socket.
//
// Every bundle still has to prove it is wired into the shared registry and does
// not `require` a sibling: the plugins work alone, and the contract is the
// registry key.
//
// Usage from a plugin folder: `node scripts/verify-bundle.cjs`, where that
// script is a two-line delegate to this file.
const fs = require("node:fs");
const path = require("node:path");

const root = process.env.SFC_PLUGIN_ROOT || process.cwd();
const bundle = path.join(root, "main.js");
const manifestPath = path.join(root, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error(`FAIL: no manifest.json in ${root}; run this from a plugin folder`);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const isHost = manifest.id === "sfc-ai";

if (!fs.existsSync(bundle)) {
  console.error("FAIL: main.js does not exist (run npm run build)");
  process.exit(1);
}

const source = fs.readFileSync(bundle, "utf8");
const problems = [];
const SIBLINGS = ["sfc-flashcards", "sfc-todo", "sfc-checkin"].filter((id) => id !== manifest.id);

if (source.length < 2000) problems.push(`main.js is suspiciously small (${source.length} bytes)`);
if (!/module\.exports/.test(source)) problems.push("main.js has no CommonJS export");
if (!source.includes(manifest.id)) problems.push(`main.js never mentions its own plugin id "${manifest.id}"`);
if (!/require\(["']obsidian["']\)/.test(source)) problems.push("main.js does not require the obsidian module (was it inlined?)");
if (!source.includes("sfcRegistry")) problems.push("main.js does not carry the shared registry key; the SDK may not be bundled");
for (const other of SIBLINGS) {
  if (new RegExp(`require\\(["']${other}["']\\)`).test(source)) problems.push(`main.js requires the sibling plugin "${other}"`);
}
if (/getPlugin\(/.test(source)) problems.push("main.js calls Obsidian's private getPlugin(); the registry is the contract");

// APIs that would make a request the transport does not know about.
for (const pattern of [/requestUrl\(/, /navigator\.sendBeacon/, /new\s+WebSocket/]) {
  if (pattern.test(source)) problems.push(`main.js contains a network path matching ${pattern}`);
}
if (/(^|[^.\w])fetch\s*\(/.test(source)) problems.push("main.js calls fetch(); the transport uses node:http instead");
// XMLHttpRequest is the host transport's mobile carrier. A domain bundle must
// not carry it at all: on a phone its model calls still go through the host,
// which owns both carriers and the platform branch that chooses between them.
if (/XMLHttpRequest/.test(source) && !isHost) {
  problems.push("main.js contains XMLHttpRequest; only the host transport may use the browser carrier");
}

// The hosts the provider table declares; only the host may carry them.
const ALLOWED_HOSTS = ["api.deepseek.com", "api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com"];
const REMOTE_URL = /https?:\/\/([a-z0-9.-]+)/gi;
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1)$/i;

const unknownHosts = [];
for (const match of source.matchAll(REMOTE_URL)) {
  const host = match[1].toLowerCase();
  if (LOOPBACK.test(host)) continue;
  if (isHost && ALLOWED_HOSTS.includes(host)) continue;
  if (!unknownHosts.includes(host)) unknownHosts.push(host);
}
if (unknownHosts.length) problems.push(`main.js contains remote host(s) it may not name: ${unknownHosts.join(", ")}`);

if (isHost) {
  if (!ALLOWED_HOSTS.some((host) => source.includes(host))) {
    problems.push("the host bundle carries none of the declared provider hosts; the provider table was not bundled");
  }
  // The two HTTP clients are required by the host's transport: a hosted provider
  // is https, and node:http cannot open one at all.
  for (const module of ["node:http", "node:https"]) {
    if (!new RegExp(`(?:require|import)\\(["']${module.replace(":", "\\:")}["']\\)`).test(source)) {
      problems.push(`main.js does not require ${module}; the AI transport needs both carriers`);
    }
  }
  if (!/XMLHttpRequest/.test(source)) {
    problems.push("main.js has no XMLHttpRequest carrier; the mobile transport was not bundled");
  }
  // The credential fields must be read through a typeof guard: a missing field
  // from a hand-edited settings file has to be a diagnosis, not a TypeError.
  for (const field of ["apiKey", "authHeader", "authPrefix"]) {
    const guarded = new RegExp(`typeof [\\w.$]+\\s*==+\\s*["']string["'][^;]{0,40}\\.${field}\\b`);
    if (!guarded.test(source)) {
      problems.push(`main.js reads ${field} without a typeof guard; a missing field would surface as a TypeError`);
    }
  }
} else {
  // A domain bundle must have no socket at all.
  for (const module of ["node:http", "node:https"]) {
    if (new RegExp(`require\\(["']${module.replace(":", "\\:")}["']\\)`).test(source)) {
      problems.push(`main.js requires ${module}; domain plugins must call the host API instead of opening a socket`);
    }
  }
  if (/authorization/i.test(source)) {
    problems.push("main.js contains a credential header; the host owns every credential");
  }
}

if (problems.length) {
  console.error("FAIL:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `OK  ${manifest.id} v${manifest.version}: ${source.length} bytes, obsidian required, registry present, ` +
    (isHost
      ? `requests only to declared providers (${ALLOWED_HOSTS.join(", ")} + loopback).`
      : "no socket, no remote host, no credential."),
);