import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import type { AIService, BigGChatCallbacks } from "./aiService";

export type BigGScriptLanguage = "powershell" | "python" | "node";

export interface BigGCodeRunResult {
  ok: boolean;
  attempts: number;
  scriptPath: string;
  output: string;
  log: string[];
}

export interface BigGCodeRunOptions {
  language?: BigGScriptLanguage | "auto";
  maxAttempts?: number;
  model?: string;
  callbacks?: BigGChatCallbacks;
}

const DEFAULT_CODER_MODEL = "deepseek/deepseek-chat";
const DEFAULT_MAX_ATTEMPTS = 3;
const OUTPUT_CAP = 8000;

const GENERATOR_PROMPT = (task: string): string =>
  `You are Big G's Coder agent. Produce a SINGLE standalone script that accomplishes the task below on Windows.

Task: ${task}

Rules:
- Return ONLY one fenced code block. No prose, no bullet points, no explanation.
- Prefer PowerShell unless the task clearly needs Python or Node.js.
- The script must be runnable as-is. It may read/write files and print results to stdout/stderr.
- End the script by clearly printing the final answer.`;

const FIXER_PROMPT = (task: string, output: string): string =>
  `Big G's Coder agent attempted this task:

Task: ${task}

The script was executed and produced the output below (it may contain errors).

--- OUTPUT START ---
${output.slice(0, OUTPUT_CAP)}
--- OUTPUT END ---

Produce a SINGLE corrected, complete standalone script (fenced code block only) that fixes whatever failed and accomplishes the task. Stay in the same language as before. Output only the fenced code block.`;

interface ExtractedScript {
  code: string;
  language: Exclude<BigGScriptLanguage, "auto">;
}

/**
 * CoderService — the code-execution self-fix loop.
 *
 * Pipeline: generate a standalone script from a task via the Coder agent,
 * write it to the OS app-data script dir, execute it through the Rust bridge,
 * and if it fails, feed the output back to the model for a corrected revision
 * and re-run. Repeats up to `maxAttempts`.
 */
export class CoderService {
  private ai: AIService;

  constructor(ai: AIService) {
    this.ai = ai;
  }

  /** Runs the full generate → execute → fix → re-execute loop for a task. */
  async executeTask(task: string, options: BigGCodeRunOptions = {}): Promise<BigGCodeRunResult> {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const log: string[] = [];

    if (!task.trim()) {
      return { ok: false, attempts: 0, scriptPath: "", output: "(empty task)", log };
    }

    const first = this.extractScript(await this.requestCode(GENERATOR_PROMPT(task), options));
    if (!first) {
      const raw = await this.requestCode(GENERATOR_PROMPT(task), options);
      return {
        ok: false,
        attempts: 0,
        scriptPath: "",
        output: raw || "(model returned no script)",
        log: ["Coder agent did not emit a fenced script block."],
      };
    }

    log.push(
      `Generated ${first.code.length}-char ${first.language} script.`,
    );

    let code = first.code;
    const language = first.language;
    let scriptPath = "";
    let output = "";
    let fixes = 0;

    for (let run = 0; run < maxAttempts; run += 1) {
      let runResult: { ok: boolean; output: string; scriptPath: string };
      try {
        runResult = await this.runScript(code, language);
      } catch (error) {
        return {
          ok: false,
          attempts: fixes,
          scriptPath,
          output: String(error),
          log: [...log, `Attempt ${run + 1} could not be executed: ${String(error)}`],
        };
      }

      ({ output } = runResult);
      scriptPath = runResult.scriptPath;
      log.push(
        `Attempt ${run + 1}: ${runResult.ok ? "succeeded" : "failed"} — ${trimForLog(runResult.output)}`,
      );

      if (runResult.ok) {
        return { ok: true, attempts: fixes, scriptPath, output: runResult.output, log };
      }

      if (run === maxAttempts - 1) break;

      const fixText = await this.requestCode(FIXER_PROMPT(task, runResult.output), options);
      const fixed = this.extractScript(fixText);
      if (!fixed) {
        log.push(`Coder revision ${fixes + 1} contained no script block — abandoning loop.`);
        break;
      }
      fixes += 1;
      code = fixed.code;
      log.push(`Coder emitted revision ${fixes}.`);
    }

    return { ok: false, attempts: fixes, scriptPath, output, log };
  }

  /** Executes a raw script once (no fix loop) — used by the run_code tool. */
  async runRaw(
    code: string,
    language: BigGScriptLanguage | "auto" = "auto",
  ): Promise<string> {
    const parsed = this.parseInline(code, language);
    if (!parsed) {
      return "run_raw_code: could not determine a runnable script from the provided code.";
    }
    const result = await this.runScript(parsed.code, parsed.language);
    return result.output;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private async requestCode(prompt: string, options: BigGCodeRunOptions): Promise<string> {
    const model = options.model ?? DEFAULT_CODER_MODEL;
    try {
      const result = await this.ai.streamChat(
        [
          {
            role: "system",
            content:
              "You are Big G's Coder agent. You always produce complete, correct, self-contained scripts. Output only fenced code blocks when asked.",
          },
          { role: "user", content: prompt },
        ],
        options.callbacks ?? {},
        { model },
      );
      return result.text.trim();
    } catch (error) {
      return "";
    }
  }

  private extractScript(text: string): ExtractedScript | null {
    const fence = /```([a-zA-Z0-9+_-]*)\r?\n([\s\S]*?)(?:```|$)/;
    const match = fence.exec(text.trim());
    if (match) {
      const tag = match[1]?.toLowerCase() ?? "";
      const language = languageFromTag(tag);
      return { code: match[2]?.trim() ?? "", language };
    }
    return null;
  }

  private parseInline(
    text: string,
    requested: BigGScriptLanguage | "auto",
  ): ExtractedScript | null {
    const fenced = this.extractScript(text);
    if (fenced) return fenced;
    const trimmed = text.trim();
    if (!trimmed) return null;
    return { code: trimmed, language: requested === "auto" ? "powershell" : requested };
  }

  private async runScript(
    code: string,
    language: Exclude<BigGScriptLanguage, "auto">,
  ): Promise<{ ok: boolean; output: string; scriptPath: string }> {
    const dir = await appDataDir();
    const sep = dir.endsWith("\\") || dir.endsWith("/") ? "" : "\\";
    const ext = EXTENSION[language];
    const scriptPath = `${dir}${sep}big-g-scripts${sep}script-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.${ext}`;

    await invoke<void>("write_local_file", { path: scriptPath, content: code });

    const { command, args } = runtimeCommand(language, scriptPath);
    try {
      const output = await invoke<string>("execute_windows_command", { command, args });
      return { ok: true, output, scriptPath };
    } catch (error) {
      return { ok: false, output: String(error), scriptPath };
    }
  }
}

const EXTENSION: Record<BigGScriptLanguage, string> = {
  powershell: "ps1",
  python: "py",
  node: "js",
};

function runtimeCommand(
  language: Exclude<BigGScriptLanguage, "auto">,
  scriptPath: string,
): { command: string; args: string[] } {
  switch (language) {
    case "powershell":
      return {
        command: "powershell",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      };
    case "python":
      return { command: "python", args: [scriptPath] };
    case "node":
      return { command: "node", args: [scriptPath] };
  }
}

function trimForLog(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 200 ? `${single.slice(0, 200)}…` : single;
}

function languageFromTag(tag: string): Exclude<BigGScriptLanguage, "auto"> {
  if (/py/.test(tag)) return "python";
  if (/js|ts|node/.test(tag)) return "node";
  return "powershell";
}