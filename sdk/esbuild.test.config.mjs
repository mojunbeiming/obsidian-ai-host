// Compiles the Obsidian-free core to plain ESM so `node --test` can import it.
// Anything that touches the Obsidian API lives in a plugin, not here, because
// stubbing the whole Obsidian API would only test the stub.
import esbuild from "esbuild";

await esbuild.build({
  entryPoints: [
    "src/clock.ts",
    "src/interval.ts",
    "src/heat.ts",
    "src/checkin.ts",
    "src/fsrs.ts",
    "src/queue.ts",
    "src/stats.ts",
    "src/persist.ts",
    // Mobile: a synchronous FsShim over Obsidian mobile's async vault adapter.
    "src/vaultFs.ts",
    "src/api.ts",
    "src/icons.ts",
    "src/sort.ts",
    // v0.3: the AI core. Pure on purpose -- the transport that actually opens a
    // socket lives in each plugin's `src/aiProvider.ts`, so this module is
    // importable by `node --test` and every request body is assertable.
    "src/ai.ts",
    "src/aiProviders.ts",
    // The connectivity probe, split out of aiSettings.ts so the two-step check
    // (GET /models, then a chat request) is assertable without Obsidian.
    "src/aiProbe.ts",
    "src/aiStatus.ts",
    // v0.5.1: the transparent-run model and the vault context budget.
    "src/aiTrace.ts",
    "src/aiContext.ts",
    // v0.6: the host foundation. `aiSettingsSchema` freezes the version and the
    // migration chain; `aiSse`/`aiTransport`/`aiAdapters` are the streaming
    // path; `aiConversationStore` replaces one big data.json with one file per
    // conversation; `aiGlob` is the indexer's include/exclude matcher.
    "src/ai/aiSettingsSchema.ts",
    "src/ai/aiChat.ts",
    "src/ai/aiSse.ts",
    "src/ai/aiTransport.ts",
    "src/ai/aiAdapters/openai.ts",
    "src/ai/aiAdapters/gemini.ts",
    "src/ai/aiAdapters/anthropic.ts",
    "src/ai/aiAdapters/index.ts",
    "src/ai/aiConversationStore.ts",
    // v0.7: the agent workbench. Workspaces carry the sandbox and the four
    // permission tiers; the audit module owns write hashes and batch undo; the
    // agent module owns plan/budget/observation/checkpoint; usage stats back the
    // composer's numbers. All four are Obsidian-free and tested with `node --test`.
    "src/ai/aiWorkspace.ts",
    "src/ai/aiAudit.ts",
    "src/ai/aiAgent.ts",
    "src/ai/aiUsageStats.ts",
    "src/ai/aiGlob.ts",
    "src/ai/aiVectorStore.ts",
    "src/ai/aiRag.ts",
    "src/ai/aiTools.ts",
    "src/ai/aiDiff.ts",
    "src/ai/aiApply.ts",
    "src/ai/aiPricing.ts",
    "src/ai/aiOutput.ts",
    "src/ai/aiSkill.ts",
    "src/ai/aiErrors.ts",
    "src/ai/aiRunLog.ts",
    "src/recorder.ts",
  ],
  bundle: true,
  outdir: ".build",
  format: "esm",
  target: "es2021",
  platform: "neutral",
  // Node builtins stay external. The neutral platform does not externalize them
  // automatically, and `aiTransport` legitimately imports `node:http(s)` -- the
  // test build must leave the import for Node to resolve at run time rather than
  // fail the build or (worse) try to bundle a client.
  external: ["node:*"],
  logLevel: "info",
});