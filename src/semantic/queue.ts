import { logger } from '../logger.ts';

/**
 * A FIFO worked through one job at a time. When more than `maxBacklog` jobs wait, new jobs are
 * dropped instead of piling up (semantic matching is best-effort; a burst must not delay it for hours).
 */
export class BoundedQueue<T> {
  handler: (job: T) => Promise<void>;
  maxBacklog: number;
  jobs: T[] = [];
  running = false;
  dropped = 0;

  constructor(handler: (job: T) => Promise<void>, maxBacklog: number) {
    this.handler = handler;
    this.maxBacklog = maxBacklog;
  }

  get size(): number {
    return this.jobs.length;
  }

  /** Returns false when the job was dropped because the backlog is full. */
  push(job: T): boolean {
    if (this.jobs.length >= this.maxBacklog) {
      this.dropped++;
      return false;
    }
    this.jobs.push(job);
    void this.drain();
    return true;
  }

  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs.shift() as T;
        try {
          await this.handler(job);
        } catch (err) {
          logger.warn(`[queue] job failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Resolves once the queue is empty (for tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running || this.jobs.length) await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
