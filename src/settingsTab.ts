/**
 * The host settings page: provider, chat, apply, RAG, tools, data.
 *
 * Two states are rendered honestly because they are the ones users get stuck
 * in: a provider with no key (Save is right there), and an Obsidian without
 * `secretStorage` (older than 1.11.4), where the key cannot be saved at all
 * instead of quietly going back into `data.json`.
 */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { confirmAction } from "../sdk/src/uiDialogs";
import { adapterFor } from "../sdk/src/ai/aiAdapters/index";
import { AI_PERMISSION_TIERS, permissionLabel } from "../sdk/src/ai/aiWorkspace";
import type SfcAiPlugin from "./main";

export class AiSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: SfcAiPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.getSettings();
    const rows = this.plugin.getProviderRows();
    const currentId = this.plugin.currentProviderId();
    const current = rows.find((row) => row.id === currentId) ?? rows[0];

    new Setting(containerEl).setName("服务商").setHeading();
    new Setting(containerEl)
      .setName("聊天服务商")
      .setDesc("密钥存在 Obsidian 钥匙串；data.json 里只有它的引用 id。")
      .addDropdown((dropdown) => {
        for (const row of rows) dropdown.addOption(row.id, `${row.label}${row.local ? "（本机）" : ""}`);
        dropdown.setValue(current?.id ?? "");
        dropdown.onChange((value) => void this.plugin.setChatProvider(value).then(() => this.display()));
      });

    const secret = current ? this.plugin.getSecrets().readForProvider(current.id) : { value: "", origin: "none" as const };
    const keyInput = containerEl.createEl("input", { type: "password", cls: "sfc-ai-key", placeholder: secret.origin === "none" ? "粘贴密钥" : "已保存（重新输入可覆盖）" });
    keyInput.dataset.secretInput = current?.id ?? "";
    new Setting(containerEl)
      .setName("API Key")
      .setDesc(this.secretDescription(secret.origin))
      .addButton((button) =>
        button.setButtonText("保存").setCta().onClick(() => {
          if (!current) return;
          const result = this.plugin.getSecrets().writeForProvider(current.id, keyInput.value);
          if (!result.ok) {
            new Notice("这个 Obsidian 版本没有可用的钥匙串（需要 1.11.4+），密钥没有保存到任何地方。");
            return;
          }
          new Notice(keyInput.value.trim() ? "密钥已保存到钥匙串。" : "密钥已清除。");
          this.display();
        }),
      );
    if (secret.origin === "legacy") {
      new Setting(containerEl)
        .setName("旧版明文密钥")
        .setDesc("data.json 里还有一份明文；输入新密钥保存会同时清掉两处。")
        .addButton((button) =>
          button.setButtonText("迁移到钥匙串").onClick(() => {
            if (!current) return;
            const result = this.plugin.getSecrets().writeForProvider(current.id, secret.value);
            new Notice(result.ok ? "已迁移到钥匙串。" : "没有可用的钥匙串，未迁移。");
            this.display();
          }),
        );
    }

    new Setting(containerEl)
      .setName("模型")
      .setDesc("留空表示用服务商的默认模型。")
      .addText((text) => text.setPlaceholder(current?.model || "默认模型").setValue(settings.chat.model).onChange((value) => void this.plugin.patchChat({ model: value })));

    new Setting(containerEl)
      .setName("端点地址")
      .setDesc("留空表示用服务商预设地址。")
      .addText((text) =>
        text
          .setPlaceholder(current?.baseUrl || "预设地址")
          .setValue(settings.providers.find((row) => row.id === current?.id)?.baseUrl ?? "")
          .onChange((value) => {
            if (current) void this.plugin.patchProvider(current.id, { baseUrl: value });
          }),
      );

    if (current) {
      const capabilities = current.capabilities.length ? current.capabilities.join(" / ") : "未声明";
      const adapter = adapterFor(current.protocol);
      new Setting(containerEl)
        .setName("协议与能力")
        .setDesc(`协议 ${current.protocol}${adapter ? "" : "（宿主暂不支持）"}；能力：${capabilities}。`)
        .addDropdown((dropdown) => {
          dropdown.addOption("openai", "OpenAI 兼容");
          dropdown.addOption("anthropic", "Anthropic");
          dropdown.addOption("gemini", "Gemini");
          dropdown.addOption("dsh", "DSH（未支持）");
          dropdown.setValue(current.protocol);
          dropdown.onChange((value) => void this.plugin.patchProvider(current.id, { protocol: value }).then(() => this.display()));
        });
    }

    const status = containerEl.createDiv({ cls: "sfc-ai-status" });
    status.setText("还没有测试连接。");
    new Setting(containerEl).addButton((button) =>
      button.setButtonText("测试连接").onClick(async () => {
        status.setText("正在测试");
        const message = await this.plugin.testConnection();
        status.setText(message);
        status.toggleClass("sfc-ai-status-ok", message.startsWith("连接成功"));
        status.toggleClass("sfc-ai-status-bad", !message.startsWith("连接成功"));
      }),
    );

    new Setting(containerEl).setName("聊天").setHeading();
    new Setting(containerEl)
      .setName("流式输出")
      .setDesc("关掉就等整段回复一次返回，慢但兼容性最好。")
      .addToggle((toggle) =>
        toggle.setValue(settings.chat.stream).onChange((value) => {
          void this.plugin.patchChat({ stream: value });
        }),
      );
    new Setting(containerEl)
      .setName("默认包含当前文件")
      .addToggle((toggle) =>
        toggle.setValue(settings.chat.includeCurrentFile).onChange((value) => {
          void this.plugin.patchChat({ includeCurrentFile: value });
        }),
      );
    new Setting(containerEl)
      .setName("温度")
      .setDesc("0 最保守，1 最发散。")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setValue(settings.chat.temperature)
          .setDynamicTooltip()
          .onChange((value) => void this.plugin.patchChat({ temperature: value })),
      );
    new Setting(containerEl)
      .setName("上下文条数")
      .addText((text) =>
        text.setValue(String(settings.chat.maxContextMessages)).onChange((value) => {
          const count = Number.parseInt(value, 10);
          if (Number.isFinite(count)) void this.plugin.patchChat({ maxContextMessages: count });
        }),
      );
    new Setting(containerEl)
      .setName("模板文件夹")
      .setDesc("「/」从这里读取 Markdown 模板；留空关闭模板。")
      .addText((text) => text.setValue(settings.chat.templatesFolder).onChange((value) => void this.plugin.patchChat({ templatesFolder: value })));
    new Setting(containerEl)
      .setName("超时（秒）")
      .addText((text) =>
        text.setValue(String(Math.round(settings.chat.timeoutMs / 1000))).onChange((value) => {
          const seconds = Number.parseInt(value, 10);
          if (Number.isFinite(seconds)) void this.plugin.patchChat({ timeoutMs: seconds * 1000 });
        }),
      );

    new Setting(containerEl).setName("应用模型（整份文件重写）").setHeading();
    new Setting(containerEl)
      .setName("应用服务商")
      .setDesc("留空表示跟聊天服务商一致；建议选更便宜稳定的模型。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "同聊天服务商");
        for (const row of rows) dropdown.addOption(row.id, row.label);
        dropdown.setValue(settings.apply.providerId);
        dropdown.onChange((value) => void this.plugin.patchApply({ providerId: value }));
      });
    new Setting(containerEl)
      .setName("应用模型")
      .setDesc("留空表示用该服务商的默认模型。")
      .addText((text) => text.setValue(settings.apply.model).onChange((value) => void this.plugin.patchApply({ model: value })));

    new Setting(containerEl).setName("RAG 检索（默认关闭）").setHeading();
    new Setting(containerEl)
      .setName("启用 RAG")
      .setDesc("关闭时聊天完全不受索引影响；查询不会触发索引写入。")
      .addToggle((toggle) =>
        toggle.setValue(settings.rag.enabled).onChange((value) => {
          void this.plugin.patchRag({ enabled: value });
          if (value) new Notice("已开启；到下面点「更新索引」建立第一份索引。");
        }),
      );
    new Setting(containerEl)
      .setName("嵌入服务商")
      .setDesc("需要提供 embedding 接口（OpenAI 兼容或 Gemini）。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "同聊天服务商");
        for (const row of rows) dropdown.addOption(row.id, row.label);
        dropdown.setValue(settings.rag.embeddingProviderId);
        dropdown.onChange((value) => void this.plugin.patchRag({ embeddingProviderId: value }));
      });
    new Setting(containerEl)
      .setName("嵌入模型")
      .setDesc("例如 text-embedding-3-small、nomic-embed-text。留空用服务商默认值。")
      .addText((text) => text.setValue(settings.rag.embeddingModel).onChange((value) => void this.plugin.patchRag({ embeddingModel: value })));
    new Setting(containerEl)
      .setName("触发阈值（估算 token）")
      .setDesc("上下文超过这个量就改用检索；显式 @整个库 总是检索。")
      .addText((text) =>
        text.setValue(String(settings.rag.thresholdTokens)).onChange((value) => {
          const count = Number.parseInt(value, 10);
          if (Number.isFinite(count)) void this.plugin.patchRag({ thresholdTokens: count });
        }),
      );
    new Setting(containerEl)
      .setName("每块字符数 / 重叠")
      .addText((text) =>
        text.setValue(String(settings.rag.chunkSize)).onChange((value) => {
          const count = Number.parseInt(value, 10);
          if (Number.isFinite(count)) void this.plugin.patchRag({ chunkSize: count });
        }),
      )
      .addText((text) =>
        text.setValue(String(settings.rag.chunkOverlap)).onChange((value) => {
          const count = Number.parseInt(value, 10);
          if (Number.isFinite(count)) void this.plugin.patchRag({ chunkOverlap: count });
        }),
      );
    new Setting(containerEl)
      .setName("结果数 / 最低相似度")
      .addText((text) =>
        text.setValue(String(settings.rag.limit)).onChange((value) => {
          const count = Number.parseInt(value, 10);
          if (Number.isFinite(count)) void this.plugin.patchRag({ limit: count });
        }),
      )
      .addText((text) =>
        text.setValue(String(settings.rag.minSimilarity)).onChange((value) => {
          const number = Number.parseFloat(value);
          if (Number.isFinite(number)) void this.plugin.patchRag({ minSimilarity: number });
        }),
      );
    new Setting(containerEl)
      .setName("包含 / 排除（glob，逗号分隔）")
      .addText((text) => text.setValue(settings.rag.includeGlobs.join(", ")).onChange((value) => void this.plugin.patchRag({ includeGlobs: splitList(value) })))
      .addText((text) => text.setValue(settings.rag.excludeGlobs.join(", ")).onChange((value) => void this.plugin.patchRag({ excludeGlobs: splitList(value) })));

    const statsEl = containerEl.createDiv({ cls: "sfc-ai-status" });
    statsEl.setText("索引统计读取中");
    void this.plugin.indexStatsText().then((text) => statsEl.setText(`索引：${text}`));
    new Setting(containerEl)
      .setName("索引管理")
      .setDesc("更新只处理变化的文件；重建会清空后全量嵌入。")
      .addButton((button) => button.setButtonText("更新索引").onClick(() => void this.plugin.runIndexCommand("update").then(() => this.display())))
      .addButton((button) => button.setButtonText("重建索引").onClick(() => void this.plugin.runIndexCommand("rebuild").then(() => this.display())))
      .addButton((button) => button.setButtonText("删除索引").onClick(() => void this.plugin.runIndexCommand("clear").then(() => this.display())));
    const preview = this.plugin.ragFilePreview(12);
    containerEl.createDiv({ cls: "sfc-ai-diff-head", text: preview.length ? `将索引：${preview.join("、")}` : "当前 glob 下没有可索引的 Markdown 文件。" });

    new Setting(containerEl).setName("工具（默认关闭，只读）").setHeading();
    new Setting(containerEl)
      .setName("启用工具")
      .setDesc("当前只提供 vault.search / vault.read / vault.list，全部只读；任何写入工具都会先等你批准。")
      .addToggle((toggle) => toggle.setValue(settings.tools.enabled).onChange((value) => void this.plugin.patchTools({ enabled: value })));
    new Setting(containerEl)
      .setName("自动工具轮数上限")
      .setDesc("1 表示模型可以自动用一次工具，之后必须回到回答；调高会增加成本。")
      .addText((text) =>
        text.setValue(String(settings.tools.maxAutoIterations)).onChange((value) => {
          const count = Number.parseInt(value, 10);
          if (Number.isFinite(count)) void this.plugin.patchTools({ maxAutoIterations: count });
        }),
      );
    new Setting(containerEl)
      .setName("默认自动允许的工具")
      .setDesc("逗号分隔的工具名；仍只对只读工具生效。")
      .addText((text) =>
        text.setValue(settings.tools.autoAllowed.join(", ")).onChange((value) => void this.plugin.patchTools({ autoAllowed: splitList(value) })),
      );

    new Setting(containerEl).setName("日志与轨迹").setHeading();
    new Setting(containerEl)
      .setName("记录级别")
      .setDesc("off 完全不记；error 只记失败与警告步骤；normal 记步骤；详细后续会含流式细节。")
      .addDropdown((dropdown) => {
        dropdown.addOption("off", "关闭");
        dropdown.addOption("error", "只记错误");
        dropdown.addOption("normal", "标准");
        dropdown.addOption("verbose", "详细");
        dropdown.setValue(settings.logging.level);
        dropdown.onChange((value) => void this.plugin.patchLogging({ level: value as "off" | "error" | "normal" | "verbose" }));
      });
    new Setting(containerEl)
      .setName("保留条数 / 天数 / 上限 MB")
      .addText((text) =>
        text.setValue(String(settings.logging.keepRuns)).onChange((value) => {
          const count = Number.parseInt(value, 10);
          if (Number.isFinite(count)) void this.plugin.patchLogging({ keepRuns: count });
        }),
      )
      .addText((text) =>
        text.setValue(String(settings.logging.keepDays)).onChange((value) => {
          const count = Number.parseInt(value, 10);
          if (Number.isFinite(count)) void this.plugin.patchLogging({ keepDays: count });
        }),
      )
      .addText((text) =>
        text.setValue(String(settings.logging.maxBytesMB)).onChange((value) => {
          const count = Number.parseInt(value, 10);
          if (Number.isFinite(count)) void this.plugin.patchLogging({ maxBytesMB: count });
        }),
      );
    new Setting(containerEl)
      .setName("记录完整请求与回复")
      .setDesc("默认关闭：正文可能含笔记内容；打开后轨迹里会保留完整文本。")
      .addToggle((toggle) => toggle.setValue(settings.logging.recordFullPayload).onChange((value) => void this.plugin.patchLogging({ recordFullPayload: value })));
    new Setting(containerEl)
      .setName("状态栏显示运行状态")
      .addToggle((toggle) => toggle.setValue(settings.logging.statusBar).onChange((value) => void this.plugin.patchLogging({ statusBar: value })));
    new Setting(containerEl)
      .setName("打开运行记录")
      .setDesc("三个插件的运行轨迹都在这里，可复制 Markdown/JSON。")
      .addButton((button) => button.setButtonText("打开").onClick(() => void this.plugin.openRunLog()))
      .addButton((button) =>
        button.setButtonText("清空").onClick(async () => {
          if (await confirmAction(this.app, { title: "清空全部运行记录？", message: "日志文件会被删除，不可撤销。", cta: "清空", warning: true })) {
            await this.plugin.clearRunLog();
          }
        }),
      );

    new Setting(containerEl).setName("工作区（Agent 的文件夹沙箱）").setHeading();
    for (const workspace of settings.workspaces) {
      const scope = workspace.folders.length ? workspace.folders.join("、") : "整个库";
      new Setting(containerEl)
        .setName(workspace.name)
        .setDesc(`范围：${scope}${settings.defaultWorkspaceId === workspace.id ? "  默认工作区" : ""}`)
        .addDropdown((dropdown) => {
          for (const tier of AI_PERMISSION_TIERS) dropdown.addOption(tier, permissionLabel(tier));
          dropdown.setValue(workspace.permission);
          dropdown.onChange((value) => void this.plugin.patchWorkspace(workspace.id, { permission: value as (typeof AI_PERMISSION_TIERS)[number] }));
        })
        .addText((text) =>
          text.setPlaceholder("名称").setValue(workspace.name).onChange((value) => {
            if (value.trim()) void this.plugin.patchWorkspace(workspace.id, { name: value.trim() });
          }),
        )
        .addText((text) =>
          text.setPlaceholder("文件夹，逗号分隔").setValue(workspace.folders.join(", ")).onChange((value) =>
            void this.plugin.patchWorkspace(workspace.id, { folders: splitList(value) }),
          ),
        )
        .addText((text) =>
          text.setPlaceholder("默认模型").setValue(workspace.model ?? "").onChange((value) =>
            void this.plugin.patchWorkspace(workspace.id, { model: value.trim() }),
          ),
        )
        .addButton((button) =>
          button.setButtonText("设为默认").onClick(async () => {
            await this.plugin.setDefaultWorkspace(workspace.id);
            this.display();
          }),
        )
        .addButton((button) =>
          button.setButtonText("删除").setWarning().onClick(async () => {
            if (!(await confirmAction(this.app, { title: `删除工作区「${workspace.name}」？`, message: "其中的会话会转为未分组。", cta: "删除", warning: true }))) return;
            const alsoDelete = await confirmAction(this.app, {
              title: "同时删除这个工作区里的全部会话？",
              message: "选「取消」则保留为未分组；会话一旦删除不可撤销。",
              cta: "一并删除",
              warning: true,
            });
            await this.plugin.removeWorkspace(workspace.id, alsoDelete ? "delete" : "ungroup");
            new Notice(`工作区「${workspace.name}」已删除。`);
            this.display();
          }),
        );
    }
    new Setting(containerEl)
      .setName("新建工作区")
      .setDesc("名称 + 文件夹；权限与模型创建后在这里调整。")
      .addButton((button) => button.setButtonText("新建").onClick(() => this.plugin.openWorkspaceBuilder()));

    new Setting(containerEl).setName("权限（四级，能力可控）").setHeading();
    new Setting(containerEl)
      .setName("全局上限")
      .setDesc("所有工作区都不得超过这一档；谨慎场景选「标准」。")
      .addDropdown((dropdown) => {
        for (const tier of AI_PERMISSION_TIERS) dropdown.addOption(tier, permissionLabel(tier));
        dropdown.setValue(settings.permission.globalMax);
        dropdown.onChange((value) => void this.plugin.patchPermission({ globalMax: value as (typeof AI_PERMISSION_TIERS)[number] }));
      });
    new Setting(containerEl)
      .setName("完全权限有效期（分钟）")
      .setDesc("到点自动降回标准；Obsidian 退出也会失效。")
      .addText((text) =>
        text.setValue(String(settings.permission.fullExpiryMinutes)).onChange((value) => {
          const minutes = Number.parseInt(value, 10);
          if (Number.isFinite(minutes)) void this.plugin.patchPermission({ fullExpiryMinutes: minutes });
        }),
      );
    new Setting(containerEl)
      .setName("完全权限下删除/移动仍需确认")
      .setDesc("建议保持开启；关闭后 full 档位会静默执行 destructive 工具。")
      .addToggle((toggle) =>
        toggle.setValue(settings.permission.confirmDestructiveInFull).onChange((value) =>
          void this.plugin.patchPermission({ confirmDestructiveInFull: value }),
        ),
      );

    new Setting(containerEl).setName("Agent（预算与模式）").setHeading();
    new Setting(containerEl)
      .setName("默认开启 Agent 模式")
      .setDesc("输入器的 Agent 开关，关闭时只聊天。")
      .addToggle((toggle) => toggle.setValue(settings.agent.enabled).onChange((value) => void this.plugin.patchAgent({ enabled: value })));
    new Setting(containerEl)
      .setName("最大步数 / token / 分钟 / 金额")
      .setDesc("任一到顶就停止并给出报告；金额留空或 0 表示不限制。")
      .addText((text) =>
        text.setValue(String(settings.agent.maxSteps)).onChange((value) => {
          const count = Number.parseInt(value, 10);
          if (Number.isFinite(count)) void this.plugin.patchAgent({ maxSteps: count });
        }),
      )
      .addText((text) =>
        text.setValue(String(settings.agent.maxTokens)).onChange((value) => {
          const count = Number.parseInt(value, 10);
          if (Number.isFinite(count)) void this.plugin.patchAgent({ maxTokens: count });
        }),
      )
      .addText((text) =>
        text.setValue(String(settings.agent.maxWallMinutes)).onChange((value) => {
          const count = Number.parseInt(value, 10);
          if (Number.isFinite(count)) void this.plugin.patchAgent({ maxWallMinutes: count });
        }),
      )
      .addText((text) =>
        text.setValue(String(settings.agent.maxCostUsd)).onChange((value) => {
          const number = Number.parseFloat(value);
          if (Number.isFinite(number)) void this.plugin.patchAgent({ maxCostUsd: number });
        }),
      );
    new Setting(containerEl)
      .setName("输入：Enter 发送")
      .setDesc("开启：Enter 发送、Shift+Enter 换行；关闭则反过来。")
      .addToggle((toggle) => toggle.setValue(settings.chat.sendOnEnter).onChange((value) => void this.plugin.patchChat({ sendOnEnter: value })));

    new Setting(containerEl).setName("数据").setHeading();
    const countEl = containerEl.createDiv({ cls: "sfc-ai-status" });
    countEl.setText("正在读取会话");
    void this.plugin.conversationCount().then((count) => countEl.setText(`当前有 ${count} 个会话。`));
    new Setting(containerEl)
      .setName("清理空会话")
      .setDesc("删除「未命名会话」且没有任何消息的记录（早期索引故障留下的空壳）。")
      .addButton((button) =>
        button.setButtonText("清理").onClick(async () => {
          const removed = await this.plugin.cleanupEmptyConversations();
          new Notice(removed ? `已清理 ${removed} 个空会话。` : "没有需要清理的空会话。");
          this.display();
        }),
      );
    new Setting(containerEl)
      .setName("重建会话索引")
      .setDesc("索引损坏时使用；正文文件不会被动。")
      .addButton((button) =>
        button.setButtonText("重建").onClick(async () => {
          const result = await this.plugin.rebuildConversationIndex();
          new Notice(result.rebuilt ? `索引已重建，跳过 ${result.skipped.length} 个无法读取的文件。` : "索引本来就是好的。");
        }),
      );
    new Setting(containerEl)
      .setName("导出诊断")
      .setDesc("复制一份不含 Key、不含笔记正文的报告到剪贴板。")
      .addButton((button) =>
        button.setButtonText("复制").onClick(async () => {
          const report = this.plugin.exportDiagnostics();
          try {
            await navigator.clipboard.writeText(report);
            new Notice("诊断报告已复制到剪贴板。");
          } catch {
            new Notice("剪贴板不可用，报告已写入控制台。");
            console.log(report);
          }
        }),
      );
  }

  private secretDescription(origin: "keychain" | "legacy" | "none"): string {
    if (origin === "keychain") return "已存到 Obsidian 钥匙串。";
    if (origin === "legacy") return "当前读的是旧版 data.json 明文，建议迁移。";
    return this.plugin.getSecrets().available ? "还没有保存密钥。" : "这个 Obsidian 版本没有钥匙串（需要 1.11.4+），密钥无法保存。";
  }
}

function splitList(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}