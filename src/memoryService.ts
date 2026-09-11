import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";

export interface BigGReminder {
  id: string;
  text: string;
  at: number;
  notified: boolean;
  createdAt: number;
}

export interface BigGMemoryEvent {
  t: number;
  kind: string;
  note: string;
}

export interface BigGMemoryStore {
  version: number;
  profile: Record<string, string>;
  preferences: Record<string, unknown>;
  facts: string[];
  events: BigGMemoryEvent[];
  conversationLog: Array<{ t: number; text: string }>;
  reminders: BigGReminder[];
}

const DEFAULTS: BigGMemoryStore = {
  version: 1,
  profile: {},
  preferences: {},
  facts: [],
  events: [],
  conversationLog: [],
  reminders: [],
};

/**
 * MemoryService — persistent long-term memory.
 *
 * Big G stores facts, events, preferences, conversation summaries, and
 * reminders in a JSON store inside the OS app-data directory via the Rust
 * read/write bridge, so it learns and personalizes across sessions.
 */
export class MemoryService {
  private filePath: string | null = null;
  private fallbackKey = "big-g-memory";
  private store: BigGMemoryStore = structuredClone(DEFAULTS);

  async load(): Promise<void> {
    try {
      const dir = await appDataDir();
      const sep = dir.endsWith("\\") || dir.endsWith("/") ? "" : "\\";
      this.filePath = `${dir}${sep}big-g-memory.json`;

      const raw = await invoke<string>("read_local_file", { path: this.filePath });
      const parsed = JSON.parse(raw) as BigGMemoryStore;
      this.store = { ...structuredClone(DEFAULTS), ...parsed };
      return;
    } catch {
      this.filePath = null;
    }

    // Fallback: localStorage when the bridge is unavailable.
    const cached = localStorage.getItem(this.fallbackKey);
    if (cached) {
      try {
        this.store = { ...structuredClone(DEFAULTS), ...JSON.parse(cached) };
      } catch {
        this.store = structuredClone(DEFAULTS);
      }
    }
  }

  async save(): Promise<void> {
    if (this.filePath) {
      try {
        await invoke<void>("write_local_file", {
          path: this.filePath,
          content: JSON.stringify(this.store, null, 2),
        });
        return;
      } catch {
        // fall through to localStorage
      }
    }
    localStorage.setItem(this.fallbackKey, JSON.stringify(this.store));
  }

  /* ------------------------------------------------------------------ */
  /* Mutations                                                           */
  /* ------------------------------------------------------------------ */

  addFact(fact: string): void {
    const trimmed = fact.trim();
    if (!trimmed) return;
    if (this.store.facts.includes(trimmed)) return;
    this.store.facts.push(trimmed);
    if (this.store.facts.length > 240) this.store.facts.shift();
    void this.save();
  }

  addEvent(kind: string, note: string): void {
    this.store.events.push({ t: Date.now(), kind, note });
    if (this.store.events.length > 800) this.store.events = this.store.events.slice(-800);
    void this.save();
  }

  logConversation(text: string): void {
    this.store.conversationLog.push({ t: Date.now(), text });
    if (this.store.conversationLog.length > 400) {
      this.store.conversationLog = this.store.conversationLog.slice(-400);
    }
    void this.save();
  }

  setPreference(key: string, value: unknown): void {
    this.store.preferences[key] = value;
    void this.save();
  }

  setProfileField(key: string, value: string): void {
    this.store.profile[key] = value;
    void this.save();
  }

  /* ------------------------------------------------------------------ */
  /* Reminders                                                           */
  /* ------------------------------------------------------------------ */

  allReminders(): BigGReminder[] {
    return [...this.store.reminders];
  }

  allFacts(): string[] {
    return [...this.store.facts];
  }

  allPreferences(): Record<string, unknown> {
    return { ...this.store.preferences };
  }

  findUpcomingReminders(windowMs: number): BigGReminder[] {
    const now = Date.now();
    return this.store.reminders.filter(
      (r) => !r.notified && r.at >= now && r.at <= now + windowMs,
    );
  }

  addReminder(text: string, at: number): string {
    const id = `rm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.store.reminders.push({
      id,
      text,
      at,
      notified: false,
      createdAt: Date.now(),
    });
    void this.save();
    return id;
  }

  markReminderNotified(id: string): void {
    const hit = this.store.reminders.find((r) => r.id === id);
    if (hit) {
      hit.notified = true;
      void this.save();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Context generation                                                  */
  /* ------------------------------------------------------------------ */

  /** Renders a concise memory context block for injection into the prompt. */
  buildContextBlock(): string {
    const parts: string[] = [];

    const profile = Object.entries(this.store.profile);
    if (profile.length > 0) {
      parts.push(
        `Known profile:\n${profile.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`,
      );
    }

    const recentFacts = this.store.facts.slice(-40);
    if (recentFacts.length > 0) {
      parts.push(`Persistent facts (most recent first):\n${recentFacts
        .slice(-40).reverse()
        .map((f) => `- ${f}`)
        .join("\n")}`);
    }

    const recentEvents = this.store.events.slice(-12);
    if (recentEvents.length > 0) {
      parts.push(
        `Recent activity:\n${recentEvents
          .map((e) => `- [${new Date(e.t).toLocaleString()}] ${e.note}`)
          .join("\n")}`,
      );
    }

    const upcoming = this.store.reminders.filter((r) => !r.notified);
    if (upcoming.length > 0) {
      parts.push(
        `Pending reminders:\n${upcoming
          .map((r) => `- ${new Date(r.at).toLocaleString()} — ${r.text}`)
          .join("\n")}`,
      );
    }

    if (parts.length === 0) return "(no notable memory yet)";
    return parts.join("\n\n");
  }
}