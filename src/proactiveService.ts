import type { SchedulerService } from "./schedulerService";
import type { MemoryService } from "./memoryService";

export interface BigGProactiveCallbacks {
  onSuggestion?: (suggestion: string) => void;
}

export interface BigGProactiveOptions {
  intervalMs: number;
  reminderLeadMs: number;
  quietLeadMs: number;
  maxSuggestionsPerHour: number;
}

const DEFAULT_OPTIONS: BigGProactiveOptions = {
  intervalMs: 45_000,
  reminderLeadMs: 5 * 60_000,
  quietLeadMs: 3 * 60_000,
  maxSuggestionsPerHour: 4,
};

/**
 * ProactiveService — anticipation layer.
 *
 * Periodically scans memory and the scheduler for signals worth surfacing:
 * upcoming reminders, stale unanswered suggestions, or learned facts that
 * justify a proactive nudge. Big G uses this to anticipate the user's needs
 * without being noisy.
 */
export class ProactiveService {
  private memory: MemoryService;
  private scheduler: SchedulerService;
  private callbacks: BigGProactiveCallbacks;
  private options: BigGProactiveOptions;

  private timer: number | null = null;
  private suggestionsThisWindow = 0;
  private windowOpenedAt = Date.now();
  private lastPromptedFactCount = -1;
  private promptedImprovementIds = new Set<string>();
  private morningPromptDate = "";
  private lastErrorPromptAt = 0;

  constructor(
    memory: MemoryService,
    scheduler: SchedulerService,
    callbacks: BigGProactiveCallbacks = {},
    options: Partial<BigGProactiveOptions> = {},
  ) {
    this.memory = memory;
    this.scheduler = scheduler;
    this.callbacks = callbacks;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.scan(), this.options.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private scan(): void {
    this.rollWindow();
    if (this.suggestionsThisWindow >= this.options.maxSuggestionsPerHour) return;

    const suggestion = this.buildSuggestion();
    if (suggestion) {
      this.suggestionsThisWindow += 1;
      this.callbacks.onSuggestion?.(suggestion);
    }
  }

  private buildSuggestion(): string | null {
    const now = Date.now();

    // 1) Reminder about to come due.
    const upcoming = this.memory.findUpcomingReminders(this.options.reminderLeadMs);
    if (upcoming.length > 0) {
      const first = upcoming[0]!;
      const mins = Math.max(1, Math.round((first.at - now) / 60_000));
      return `Heads up — "${first.text}" is coming up in about ${mins} minute${mins === 1 ? "" : "s"}. Want me to get you ready?`;
    }

    // 2) Learned facts worth acting on (new since the last prompt).
    const facts = this.memory.allFacts();
    if (facts.length > this.lastPromptedFactCount && this.lastPromptedFactCount >= 0) {
      const newest = facts.slice(-1)[0]!;
      this.lastPromptedFactCount = facts.length;
      return `I just saved something new: "${newest}". Anything you'd like me to do with it?`;
    }
    this.lastPromptedFactCount = facts.length;

    // 3) Quiet period baseline: check whether any task prefs suggest action.
    const prefs = this.memory.allPreferences();
    const scheduledTask = prefs["default_task"];
    if (typeof scheduledTask === "string" && this.scheduler.listReminders().filter((r) => !r.notified).length === 0) {
      return `It's been quiet. Shall I set up a repeating reminder for "${scheduledTask}" or is everything handled?`;
    }

    // 4) Time-of-day briefing: respect an explicit morning_briefing preference.
    if (prefs["morning_briefing"] === true) {
      const today = new Date().toDateString();
      if (today === this.morningPromptDate) return null;
      const hour = new Date().getHours();
      if (hour >= 7 && hour <= 10) {
        this.morningPromptDate = today;
        const todays = this.memory
          .allReminders()
          .filter((r) => new Date(r.at).toDateString() === today && r.at > now);
        const count = todays.length;
        return count > 0
          ? `Morning! You have ${count} reminder${count === 1 ? "" : "s"} on the books today. Want a rundown now?`
          : "Morning! Nothing scheduled reminder-wise today. Anything you want covered?";
      }
    }

    // 5) Surfaced self-improvement notes — big G acts on its own growth once.
    for (const improvement of this.memory.allImprovements()) {
      const key = `${improvement.t}:${improvement.text}`;
      if (this.promptedImprovementIds.has(key)) continue;
      this.promptedImprovementIds.add(key);
      return `Self-improvement note on file: "${improvement.text}". Want me to work on that now?`;
    }

    // 6) A local tool operation failed recently — offer the code-fix engine.
    const recentFailure = this.memory
      .allEvents()
      .filter((e) => e.kind === "toolerror" && now - e.t < this.options.quietLeadMs)
      .sort((a, b) => b.t - a.t)[0];
    if (recentFailure && now - this.lastErrorPromptAt > this.options.quietLeadMs) {
      this.lastErrorPromptAt = now;
      return `One of my local operations just hit an error ("${recentFailure.note}"). Want me to examine it and try to fix it automatically?`;
    }

    return null;
  }

  private rollWindow(): void {
    if (Date.now() - this.windowOpenedAt >= 3_600_000) {
      this.windowOpenedAt = Date.now();
      this.suggestionsThisWindow = 0;
    }
  }
}