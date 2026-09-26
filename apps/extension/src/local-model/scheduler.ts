import type { PromptPriority } from '@pigeonbox/ai';

/**
 * One local model job at a time, highest priority first. A single GPU or
 * Gemini Nano session gains nothing from parallel prompts, and a reply the
 * user is waiting for must not sit behind background inbox sorting.
 */
const RANK: Record<PromptPriority | 'system', number> = { system: 0, interactive: 1, background: 2 };

type Task = { rank: number; seq: number; run: () => Promise<void> };

export function createScheduler() {
  const tasks: Task[] = [];
  let seq = 0;
  let running = false;

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (let task = tasks.shift(); task; task = tasks.shift()) await task.run();
    } finally {
      running = false;
    }
  }

  return function schedule<T>(priority: PromptPriority | 'system', fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      tasks.push({ rank: RANK[priority], seq: seq++, run: () => fn().then(resolve, reject) });
      tasks.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
      void pump();
    });
  };
}
