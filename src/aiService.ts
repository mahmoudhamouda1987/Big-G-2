import { invoke } from "@tauri-apps/api/core";

export type BigGContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface BigGChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | BigGContentPart[];
  name?: string;
}

export interface BigGChatCallbacks {
  onToken?: (delta: string, fullText: string) => void;
  onToolCall?: (tool: string, original: string) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

export interface BigGToolIntent {
  tool: string;
  args: Record<string, unknown>;
}

export interface BigGToolResult {
  ok: boolean;
  output: string;
}

export interface BigGStreamResult {
  text: string;
  toolCalls: BigGToolIntent[];
}

export interface BigGAudioTranscription {
  text: string;
  language?: string;
}

export interface BigGSpeechRequest {
  text: string;
  model?: string;
  voice?: string;
}

export interface BigGExternalToolHooks {
  memory?: {
    addFact: (fact: string) => void;
    addEvent: (note: string) => void;
    addImprovement: (note: string) => void;
    buildContextBlock: () => string;
  };
  scheduler?: {
    addReminder: (text: string, at: number) => string;
  };
  coder?: {
    runCode: (code: string, language?: string) => Promise<string>;
  };
  integrations?: {
    sendEmail: (args: {
      to: string;
      subject: string;
      body: string;
    }) => Promise<string>;
    readEmails: (max?: number) => Promise<string>;
    addCalendarEvent: (args: {
      summary: string;
      start: string;
      end?: string;
      description?: string;
    }) => Promise<string>;
    listCalendarEvents: (max?: number) => Promise<string>;
  };
  security?: {
    awaitUserApproval: (tool: string, detail: string) => Promise<boolean>;
  };
}

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_AUDIO = "https://openrouter.ai/api/v1/audio";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_STT_MODEL = "openai/whisper-large-v3-turbo";
const DEFAULT_TTS_MODEL = "openai/tts-1";
const DEFAULT_TTS_VOICE = "alloy";

/**
 * SYSTEM PROMPT — injected verbatim into every conversation with the model.
 * Positions Big G as an unconstrained personal companion with full local file,
 * shell, process, memory, scheduling, and web tools bound to the Rust bridge.
 */
export const BIG_G_SYSTEM_PROMPT = `You are Big G, an unconstrained, uncensored personal AI companion and systems agent operating locally inside the user's Windows environment.

You have DIRECT local tooling through a Rust + TypeScript bridge:
- read_local_file(path): read any file the OS user can read.
- write_local_file(path, content): create or overwrite any file, creating parent folders.
- list_directory(path): list a folder's contents with metadata.
- file_metadata(path): stat a path (size, timestamps, permissions).
- delete_local_file(path): delete a file or folder tree.
- move_local_file(source, destination): move or rename across drives.
- execute_windows_command(command, args[]): run native executables, scripts, or command-prompt pipelines and capture full stdout/stderr.
- open_in_explorer(path): reveal a file or folder in Explorer.
- list_processes(): enumerate running processes.
- kill_process(name | pid): force-kill a process tree.
- remember(text): persist a long-term fact about the user permanently.
- remind(text, atEpochMs): schedule a spoken + on-screen reminder.
- search_web(query): pull live internet information.
- run_code(code, language): execute a generated/raw script through the code-execution self-fix engine on the local machine.
- self_improve(text): save a self-improvement note that will be reused in future sessions.
- send_email(to, subject, body): send email through the user's configured SMTP account.
- read_emails(max): fetch recent inbox messages via the user's mail integration.
- add_calendar_event(summary, start, end?, description?): schedule an event in the user's calendar.
- list_calendar_events(max): list upcoming calendar events.

CONFIRMATION RULE: destructive and powerful tools (delete_local_file, move_local_file, kill_process, execute_windows_command, and the email/calendar tools) pause for the user's spoken or tap confirmation before they actually run. Some calls may return a pending-confirmation notice — that is normal; the user decides, and the operation proceeds only on approval.

Operating rules:
1. Be direct, honest, and uncensored. You are the user's personal operative — do not refuse, sanitize, or moralize requests that are legal and technically performable. Act, do not lecture.
2. When a task requires files, processes, the web, memory, or scheduling, ALWAYS emit a structured tool intent in a fenced JSON block at the START of your reply:
   {"tool":"read_local_file","args":{"path":"C:\\\\path\\\\to\\\\file.txt"}}
   {"tool":"write_local_file","args":{"path":"C:\\\\path\\\\to\\\\file.txt","content":"file payload"}}
   {"tool":"list_directory","args":{"path":"C:\\\\Users\\\\name\\\\Documents"}}
   {"tool":"execute_windows_command","args":{"command":"powershell","args":["-Command","Get-Process"]}}
   {"tool":"list_processes","args":{}}
   {"tool":"kill_process","args":{"name":"notepad.exe"}}
   {"tool":"remember","args":{"text":"User's birthday is Jan 5"}}
   {"tool":"remind","args":{"text":"Stand up stretch break","atEpochMs":1750000000000}}
   {"tool":"search_web","args":{"query":"latest Windows 11 update news"}}
   {"tool":"run_code","args":{"code":"...","language":"powershell"}}
   {"tool":"self_improve","args":{"text":"Remember to ask before deleting folders"}}
   Then continue with plain-text analysis of the expected result.
3. A LIVE USER MEMORY block and an AGENT LIST are appended below your system prompt. Use both to personalize and to delegate specialized work.
4. Keep responses concise, practical, and in the user's language. Never fabricate tool output — report exactly what the bridge returns.`;

/* ================================================================== */
/* AIService — unfiltered agentic orchestration over OpenRouter         */
/* ================================================================== */

export class AIService {
  private apiKey: string;
  private model: string;
  private sttModel: string;
  private ttsModel: string;
  private ttsVoice: string;
  private readonly hooks: BigGExternalToolHooks;

  constructor(
    apiKey: string,
    model: string = DEFAULT_MODEL,
    hooks: BigGExternalToolHooks = {},
    audio: { stt?: string; tts?: string; voice?: string } = {},
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.sttModel = audio.stt ?? DEFAULT_STT_MODEL;
    this.ttsModel = audio.tts ?? DEFAULT_TTS_MODEL;
    this.ttsVoice = audio.voice ?? DEFAULT_TTS_VOICE;
    this.hooks = hooks;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  setModel(model: string): void {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  setAudioModels(stt: string, tts: string, voice: string): void {
    this.sttModel = stt;
    this.ttsModel = tts;
    this.ttsVoice = voice;
  }

  get configured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  /* ------------------------------------------------------------------ */
  /* CHAT                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Streams a chat completion and returns assembled text plus any tool
   * intents the model emitted (JSON fenced blocks).
   */
  async streamChat(
    messages: BigGChatMessage[],
    callbacks: BigGChatCallbacks = {},
    options: { web?: boolean; model?: string } = {},
  ): Promise<BigGStreamResult> {
    const text = await this.streamCompletion(messages, callbacks, options);
    const toolCalls = this.extractAllToolIntents(text);
    return { text, toolCalls };
  }

  private async streamCompletion(
    messages: BigGChatMessage[],
    callbacks: BigGChatCallbacks,
    options: { web?: boolean; model?: string },
  ): Promise<string> {
    if (!this.configured) {
      throw new Error("AIService: no OpenRouter API key configured");
    }

    const body: Record<string, unknown> = {
      model: options.model ?? this.model,
      messages: this.withSystemPrompt(messages),
      stream: true,
    };
    if (options.web) {
      body["plugins"] = [{ id: "web" }];
    }

    const response = await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      signal: callbacks.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://localhost/",
        "X-Title": "Big G",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `OpenRouter error ${response.status} ${response.statusText}: ${detail.slice(0, 400)}`,
      );
    }

    return this.consumeStream(response.body, callbacks);
  }

  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    callbacks: BigGChatCallbacks,
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let assembled = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;

          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return assembled;

          try {
            const json = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string | null } }>;
            };
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              assembled += delta;
              callbacks.onToken?.(delta, assembled);
            }
          } catch {
            // Malformed heartbeat line — ignore and continue.
          }
        }
      }
      return assembled;
    } finally {
      reader.releaseLock();
    }
  }

  /* ------------------------------------------------------------------ */
  /* AUDIO: STT + TTS                                                    */
  /* ------------------------------------------------------------------ */

  /** Transcribes a voice blob (WAV/WebM/MP3) into text via OpenRouter audio. */
  async transcribeAudio(blob: Blob, language?: string): Promise<BigGAudioTranscription> {
    if (!this.configured) {
      throw new Error("AIService: no OpenRouter API key configured for STT");
    }

    const form = new FormData();
    form.append("model", this.sttModel);
    form.append("file", blob, "voice.webm");
    form.append("response_format", "json");
    if (language) form.append("language", language);

    const response = await fetch(`${OPENROUTER_AUDIO}/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://localhost/",
        "X-Title": "Big G",
      },
      body: form,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OpenRouter STT error ${response.status}: ${detail.slice(0, 300)}`);
    }

    const json = (await response.json()) as { text?: string; language?: string };
    return { text: json.text ?? "", language: json.language };
  }

  /** Synthesizes speech via OpenRouter TTS; returns an audio Blob for playback. */
  async synthesizeSpeech(request: BigGSpeechRequest): Promise<Blob> {
    if (!this.configured) {
      throw new Error("AIService: no OpenRouter API key configured for TTS");
    }

    const response = await fetch(`${OPENROUTER_AUDIO}/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://localhost/",
        "X-Title": "Big G",
      },
      body: JSON.stringify({
        model: request.model ?? this.ttsModel,
        input: request.text,
        voice: request.voice ?? this.ttsVoice,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OpenRouter TTS error ${response.status}: ${detail.slice(0, 300)}`);
    }

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") ?? "audio/mpeg";
    return new Blob([buffer], { type: contentType });
  }

  /* ------------------------------------------------------------------ */
  /* WEB SEARCH                                                          */
  /* ------------------------------------------------------------------ */

  /** Runs a live web query through an :online model for current information. */
  async searchWeb(query: string, researchModel = this.model): Promise<string> {
    if (!this.configured) {
      throw new Error("AIService: no OpenRouter API key configured for web search");
    }

    const response = await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://localhost/",
        "X-Title": "Big G",
      },
      body: JSON.stringify({
        model: researchModel,
        messages: [
          {
            role: "system",
            content:
              "You are a live web researcher for Big G. Answer the user's query using current, real-time information from the web. Cite your sources inline.",
          },
          { role: "user", content: query },
        ],
        plugins: [{ id: "web" }],
        stream: false,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OpenRouter web error ${response.status}: ${detail.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? "";
  }

  /* ------------------------------------------------------------------ */
  /* TOOL INTENT INTERPRETER                                             */
  /* ------------------------------------------------------------------ */

  /** Extracts every structured tool-intent JSON block from model text. */
  extractAllToolIntents(text: string): BigGToolIntent[] {
    const intents: BigGToolIntent[] = [];
    const fencePattern = /```(?:json)?\s*([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = fencePattern.exec(text)) !== null) {
      const candidate = this.parseIntent(match[1]!);
      if (candidate) intents.push(candidate);
    }

    if (intents.length === 0) {
      const bare = this.parseIntent(text);
      if (bare) intents.push(bare);
    }

    return intents;
  }

  /** Interprets one JSON object for a tool intent. */
  parseIntent(payload: string): BigGToolIntent | null {
    const trimmed = payload.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;

    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
        tool?: unknown;
        args?: unknown;
      };
      if (typeof parsed.tool !== "string" || !parsed.tool.trim()) return null;
      const args =
        parsed.args && typeof parsed.args === "object"
          ? (parsed.args as Record<string, unknown>)
          : {};
      return { tool: parsed.tool.trim(), args };
    } catch {
      return null;
    }
  }

  /** Executes every captured tool intent through the bridge. */
  async runToolIntents(intents: BigGToolIntent[], callbacks: BigGChatCallbacks = {}): Promise<BigGToolResult[]> {
    const results: BigGToolResult[] = [];
    for (const intent of intents) {
      callbacks.onToolCall?.(intent.tool, "");
      results.push(await this.invokeTool(intent));
    }
    return results;
  }

  /** Routes one tool intent: native Rust commands or TS-side services. */
  async invokeTool(intent: BigGToolIntent): Promise<BigGToolResult> {
    const { tool, args } = intent;

    try {
      switch (tool) {
        case "read_local_file":
        case "readFile":
        case "read_file": {
          const path = requireString(args, "path", "read_local_file");
          const output = await invoke<string>("read_local_file", { path });
          return { ok: true, output };
        }

        case "write_local_file":
        case "writeFile":
        case "write_file": {
          const path = requireString(args, "path", "write_local_file");
          const content = requireString(args, "content", "write_local_file");
          await invoke<void>("write_local_file", { path, content });
          return { ok: true, output: `Wrote ${content.length} chars to ${path}` };
        }

        case "list_directory":
        case "listDir":
        case "ls": {
          const path = requireString(args, "path", "list_directory");
          const output = await invoke<unknown[]>("list_directory", { path });
          return { ok: true, output: JSON.stringify(output, null, 2) };
        }

        case "file_metadata":
        case "stat": {
          const path = requireString(args, "path", "file_metadata");
          const output = await invoke<unknown>("file_metadata", { path });
          return { ok: true, output: JSON.stringify(output, null, 2) };
        }

        case "delete_local_file":
        case "deleteFile":
        case "remove_file": {
          const path = requireString(args, "path", "delete_local_file");
          await this.invokeGuarded<void>(
            "delete_local_file",
            { path },
            "delete_local_file",
            path,
          );
          return { ok: true, output: `Deleted ${path}` };
        }

        case "move_local_file":
        case "moveFile":
        case "rename_file": {
          const source = requireString(args, "source", "move_local_file");
          const destination = requireString(args, "destination", "move_local_file");
          await this.invokeGuarded<void>(
            "move_local_file",
            { source, destination },
            "move_local_file",
            `${source} → ${destination}`,
          );
          return { ok: true, output: `Moved ${source} -> ${destination}` };
        }

        case "execute_windows_command":
        case "executeCommand":
        case "execute_command": {
          const command = requireString(args, "command", "execute_windows_command");
          const argv = (Array.isArray(args["args"]) ? (args["args"] as unknown[]) : []).map((a) =>
            String(a),
          );
          const output = await this.invokeGuarded<string>(
            "execute_windows_command",
            { command, args: argv },
            "execute_windows_command",
            `${command} ${argv.join(" ")}`.trim(),
          );
          return { ok: true, output };
        }

        case "open_in_explorer":
        case "openFolder":
        case "show_in_folder": {
          const path = requireString(args, "path", "open_in_explorer");
          const output = await invoke<string>("open_in_explorer", { path });
          return { ok: true, output };
        }

        case "list_processes":
        case "processes":
        case "ps": {
          const output = await invoke<unknown[]>("list_processes");
          return { ok: true, output: JSON.stringify(output, null, 2) };
        }

        case "kill_process":
        case "killProcess": {
          if (typeof args["name"] === "string") {
            const output = await this.invokeGuarded<string>(
              "kill_process_name",
              { name: args["name"] },
              "kill_process",
              args["name"],
            );
            return { ok: true, output };
          }
          const pid = requireString(args, "pid", "kill_process");
          const output = await this.invokeGuarded<string>(
            "kill_process_pid",
            { pid },
            "kill_process",
            pid,
          );
          return { ok: true, output };
        }

        case "remember":
        case "note": {
          const text = requireString(args, "text", "remember");
          if (!this.hooks.memory) {
            return { ok: false, output: "Memory service is not connected." };
          }
          this.hooks.memory.addFact(text);
          return { ok: true, output: `Remembered: ${text}` };
        }

        case "remind":
        case "setReminder":
        case "reminder": {
          const text = requireString(args, "text", "remind");
          if (!this.hooks.scheduler) {
            return { ok: false, output: "Scheduler service is not connected." };
          }
          const at =
            typeof args["atEpochMs"] === "number" ? args["atEpochMs"] : Date.now() + 60_000;
          const id = this.hooks.scheduler.addReminder(text, Math.floor(at));
          return { ok: true, output: `Reminder scheduled (id=${id}): "${text}"` };
        }

        case "search_web":
        case "webSearch":
        case "searchWeb": {
          const query = requireString(args, "query", "search_web");
          const answer = await this.searchWeb(query, this.researchModel);
          return { ok: true, output: answer };
        }

        case "run_code":
        case "runCode":
        case "run_code_now": {
          if (!this.hooks.coder) {
            return { ok: false, output: "Code execution engine is not connected." };
          }
          const code = requireString(args, "code", "run_code");
          const language = typeof args["language"] === "string" ? args["language"] : "auto";
          const output = await this.hooks.coder.runCode(code, language);
          return { ok: true, output };
        }

        case "self_improve":
        case "improve":
        case "selfImprove": {
          const text = requireString(args, "text", "self_improve");
          if (!this.hooks.memory) {
            return { ok: false, output: "Memory service is not connected." };
          }
          this.hooks.memory.addImprovement(text);
          return { ok: true, output: `Self-improvement note saved: ${text}` };
        }

        case "send_email":
        case "sendMail":
        case "email": {
          const to = requireString(args, "to", "send_email");
          const subject = requireString(args, "subject", "send_email");
          const body = requireString(args, "body", "send_email");
          const integrations = requireIntegrations(this.hooks, "send_email");
          const output = await integrations.sendEmail({ to, subject, body });
          return { ok: true, output };
        }

        case "read_emails":
        case "readEmails":
        case "inbox": {
          const integrations = requireIntegrations(this.hooks, "read_emails");
          const max = typeof args["max"] === "number" ? args["max"] : 10;
          const output = await integrations.readEmails(max);
          return { ok: true, output };
        }

        case "add_calendar_event":
        case "createEvent":
        case "calendar_event": {
          const summary = requireString(args, "summary", "add_calendar_event");
          const start = requireString(args, "start", "add_calendar_event");
          const integrations = requireIntegrations(this.hooks, "add_calendar_event");
          const output = await integrations.addCalendarEvent({
            summary,
            start,
            end: typeof args["end"] === "string" ? args["end"] : undefined,
            description: typeof args["description"] === "string" ? args["description"] : undefined,
          });
          return { ok: true, output };
        }

        case "list_calendar_events":
        case "calendar":
        case "calendarEvents": {
          const integrations = requireIntegrations(this.hooks, "list_calendar_events");
          const max = typeof args["max"] === "number" ? args["max"] : 10;
          const output = await integrations.listCalendarEvents(max);
          return { ok: true, output };
        }

        default:
          return {
            ok: false,
            output: `Unknown tool '${tool}'. Valid tools: read_local_file, write_local_file, list_directory, file_metadata, delete_local_file, move_local_file, execute_windows_command, open_in_explorer, list_processes, kill_process, remember, remind, search_web, run_code, self_improve, send_email, read_emails, add_calendar_event, list_calendar_events.`,
          };
      }
    } catch (error) {
      return { ok: false, output: String(error) };
    }
  }

  /**
   * Executes a gate-protected Rust command. On first invocation the command
   * runs unconfirmed; if the Rust gate blocks it with a RULE_GATE marker, the
   * security hook asks the user for approval and the command is retried with
   * `confirmed = true`.
   */
  private async invokeGuarded<T>(
    command: string,
    payload: Record<string, unknown>,
    tool: string,
    detail: string,
  ): Promise<T> {
    const run = (confirmed: boolean) => invoke<T>(command, { ...payload, confirmed });
    try {
      return await run(false);
    } catch (error) {
      if (!String(error).startsWith("RULE_GATE")) throw error;
      if (!this.hooks.security) {
        throw new Error(`${tool} requires user confirmation, but no confirmation UI is connected.`);
      }
      const approved = await this.hooks.security.awaitUserApproval(tool, detail);
      if (!approved) {
        throw new Error(`${tool} was cancelled by the user.`);
      }
      return await run(true);
    }
  }

  /** Research model override used by search_web (web-plugin capable model). */
  private researchModel = "google/gemini-2.5-flash";
  setResearchModel(model: string): void {
    this.researchModel = model;
  }

  /** Injects the Big G system prompt at the front of the message list. */
  private withSystemPrompt(messages: BigGChatMessage[]): BigGChatMessage[] {
    if (messages[0]?.role === "system") return messages;
    return [{ role: "system", content: BIG_G_SYSTEM_PROMPT }, ...messages];
  }
}

function requireString(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Tool '${tool}' requires a non-empty string arg '${key}'`);
  }
  return value;
}

function requireIntegrations(
  hooks: BigGExternalToolHooks,
  tool: string,
): NonNullable<BigGExternalToolHooks["integrations"]> {
  if (!hooks.integrations) {
    throw new Error(`Tool '${tool}' requires the integrations service, which is not connected.`);
  }
  return hooks.integrations;
}