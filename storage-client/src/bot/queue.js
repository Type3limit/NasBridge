export class BotJobQueue {
  constructor(options = {}) {
    this.concurrency = Math.max(1, Number(options.concurrency || 2));
    this.running = 0;
    this.pending = [];
  }

  enqueue(task, meta = {}) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, meta, resolve, reject });
      this.drain();
    });
  }

  snapshot() {
    return {
      running: this.running,
      queued: this.pending.length,
      concurrency: this.concurrency
    };
  }

  async drain() {
    if (this.running >= this.concurrency) {
      return;
    }
    const next = this.pending.shift();
    if (!next) {
      return;
    }
    this.running += 1;
    try {
      const result = await next.task(next.meta);
      next.resolve(result);
    } catch (error) {
      next.reject(error);
    } finally {
      this.running -= 1;
      queueMicrotask(() => {
        this.drain().catch(() => {});
      });
    }
  }
}
