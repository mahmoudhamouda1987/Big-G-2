# Big G

Big G is an uncensored, multi-modal **AI personal assistant desktop overlay** for Windows. It is a transparent, draggable **250×250 glowing orb** that floats on top of any application. It sees you (webcam), hears you (microphone), thinks via OpenRouter's open-weights models, executes native OS/file/process operations through a memory-safe Rust bridge, and talks back with synthesized speech.

No dedicated GPU is required — all heavy cognition runs in the cloud through OpenRouter, while everything that touches your machine runs locally in a Tauri v2 / Rust process.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Tauri v2 WebView (transparent overlay, 250×250, no frame)    │
│                                                               │
│  src/mediaService.ts     mic volume + webcam base64 frames     │
│  src/voiceService.ts     STT (OpenRouter) + TTS playback       │
│  src/aiService.ts        streaming chat + tool interpreter     │
│  src/agentHub.ts         chat/coder/vision/research/media      │
  │  src/coderService.ts     code-execution self-fix loop          │
  │  src/memoryService.ts    persistent long-term memory           │
│  src/schedulerService.ts reminders + native notifications      │
│  src/proactiveService.ts anticipation / suggestions            │
│  src/main.ts             orb state machine + orchestration     │
└──────────────▲──────────────────────────────┬──────────────────┘
          invoke (IPC)                    fetch (HTTPS)
┌──────────────┴─────────────────────────────┴──────────────────┐
│  Rust bridge (src-tauri/…/lib.rs)          OpenRouter API        │
│  read/write/list/delete/move files          • chat completions   │
│  execute_windows_command (cmd /C fallback)  • audio transcription│
│  process list/kill                          • text-to-speech     │
│  open_in_explorer                           • web search plugin  │
└──────────────────────────────────────────────────────────────┘
```

### Layers

| Layer | Technology | Role |
|---|---|---|
| Frontend | TypeScript + Vite + Tailwind | Orb UI, animation states, orchestration |
| Bridge | Rust (Tauri v2) | File CRUD, shell/process execution, folder locking-safe IO |
| Cognition | OpenRouter API | LLM chat, STT, TTS, vision frames, web research |
| Persistence | OS app-data JSON | Facts, preferences, events, reminders |

---

## Features

- **Talking round shape** — draggable always-on-top orb with four animated states (IDLE blue pulse, LISTENING emerald shockwave, THINKING cosmic swirl, SPEAKING warm pulse)
- **Sees you** — webcam frames captured and injected as vision context per turn
- **Hears you** — volume-segmented mic capture → OpenRouter transcription
- **Talks back** — OpenRouter TTS synthesized speech from the orb
- **Full file access** — read, write, list, stat, delete, move across your drives
- **OS automation** — run any command, script, or utility; manage processes; open Explorer
- **Memory** — learns facts, preferences, and routines; persists across restarts
- **Reminders** — spoken + native Windows notifications
- **Multi-agent** — delegates to specialized models (coding, vision, research/media)
- **Web research** — live internet queries via an `:online` research agent
- **Uncensored by design** — the system prompt forbids refusals; user overrides are law

---

## Getting started

### Prerequisites

- Windows 10/11 with **WebView2** (built into Windows 11)
- [Rust](https://rustup.rs) (stable) — MSVC toolchain
- [Node.js](https://nodejs.org) ≥ 18
- An [OpenRouter](https://openrouter.ai) API key

### Install & run (dev)

```powershell
npm install
copy .env.example .env        # then put your real key in .env
npm run tauri dev
```

### Install & run (release)

```powershell
npm install
npm run tauri build           # produces NSIS installer in src-tauri/target/release/bundle
```

### Environment variables (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `VITE_OPENROUTER_API_KEY` | — | Required; streamed into the frontend bundle |
| `VITE_OPENROUTER_MODEL` | `openai/gpt-4o-mini` | Core thinking model |
| `VITE_OPENROUTER_STT_MODEL` | `openai/whisper-large-v3-turbo` | Speech-to-text |
| `VITE_OPENROUTER_TTS_MODEL` | `openai/tts-1` | Text-to-speech |
| `VITE_OPENROUTER_VOICE` | `alloy` | TTS voice |
| `VITE_OPENROUTER_RESEARCH_MODEL` | `google/gemini-2.5-flash` | Web-search agent |

> **Audio balance note:** OpenRouter requires a minimum **$0.50 account balance** for the
> audio (STT/TTS) endpoints. Voice-in/voice-out stay silent until that balance exists;
> chat, tools, and web research work regardless.

---

## How to use

Big G launches as an always-on-top desktop HUD with three zones:

- **Left — the orb.** Tap it (no drag) to wake/sleep listening. Drag it to move the window.
- **Center — chat.** Type any message or command and press Enter even when the orb is listening.
- **Right — function buttons.** Mic (toggle listening), Voice (mute/silence TTS), Cam (revoke/restore camera), Agents, Memory, and Settings.

Other controls:

1. **Wake the orb** — tap it (a click without dragging). Big G requests mic+camera.
2. **Talk** — speak; the emerald shockwave shows capture. On a pause, Big G transcribes, thinks (cosmic swirl), executes any tool intents, then speaks back (warm pulse).
3. **Mute** — the **Voice** button silences TTS output; **Mic** stops listening; **Cam** turns off the camera entirely.
4. **Settings** — paste your OpenRouter key and tune models/voice/email/calendar/security *at runtime*; changes apply immediately (saved in memory, no restart).
5. **Agents** — activate any agent to route the next conversation through a dedicated model (Coder, Vision, Researcher, Media).
6. **Memory** — inspect everything Big G remembers and add facts directly.
7. **Move / Sleep** — drag the orb or the header anywhere; press `Esc` to sleep, close, or cancel an approval prompt.
8. **Reminders** — say or type something like *"remind me to call Sarah at 5pm"*.

---

## Tool intent protocol

The model emits fenced JSON tool intents at the start of a reply. The bridge executes them and feeds results back:

```json
{"tool":"read_local_file","args":{"path":"C:\\path\\to\\file.txt"}}
{"tool":"write_local_file","args":{"path":"C:\\path\\out.txt","content":"hello"}}
{"tool":"list_directory","args":{"path":"C:\\Users\\you\\Documents"}}
{"tool":"file_metadata","args":{"path":"C:\\x.txt"}}
{"tool":"delete_local_file","args":{"path":"C:\\x.txt"}}
{"tool":"move_local_file","args":{"source":"C:\\a.txt","destination":"D:\\b.txt"}}
{"tool":"execute_windows_command","args":{"command":"powershell","args":["-Command","Get-Process"]}}
{"tool":"open_in_explorer","args":{"path":"C:\\Users\\you"}}
{"tool":"list_processes","args":{}}
{"tool":"kill_process","args":{"name":"notepad.exe"}}
{"tool":"remember","args":{"text":"User's birthday is Jan 5"}}
{"tool":"remind","args":{"text":"Stand up","atEpochMs":1750000000000}}
{"tool":"search_web","args":{"query":"latest Windows 11 update news"}}
{"tool":"run_code","args":{"code":"...","language":"powershell"}}
{"tool":"self_improve","args":{"text":"Remember to ask before deleting folders"}}
{"tool":"send_email","args":{"to":"a@b.com","subject":"Hi","body":"..."}}
{"tool":"read_emails","args":{"max":10}}
{"tool":"add_calendar_event","args":{"summary":"Standup","start":"2026-09-12T15:00:00Z"}}
{"tool":"list_calendar_events","args":{"max":10}}
```

---

## Security & privacy model

- **Local storage only** — memory lives in your OS app-data as a JSON file; it never leaves the machine except as prompt context sent to OpenRouter.
- **Memory-safe bridge** — Rust performs all file/system operations; no native code path runs unsafely.
- **Lock-aware IO** — Windows `ERROR_SHARING_VIOLATION` / `ERROR_LOCK_VIOLATION` are caught and reported, never crashing the app.
- **Human-in-the-loop Command Gate** — deletes, moves, process kills, arbitrary command execution, and email/calendar actions pause for **spoken + tap confirmation** before running. The Rust gate returns a `RULE_GATE:` marker and the operation only proceeds after you approve. Code-fix scripts generated by Big G live in a dedicated app-data folder that the gate auto-allows — Big G can fix your scripts without prompting, but you approve anything out of that sandbox.
- **Configurable allowlist** — remember `security_allowlist = ["C:\\My Safe Folder"]` to skip prompts inside trusted paths.
- **No secrets in the repo** — `.env` and build artifacts are gitignored.
- **Your machine, your rules** — Big G only acts on what its system prompt and your instructions authorize.

### Email & calendar

Configured through memory preferences (just tell Big G, e.g. *"my SMTP host is smtp.gmail.com, port 587, user me@gmail.com, app password abcd"*):

| Preference | Purpose |
|---|---|
| `smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`, `smtp_from`, `smtp_tls` | SMTP mail settings (app-password + STARTTLS recommended) |
| `gmail_token`, `calendar_token`, `calendar_id` | Google REST tokens for inbox + Calendar (default `primary`) |
| `security_allowlist` | Path prefixes allowed to skip the confirmation gate |
| `morning_briefing` | Enables the proactive morning rundown |

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Type-check + production frontend bundle |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run tauri:dev` | Run the desktop app in dev mode |
| `npm run tauri:build` | Compile Rust + bundle local Windows installer |
| `npm run tauri:icon` | Regenerate app icons from a source PNG |
| CI workflow | `.github/workflows/ci.yml` checks `tsc + cargo check` on PRs |
| Release workflow | `.github/workflows/release.yml` builds Windows / Linux / macOS bundles on a `v*` tag push and attaches them to a draft release |

---

## Roadmap

- [x] Code-execution self-fix loop (run → read errors → fix → re-run)
- [x] Self-improvement notes persisted into memory
- [x] Richer proactive triggers (time-of-day, agenda, learned patterns)
- [x] Security: human-in-the-loop confirmation gate + allowlist
- [x] Email / calendar integration (SMTP + Google REST)
- [x] Cross-platform packaging via CI (Windows / Linux / macOS)