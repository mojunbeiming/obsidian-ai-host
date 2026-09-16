# AI Host

Optional shared AI backend for **Taskdown** and **FSRS Flashcards**. Install it only if you want AI features; both plugins work fully without it. AI Host keeps the provider configuration, the API keys and the run history in one place so the domain plugins never need their own network code or credentials.

By **Helfas**. MIT licensed. The technical plugin id is `sfc-ai`.

## Highlights

- **Providers:** any OpenAI-compatible endpoint, Anthropic, Google Gemini, Ollama and local model servers.
- **Keys in the keychain.** API keys are stored in Obsidian's secret storage (Obsidian 1.11.4+), not in `data.json`. On older versions a pasted key is kept for the session only, and the UI says so.
- **Streaming chat** with `@` mentions of notes, folders and search results, plus a pure-JavaScript RAG index.
- **Workspace sandbox** with four permission tiers (manual / standard / trusted / full); full access can expire automatically.
- **Agent runs** with plan, budget, checkpoints and deliverables, built on the same permission model.
- **Writes are reversible.** Every write goes through a backup and an audit record; undo works per change or per batch, and Apply mode asks for confirmation block by block.
- **Run log and trace** for every request: view, export and redact.
- **Skills API** so the domain plugins can offer AI actions (card drafts, task planning) without owning provider code.

## Network and privacy

This section is a required disclosure. AI Host is the only plugin in this family that can make network requests, and only after **you** configure a provider.

- **Which remote services:** the provider you select  an OpenAI-compatible endpoint, Anthropic, Google Gemini, or a model server you run yourself (for example Ollama on `127.0.0.1:11434`).
- **When requests happen:** only when you send a chat message, ask for a model listing, run a skill, or start an agent run. There are no background requests.
- **What is sent:** the conversation you type, the notes and attachments you explicitly mention (`@`), and RAG snippets, images or recording audio that you choose to include. Nothing else from your vault is uploaded.
- **What is not sent:** no vault-wide scan, no telemetry, no analytics, no crash reporting, no usage metrics beyond what the provider itself reports back to the model call. Run logs stay on your machine.
- **Keys:** stored in Obsidian's secret storage; never written to `data.json` or to the run log. Exported diagnostics redact secrets.
- **Files:** AI Host reads and writes only inside your vault (its own plugin folder and the notes you grant access to). It does not scan or modify files outside the vault.
- **Updates:** the plugin never updates itself or its dependencies; updates happen through Obsidian's community plugin update flow.

## Installation

### Community plugins
Once listed: **Settings  Community plugins  Browse**, search for `AI Host`, then **Install** and **Enable**.

### Manual installation
1. Download `main.js`, `manifest.json` and `styles.css` from the latest GitHub release.
2. Put them in `<vault>/.obsidian/plugins/sfc-ai/`.
3. Reload Obsidian and enable **AI Host**.

## Getting started

1. Open **Settings  AI Host** and choose a provider. Paste your API key; it is stored in the system keychain when Obsidian supports it.
2. Open the chat pane from the ribbon (bot icon) or the command **"AI Host 聊天"**.
3. Use `@` to mention notes, folders or a search query, and choose a workspace/permission tier before an agent run.
4. Review proposals in the run log; apply, undo or export as needed.

## Mobile

HTTPS providers work on mobile. Providers that live on your computer (`localhost`, `127.0.0.1`) are unreachable from a phone by design. Key storage needs Obsidian 1.11.4+; older versions can still chat with a session-only key.

## Development

```bash
npm ci
npm run build
npm run verify
npm run typecheck
```

## License

MIT  2026 Helfas. See `LICENSE`. Third-party notices are in `THIRD-PARTY-NOTICES.md`.

## Vault and clipboard access

- AI Host enumerates vault file paths to resolve `@` mentions and to build the optional RAG index. The index is opt-in and can be disabled; when disabled, no vault-wide enumeration happens.
- It reads individual notes only when you mention them or when an enabled index needs their text.
- It reads or writes the system clipboard only when you use a copy or paste action in its own interface.