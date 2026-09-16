/**
 * The AI settings section, rendered once for both plugins.
 *
 * ## Why this is in the SDK and not in each plugin
 *
 * The two panes ask the user for exactly the same thing -- a provider, a key,
 * and a way to find out whether they work -- and the cost of drawing that twice
 * is not the duplication, it is the drift: one pane gains a warning the other
 * does not, and "why does it work in the flashcards pane" becomes a real
 * question. The same reason the shared stylesheet block exists.
 *
 * This is the **only** SDK module that imports `obsidian`, and it is exported
 * from `ai.ts`'s neighbours rather than from the core so that the pure modules
 * stay importable by `node --test`. The plugins' test builds discover modules by
 * reading their imports and skip anything that names `obsidian`, so this file is
 * exercised only inside the app — which is acceptable because it contains no
 * decisions, only controls bound to settings the SDK already validates.
 *
 * ## What it deliberately does not do
 *
 * It never writes a key anywhere except the plugin's own settings object. There
 * is no keychain here because Obsidian plugins have none; the honest thing is to
 * store it where the plugin already stores everything and say so on the row.
 *
 * ## Where connectivity is decided
 *
 * In `aiStatus.ts`, which owns the verdict and its age; this file only draws it and
 * provides the two helpers that bind it to a plugin's settings. The split matters
 * because the same verdict is shown in three places -- the settings row, the
 * studio panel and the planner dialog -- and three independent checks would give
 * three answers.
 */
import { Notice, Setting } from "obsidian";
import { AI_PROVIDER_GROUPS, authHeaderFor, providerById, type AiProviderPreset } from "./aiProviders";
import { AI_DEFAULT_TIMEOUT_MS, aiSettingsFrom, apiUrlFor, checkAiConfig, type AiConfigWarning } from "./ai";
import type { AiStatusTracker } from "./aiStatus";

export {
  AI_PROBE_MESSAGES,
  aiStatusKeyFor,
  makeAiStatusTracker,
  probeAiConnection,
} from "./aiProbe";
/**
 * The settings keys this section reads and writes.
 *
 * Exported so each plugin can declare `aiProvider` · `aiBaseUrl` · `aiProtocol` ·
 * `aiModel` · `aiApiKey` · `aiAuthHeader` · `aiAuthPrefix` · `aiTimeoutMs` in its
 * own interface and have a test that the two lists agree. `check-settings.mjs`
 * looks for each key in the plugin's **own** source, so the plugins name them.
 */
export const AI_SHARED_SETTING_KEYS = [
  "aiProvider",
  "aiBaseUrl",
  "aiProtocol",
  "aiModel",
  "aiApiKey",
  "aiAuthHeader",
  "aiAuthPrefix",
  "aiTimeoutMs",
  "aiSupportsImages",
] as const;

/** What the section needs from the plugin that hosts it. */
export interface AiSettingsHost {
  /** The values as stored. Read through `aiSettingsFrom` by the caller, not here. */
  values: Record<string, unknown>;
  /** The plugin id, so the storage warning names the real file. */
  pluginId: string;
  /** Persist one patch. */
  save: (patch: Record<string, unknown>) => void;
  /**
   * Redraw the whole settings page.
   *
   * Reserved for the one control that changes which *other* controls exist: the
   * provider dropdown. Everything else updates in place, because a redraw moves
   * the reader -- it resets the scroll position and collapses the 高级 fold -- and
   * a page that jumps while you type in a model name is unusable regardless of
   * how correct its data is.
   */
  redraw: () => void;
  /** Send one minimal prompt and report what came back. */
  test: () => Promise<string>;
  /**
   * The element Obsidian scrolls, so a redraw can put the reader back.
   *
   * Passed in because the SDK cannot find it: the scroll container is a settings
   * page's `.vertical-tab-content-container`, which is outside anything this
   * function is handed.
   */
  scrollEl?: HTMLElement | null;
  /**
   * The shared connectivity tracker, so this row and the panels agree.
   *
   * Optional so the section can still be drawn by a caller that has no tracker --
   * in which case the status line reads "还没有检测过" and the test button still
   * works. That is a degraded mode rather than a broken one.
   */
  status?: () => AiStatusTracker;
  /** The key the tracker files this configuration's verdict under. */
  statusKey?: () => string;
}

/**
 * Draw the section.
 *
 * The order is deliberate: provider, key, test. Everything else is behind
 * 高级 because it is derived from the provider and only a user with an
 * unanticipated endpoint needs it -- and a form whose first screen is ten fields
 * reads as more work than it is.
 */
export function renderAiSettings(containerEl: HTMLElement, host: AiSettingsHost): void {
  const value = (key: string): string => {
    const raw = host.values[key];
    return typeof raw === "string" ? raw : "";
  };
  const provider = providerById(value("aiProvider")) ?? null;
  // Anything complete and still wrong: a cloud preset aimed at a loopback
  // address, a local preset aimed at a remote one, or the DSH port under another
  // provider. The form is valid, so these do not block it -- they are shown with
  // the one click that repairs them, which is what the 405 should have been.
  const configCheck = checkAiConfig(host.values);
  const warnings = configCheck.ok ? configCheck.warnings : [];

  /**
   * Save, stamping the configuration with the provider it belongs to.
   *
   * Every write goes through here, and the stamp is what lets `readAiSettings`
   * tell "I chose this address for this service" from "this is the previous
   * service's address". Without it a user switching providers keeps the old
   * address -- which is how the report that produced this arrived: *DeepSeek 官方
   * API* pointed at a loopback port, every request failed, and the page looked
   * correctly filled in.
   *
   * The auth pair is only meaningful for `custom`, so it is dropped for a named
   * provider: a leftover `x-api-key` override would otherwise be sent where
   * `Bearer` is expected, which is a 401 that no amount of re-reading the key
   * explains.
   */
  const write = (patch: Record<string, unknown>): void => {
    const chosen = providerById(String(patch.aiProvider ?? value("aiProvider")));
    const stamped: Record<string, unknown> = { ...patch, aiStoredFor: chosen?.id ?? "" };
    if (chosen && chosen.auth !== "custom") {
      // Not written at all for a named provider rather than written as empty: an
      // empty string would be indistinguishable from "left blank on purpose".
      delete stamped.aiAuthHeader;
      delete stamped.aiAuthPrefix;
    }
    host.save(stamped);
  };

  const providerSetting = new Setting(containerEl)
    .setName("服务商")
    .setDesc(
      "选一个，粘贴它的 API Key 就能用。云端服务不需要在本机装任何东西；" +
        "本机服务需要你自己先把它跑起来。",
    )
    .addDropdown((dropdown) => {
      for (const group of AI_PROVIDER_GROUPS) {
        // Obsidian's dropdown has no optgroups, so the grouping is carried in the
        // label. A flat list of six would hide the only distinction that matters
        // here: whether something has to be installed first.
        for (const entry of group.providers) {
          dropdown.addOption(entry.id, `${group.title === "本机服务" ? "本机" : "API"} · ${entry.label}`);
        }
      }
      dropdown.setValue(provider?.id ?? "");
      dropdown.onChange((chosen) => {
        const next = providerById(chosen);
        // Address, protocol, model and the auth pair are cleared so the preset
        // supplies them. `write` stamps the record with the new provider, which is
        // what makes `readAiSettings` trust the values that follow: without the
        // stamp it cannot tell a chosen address from the previous service's, and
        // the safe direction is to ignore both.
        write({
          aiProvider: chosen,
          aiBaseUrl: next?.local ? next.baseUrl : "",
          aiProtocol: "",
          aiModel: "",
          aiAuthHeader: next?.auth === "custom" ? next.header ?? "" : "",
          aiAuthPrefix: next?.auth === "custom" ? next.prefix ?? "" : "",
        });
        // The one control that has to rebuild the page -- it decides which other
        // controls exist -- and therefore the one place the reader's position has
        // to be preserved by hand.
        redrawPreservingView(host);
      });
    });
  if (provider) providerSetting.setDesc(`${provider.hint}`);
  if (warnings.length) renderConfigWarnings(containerEl, host, warnings);

  if (provider?.needsKey) {
    // The name comes from the preset: the DSH credential is a one-time token
    // printed by `dsh web`, and calling that an "API Key" is how a user decides
    // the field is not for them. Everything else about the field is unchanged.
    const credentialLabel = provider.credentialLabel ?? "API Key";
    const credentialFrom =
      provider.credentialHint ??
      `以 ${authHeaderFor(provider).prefix ? `${authHeaderFor(provider).prefix.trim()} ` : ""}${authHeaderFor(provider).header} 头发送。`;
    new Setting(containerEl)
      .setName(credentialLabel)
      .setDesc(
        `${credentialFrom}` +
          `明文保存在 .obsidian/plugins/${host.pluginId}/data.json 里 —— ` +
          "`.obsidian/` 不进 Git 也不进同步，所以换设备要重新填一次。",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.addClass("sfc-ai-key");
        text.setValue(value("aiApiKey")).onChange((next) => write({ aiApiKey: next }));
      });
  }

  // In place, not by redrawing: the toggle's *description* is the only thing that
  // changes, and a page that scrolls back to the top when you flip a switch is
  // the reason this section stopped rebuilding itself on every edit.
  const imageHint = document.createElement("div");
  imageHint.addClass("sfc-muted", "sfc-small");
  const paintImageHint = (on: boolean): void => {
    imageHint.setText(
      on
        ? "图片制卡可用。规划不受影响。"
        : "图片制卡会说明「当前模型不支持图片」，直到这里打开。",
    );
  };
  new Setting(containerEl)
    .setName("模型能读图片")
    .setDesc(
      "打开后图片制卡才可用；规划不受影响。填的是文本模型时请关掉 —— " +
        "关掉后制卡面板会直接说明「当前模型不支持图片」，而不是花一次请求换一个 400。",
    )
    .addToggle((toggle) =>
      toggle.setValue(host.values.aiSupportsImages === true).onChange((next) => {
        write({ aiSupportsImages: next });
        paintImageHint(next);
      }),
    );
  containerEl.appendChild(imageHint);
  paintImageHint(host.values.aiSupportsImages === true);

  // The result of a test, shown next to the button rather than only in a Notice:
  // a Notice disappears, and "is it connected?" is a state the page should be able
  // to answer while the reader is looking at the fields that decide it.
  //
  // Read from the shared tracker, so this row, the studio panel and the planner
  // dialog report one verdict. The host used to own its own `lastTestResult`, which
  // is how the three could have disagreed.
  const tracker = host.status?.();
  const key = host.statusKey?.() ?? "";
  const status = tracker?.snapshot(key);
  const testResult = document.createElement("div");
  testResult.addClass("sfc-muted", "sfc-small");
  if (status?.checking) {
    testResult.setText("正在检测连接…");
  } else if (status?.verdict) {
    testResult.setText(status.verdict.ok ? `已连通：${status.verdict.message}` : `未连通：${status.verdict.message}`);
    testResult.addClass(status.verdict.ok ? "sfc-ai-test-ok" : "sfc-ai-test-failed");
  } else {
    testResult.setText("还没有检测过。");
  }
  // Asked for on arrival, so the answer is there without a button press -- the
  // whole complaint that produced this module was that nothing ever asked.
  if (tracker && host.statusKey && !status?.fresh && !status?.checking) void tracker.check(key);

  new Setting(containerEl)
    .setName("连接")
    .setDesc(
      "发一句最短的提示，确认服务商、模型和 Key 能通。" +
        "卡片中心与规划面板也显示这个结果，并在你改了设置之后自动重新检测。",
    )
    .addButton((button) =>
      button.setButtonText(status?.verdict ? "重新检测" : "检测").onClick(async () => {
        button.setDisabled(true);
        button.setButtonText("检测中……");
        testResult.setText("正在检测…");
        testResult.removeClass("sfc-ai-test-ok", "sfc-ai-test-failed");
        // Through the tracker when there is one, so this press updates the same
        // verdict the panels read. A tracker that reports `ok` is also what makes
        // the settings row, the studio panel and the planner dialog agree.
        if (tracker && host.statusKey) await tracker.check(host.statusKey(), { force: true });
        try {
          const report = await host.test();
          new Notice(`连接成功\n${report}`, 15000);
          testResult.setText(`已连通：${report.split("\n").join(" · ")}`);
          testResult.addClass("sfc-ai-test-ok");
          button.setButtonText("再测一次");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(`连接失败\n${message}`, 20000);
          testResult.setText(`未连通：${message}`);
          testResult.addClass("sfc-ai-test-failed");
          button.setButtonText("重试");
        } finally {
          button.setDisabled(false);
        }
      }),
    );
  containerEl.appendChild(testResult);

  renderAdvanced(containerEl, host, provider, value, write);
}

/**
 * Where the 高级 fold was left, remembered across a redraw.
 *
 * Module state rather than a field on the host because it is a property of the
 * section, and because a redraw constructs a *new* `<details>` element: without
 * somewhere to read it back from, every rebuild collapses the fold the reader had
 * deliberately opened to edit a model name.
 */
let advancedOpen = false;

/**
 * Redraw the settings page without moving the reader.
 *
 * The provider dropdown is the only control that still needs a full redraw -- it
 * changes which other controls exist -- and this is what makes that redraw
 * survivable: the scroll position is restored to where it was, and the 高级 fold
 * is reopened and its contents scrolled to. Called *instead of* the host's own
 * redraw for that one control.
 *
 * An absent scroll container (the pane not laid out yet) is not an error: the
 * restore simply finds no position to reset, which is the same outcome as a page
 * that has not been scrolled.
 */
export function redrawPreservingView(host: AiSettingsHost): void {
  const scroll = host.scrollEl ?? null;
  const top = scroll?.scrollTop ?? 0;
  // Read off the element that is still in the DOM, and only fall back to the
  // remembered value when there is no element to read. The `summary` click handler
  // must **not** maintain this: it runs before the browser flips `open`, so saving
  // there records the value the reader is leaving rather than the one they chose.
  const open = scroll?.querySelector<HTMLDetailsElement>(".sfc-ai-advanced")?.open ?? advancedOpen;
  advancedOpen = open;
  host.redraw();
  if (!scroll) return;
  // After the rebuild the section is a different element; find it again and put
  // the reader back. `scrollTop` is set before reopening so the reopen's own
  // scroll-into-view does not fight it.
  scroll.scrollTop = top;
  const next = scroll.querySelector<HTMLDetailsElement>(".sfc-ai-advanced");
  if (next && open) next.open = true;
}

/**
 * What the preset decided, shown only when the user wants to change it.
 *
 * Collapsed by default via `<details>`: an expanded section is not a setting, it
 * is where the reader is looking, so it lives in `advancedOpen` rather than in a
 * setting that would persist across sessions.
 */
/**
 * The warnings, each with the one click that repairs it.
 *
 * A warning is not an error: the form is complete and the address parses, so the
 * panel keeps working. What it is not is *correct* -- and the fix is offered here
 * because the alternative is reading a 405 and editing the wrong field.
 */
function renderConfigWarnings(
  containerEl: HTMLElement,
  host: AiSettingsHost,
  warnings: readonly AiConfigWarning[],
): void {
  for (const warning of warnings) {
    const box = containerEl.createDiv({ cls: "sfc-ai-problem" });
    box.createDiv({ cls: "sfc-small", text: warning.message });
    if (warning.fix?.note) box.createDiv({ cls: "sfc-muted sfc-small", text: warning.fix.note });
    if (!warning.fix) continue;
    const fix = warning.fix;
    const row = box.createDiv({ cls: "sfc-actions" });
    const button = row.createEl("button", {
      cls: "sfc-btn sfc-primary",
      text: fix.label,
      attr: { type: "button" },
    });
    button.onclick = () => host.save(fix.patch);
  }
}

function renderAdvanced(
  containerEl: HTMLElement,
  host: AiSettingsHost,
  provider: AiProviderPreset | null,
  value: (key: string) => string,
  write: (patch: Record<string, unknown>) => void,
): void {
  const details = containerEl.createEl("details", { cls: "sfc-ai-advanced" });
  const summary = details.createEl("summary", { text: "高级（地址、协议、模型、超时）" });
  // Recorded on the *next* tick, because this handler runs before the browser
  // applies the toggle: reading `details.open` here returns the state being left.
  summary.onclick = () => {
    window.setTimeout(() => {
      advancedOpen = details.open;
    }, 0);
  };
  if (advancedOpen) details.open = true;
  const body = details.createDiv({ cls: "sfc-ai-advanced-body" });

  // The URLs the settings currently produce, spelled out.
  //
  // This is the answer to "the docs say the BASE URL is X, why is the plugin's
  // not?" -- the plugin's field *is* the base URL, and what it needs to show is
  // where that base leads. Services disagree about the path (`…/chat/completions`
  // with no `/v1` for DeepSeek, `/v1/messages` for Anthropic), so a base URL pasted
  // from a manual is only trustworthy once the reader can see the resolved request.
  const resolved = details.createDiv({ cls: "sfc-ai-resolved" });
  const resolvedBase = value("aiBaseUrl") || provider?.baseUrl || "";
  resolved.createDiv({ cls: "sfc-small", text: "实际请求的地址：" });
  for (const kind of ["openai", "anthropic"] as const) {
    const url = apiUrlFor(resolvedBase, kind);
    const line = resolved.createDiv({ cls: "sfc-muted sfc-small" });
    line.setText(`${kind === "openai" ? "OpenAI 兼容" : "Anthropic"}：${url || "（先填地址）"}`);
  }
  // The DSH shape, shown only when that is the protocol that will be used: a
  // base of `http://127.0.0.1:3080` means `POST /api/session/create`, not the
  // OpenAI path the two lines above would otherwise imply.
  const auth = aiSettingsFrom(host.values);
  const how = auth.authHeader
    ? `凭据放在 ${auth.authHeader} 头（前缀 ${JSON.stringify(auth.authPrefix)}）。`
    : "这个服务商不需要凭据。";
  const resolvedProtocol = value("aiProtocol") || provider?.kind || "";
  if (resolvedProtocol === "dsh") {
    const line = resolved.createDiv({ cls: "sfc-muted sfc-small" });
    line.setText(`DeepSeek Harness：${apiUrlFor(resolvedBase, "dsh") || "（先填地址）"}`);
  }
  const method = details.createDiv({ cls: "sfc-muted sfc-small" });
  method.setText(
    "连接检测先 GET /models（不消耗 token）；本机 DSH 用只读的 /api/session/list；都没有才退回发一句聊天请求。" + how,
  );

  new Setting(body)
    .setName("端点地址")
    .setDesc(
      provider
        ? `填服务商文档里的 base URL 就行，路径由插件按协议拼（见上面那两行）。留空表示用 ${provider.label} 的默认地址。`
        : "服务商文档里的 base URL。路径由插件按协议拼（见上面那两行）。",
    )
    .addText((text) =>
      text
        // The preset's own address as the placeholder, and nothing when there is
        // no preset: a `custom` row with no address has no example to show, and
        // inventing one here would be a second place a host is named.
        .setPlaceholder(provider?.baseUrl ?? "")
        .setValue(value("aiBaseUrl"))
        .onChange((next) => write({ aiBaseUrl: next.trim() })),
    );

  new Setting(body)
    .setName("协议")
    .setDesc("留空表示用服务商自己的形状。只有自建网关才需要改。")
    .addDropdown((dropdown) =>
      dropdown
        .addOption("", "跟随服务商")
        .addOption("openai", "OpenAI 兼容")
        .addOption("anthropic", "Anthropic Messages")
        .addOption("dsh", "DeepSeek Harness")
        .setValue(value("aiProtocol"))
        .onChange((next) => write({ aiProtocol: next })),
    );

  new Setting(body)
    .setName("模型")
    .setDesc(
      "留空表示用服务商的默认模型。" +
        "要读图（AI 制卡）就得填一个支持图片输入的模型，否则那个面板会直接说这个模型不能读图。",
    )
    .addText((text) =>
      text
        .setPlaceholder(provider?.model || "模型名")
        .setValue(value("aiModel"))
        .onChange((next) => write({ aiModel: next.trim() })),
    );

  new Setting(body)
    .setName("超时（秒）")
    .setDesc("一次请求最多等多久。读大图时可能比较慢，默认 120 秒。")
    .addText((text) =>
      text.setValue(String(Math.round(numberOf(host.values.aiTimeoutMs) / 1000))).onChange((next) => {
        const seconds = Number.parseInt(next.trim(), 10);
        if (Number.isFinite(seconds)) write({ aiTimeoutMs: Math.max(5, Math.min(600, seconds)) * 1000 });
      }),
    );

  if (provider?.auth === "custom") {
    // Only offered for `custom`: a named provider knows its own header, and the
    // transport ignores these fields for anything else.
    //
    // The placeholder is the header the `custom` preset resolves to rather than a
    // spelling written here -- which is both more accurate (it shows what will
    // actually be sent) and the reason this file does not contain the word the
    // credential guard forbids outside the transport and the table.
    const fallback = authHeaderFor(provider);
    new Setting(body)
      .setName("鉴权头名")
      .setDesc(`留空表示 ${fallback.header}。`)
      .addText((text) =>
        text
          .setPlaceholder(fallback.header)
          .setValue(value("aiAuthHeader"))
          .onChange((next) => write({ aiAuthHeader: next.trim() })),
      );
    new Setting(body)
      .setName("鉴权前缀")
      .setDesc(
        `写在 Key 前面的那段，当前预设是 ${JSON.stringify(fallback.prefix)}（注意尾部空格）。留空表示直接发 Key。`,
      )
      .addText((text) =>
        text
          .setPlaceholder(fallback.prefix)
          .setValue(value("aiAuthPrefix"))
          .onChange((next) => write({ aiAuthPrefix: next })),
      );
  }
}

/** A stored number, or the default timeout. */
function numberOf(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 5000 ? raw : AI_DEFAULT_TIMEOUT_MS;
}
