/**
 * The tool loop: delta merging, the approval state machine, and the bounded loop.
 *
 * ## Why the default is one iteration
 *
 * Smart Composer's default `maxAutoIterations` is 1: the model may ask for one
 * tool call, the result is fed back, and the user sees the answer. A model that
 * can silently call ten tools is a model that can read ten files and spend ten
 * requests while the user watches a spinner. The cap is a cost and privacy
 * control, not an implementation detail.
 *
 * ## Read-only is a property of the tool, not of the prompt
 *
 * `execute` is supplied by the host, and the loop refuses to auto-run anything
 * that is not declared `readOnly`. A tool that writes always lands in
 * `pending_approval`, whatever the conversation's allow-list says -- "allow for
 * this conversation" is consent for reads, never a blanket write permission.
 *
 * Pure: no sockets, no vault; the model turn and the tool execution are both
 * injected.
 */

import { type AiChatMessage, type AiChatReply, type AiStreamEvent, type AiToolCall } from "./aiChat";

export type AiToolStatus = "pending_approval" | "running" | "success" | "error" | "rejected" | "aborted";

export interface AiHostTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** True only for tools with no side effects. */
  readOnly: boolean;
  execute(args: Record<string, unknown>, context: { signal?: AbortSignal }): Promise<string>;
}

export interface AiToolCallState {
  call: AiToolCall;
  status: AiToolStatus;
  result?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface AiToolLoopResult {
  messages: AiChatMessage[];
  toolStates: AiToolCallState[];
  iterations: number;
  stopped: "done" | "max_iterations" | "pending_approval" | "aborted";
}

/**
 * Merge streamed tool-call deltas by `index`.
 *
 * OpenAI streams an id and name once and the arguments in pieces; DeepSeek does
 * the same through the OpenAI shape; Gemini and Anthropic send whole calls. The
 * first non-empty id/name wins (later frames repeat or omit them) and argument
 * fragments are concatenated in arrival order.
 */
export function mergeToolCallDeltas(events: readonly Extract<AiStreamEvent, { type: "tool_call" }>[]): AiToolCall[] {
  const byIndex = new Map<number, AiToolCall>();
  for (const event of events) {
    const prior = byIndex.get(event.index) ?? { id: "", name: "", arguments: "" };
    byIndex.set(event.index, {
      id: prior.id || event.id || "",
      name: prior.name || event.name || "",
      arguments: `${prior.arguments ?? ""}${event.arguments ?? ""}`,
    });
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({
      id: call.id || `tool_call_${index + 1}`,
      name: call.name,
      arguments: call.arguments || "{}",
    }))
    .filter((call) => Boolean(call.name));
}

/** Parse a tool call's arguments; a malformed string becomes an explicit error state. */
export function parseToolArguments(call: AiToolCall): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const parsed: unknown = JSON.parse(call.arguments || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, message: `工具 ${call.name} 的参数不是对象。` };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false, message: `工具 ${call.name} 的参数不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface AiToolLoopOptions {
  /** Hard cap on model turns after the first. Default 1, as the plan requires. */
  maxAutoIterations?: number;
  /** Conversation-scoped allow-list; only read-only tools can be auto-run. */
  isAllowed(call: AiToolCall, tool: AiHostTool | undefined): boolean;
  tools: readonly AiHostTool[];
  signal?: AbortSignal;
  onToolUpdate?: (state: AiToolCallState) => void;
  onAssistant?: (reply: AiChatReply) => void;
  now?: () => number;
}

/**
 * Run one assistant turn and, if it asks for tools, execute what is allowed.
 *
 * `request` is called with the message list built so far and must return the
 * assistant reply. The loop stops at `pending_approval` rather than guessing:
 * the UI owns the buttons, and the loop resumes from the returned message list
 * when the user answers.
 */
export async function runToolLoop(input: {
  messages: AiChatMessage[];
  request: (messages: AiChatMessage[], signal?: AbortSignal) => Promise<AiChatReply>;
  options: AiToolLoopOptions;
}): Promise<AiToolLoopResult> {
  const maxIterations = Math.max(1, Math.floor(input.options.maxAutoIterations ?? 1));
  const messages = [...input.messages];
  const states: AiToolCallState[] = [];
  let iterations = 0;
  for (let round = 0; round < maxIterations; round += 1) {
    if (input.options.signal?.aborted) return { messages, toolStates: states, iterations, stopped: "aborted" };
    const reply = await input.request(messages, input.options.signal);
    iterations += 1;
    input.options.onAssistant?.(reply);
    messages.push({
      role: "assistant",
      content: reply.text,
      toolCalls: reply.toolCalls,
      ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
    });
    if (!reply.toolCalls.length) return { messages, toolStates: states, iterations, stopped: "done" };

    const roundStates: AiToolCallState[] = reply.toolCalls.map((call) => ({ call, status: "pending_approval" }));
    let waiting = false;
    for (const state of roundStates) {
      const tool = input.options.tools.find((entry) => entry.name === state.call.name);
      const parsed = parseToolArguments(state.call);
      if (!parsed.ok) {
        state.status = "error";
        state.error = parsed.message;
      } else if (!tool) {
        state.status = "error";
        state.error = `模型请求了未知工具：${state.call.name}`;
      } else if (!input.options.isAllowed(state.call, tool) || !tool.readOnly) {
        // Read-only is enforced here, not trusted from the allow-list: a
        // conversation may have allowed a writing tool earlier, and that must
        // still come back as an approval.
        state.status = "pending_approval";
        waiting = true;
      } else {
        state.status = "running";
        state.startedAt = input.options.now?.() ?? Date.now();
        input.options.onToolUpdate?.(state);
        try {
          state.result = await tool.execute(parsed.args, { signal: input.options.signal });
          state.status = "success";
        } catch (error) {
          state.status = "error";
          state.error = error instanceof Error ? error.message : String(error);
        }
        state.endedAt = input.options.now?.() ?? Date.now();
      }
      input.options.onToolUpdate?.(state);
      states.push(state);
    }

    // Tool results for completed calls go back to the model; pending ones do not.
    for (const state of roundStates) {
      if (state.status === "success" || state.status === "error") {
        messages.push({
          role: "tool",
          content: state.status === "success" ? state.result ?? "" : `工具执行失败：${state.error ?? ""}`,
          toolCallId: state.call.id,
          name: state.call.name,
        });
      }
    }
    if (waiting) return { messages, toolStates: states, iterations, stopped: "pending_approval" };
    if (round === maxIterations - 1) return { messages, toolStates: states, iterations, stopped: "max_iterations" };
  }
  return { messages, toolStates: states, iterations, stopped: "max_iterations" };
}

/** Run one pending call after the user approved it. */
export async function executeApprovedTool(
  state: AiToolCallState,
  tool: AiHostTool,
  options: { signal?: AbortSignal; now?: () => number } = {},
): Promise<AiToolCallState> {
  const parsed = parseToolArguments(state.call);
  const next: AiToolCallState = { ...state, status: "running", startedAt: options.now?.() ?? Date.now() };
  if (!parsed.ok) {
    next.status = "error";
    next.error = parsed.message;
    next.endedAt = options.now?.() ?? Date.now();
    return next;
  }
  try {
    next.result = await tool.execute(parsed.args, { signal: options.signal });
    next.status = "success";
  } catch (error) {
    next.status = "error";
    next.error = error instanceof Error ? error.message : String(error);
  }
  next.endedAt = options.now?.() ?? Date.now();
  return next;
}

/** The tool messages to append once every state in a round is resolved. */
export function toolResultMessages(states: readonly AiToolCallState[]): AiChatMessage[] {
  return states
    .filter((state) => state.status === "success" || state.status === "error")
    .map((state) => ({
      role: "tool" as const,
      content: state.status === "success" ? state.result ?? "" : `工具执行失败：${state.error ?? ""}`,
      toolCallId: state.call.id,
      name: state.call.name,
    }));
}