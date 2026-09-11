import type { MemoryService } from "./memoryService";

export interface BigGDueReminder {
  id: string;
  text: string;
  at: number;
}

/**
 * SchedulerService — reminders & time-driven tasks.
 *
 * Polls the memory store for due reminders, fires `onDue` for each one
 * exactly once, then marks them notified so Big G can speak them and raise
 * a native Windows notification.
 */
export class SchedulerService {
  private memory: MemoryService;
  private timer: number | null = null;
  private readonly pollMs: number;

  onDue?: (reminder: BigGDueReminder) => void;

  constructor(memory: MemoryService, pollMs = 10_000) {
    this.memory = memory;
    this.pollMs = pollMs;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.tick(), this.pollMs);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Schedule a reminder. Returns its id. */
  addReminder(text: string, at: number): string {
    return this.memory.addReminder(text, at);
  }

  listReminders() {
    return this.memory.allReminders();
  }

  private tick(): void {
    const now = Date.now();
    for (const reminder of this.memory.allReminders()) {
      if (reminder.notified || reminder.at > now) continue;
      this.memory.markReminderNotified(reminder.id);
      this.onDue?.({
        id: reminder.id,
        text: reminder.text,
        at: reminder.at,
      });
    }
  }
}