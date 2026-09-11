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

    return null;
  }

  private rollWindow(): void {
    if (Date.now() - this.windowOpenedAt >= 3_600_000) {
      this.windowOpenedAt = Date.now();
      this.suggestionsThisWindow = 0;
    }
  }
}