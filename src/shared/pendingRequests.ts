/** One request the webview is waiting for an answer to. */
export interface Waiting {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * Requests posted to the host and not answered yet, by id. The page that owns them can go away
 * (the panel was closed) while the host is still working: cancelling rejects every promise, so
 * nothing is left waiting for a message that will never come.
 */
export class PendingRequests {
  private readonly waiting = new Map<number, Waiting>();

  /** Number of requests without an answer. */
  get size(): number {
    return this.waiting.size;
  }

  add(id: number, waiter: Waiting): void {
    this.waiting.set(id, waiter);
  }

  /** Answers a request. False when nothing waits for that id: already answered or cancelled. */
  settle(id: number, error: string | undefined, value: unknown): boolean {
    const waiter = this.waiting.get(id);
    if (!waiter) return false;
    this.waiting.delete(id);
    if (error !== undefined) waiter.reject(new Error(error));
    else waiter.resolve(value);
    return true;
  }

  /** Rejects everything still waiting; returns how many requests that was. */
  cancelAll(reason: string): number {
    const count = this.waiting.size;
    for (const waiter of this.waiting.values()) waiter.reject(new Error(reason));
    this.waiting.clear();
    return count;
  }
}
