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
| `VITE_OPENROUTER_MODEL` | `openchat/openchat-7b` | Core thinking model |
| `VITE_OPENROUTER_STT_MODEL` | `openai/whisper-large-v3-turbo` | Speech-to-text |
| `VITE_OPENROUTER_TTS_MODEL` | `openai/tts-1` | Text-to-speech |
| `VITE_OPENROUTER_VOICE` | `alloy` | TTS voice |
| `VITE_OPENROUTER_RESEARCH_MODEL` | `openrouter/auto:online` | Web-search agent |

---

## How to use

1. **Wake the orb** — tap it (a click without dragging). Big G requests mic+camera.
2. **Talk** — speak; the emerald shockwave shows capture. On a pause, Big G transcribes, thinks (cosmic swirl), executes any tool intents, then speaks back (warm pulse).
3. **Move it** — drag anywhere; the overlay follows you to any screen corner.
4. **Sleep** — tap again, or press `Esc`.
5. **Reminders** — say something like *"remind me to call Sarah at 5pm"*.

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
```

---

## Security & privacy model

- **Local storage only** — memory lives in your OS app-data as a JSON file; it never leaves the machine except as prompt context sent to OpenRouter.
- **Memory-safe bridge** — Rust performs all file/system operations; no native code path runs unsafely.
- **Lock-aware IO** — Windows `ERROR_SHARING_VIOLATION` / `ERROR_LOCK_VIOLATION` are caught and reported, never crashing the app.
- **No secrets in the repo** — `.env` and build artifacts are gitignored.
- **Your machine, your rules** — Big G only acts on what its system prompt and your instructions authorize.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Type-check + production frontend bundle |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run tauri:dev` | Run the desktop app in dev mode |
| `npm run tauri:build` | Compile Rust + bundle Windows installer |
| `npm run tauri:icon` | Regenerate app icons from a source PNG |

---

## Roadmap

- [ ] Code-execution self-fix loop (run → read errors → fix → re-run)
- [ ] Self-improvement notes persisted into memory
- [ ] Richer proactive triggers (time-of-day, agenda, learned patterns)
- [ ] Email / calendar integration
- [ ] Packaging for Linux / macOS