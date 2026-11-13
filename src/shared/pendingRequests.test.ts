import { describe, expect, it, vi } from 'vitest';
import { PendingRequests } from './pendingRequests';

describe('pending requests', () => {
  it('resolves the request with the answer of its id', () => {
    const pending = new PendingRequests();
    const resolve = vi.fn();
    const reject = vi.fn();
    pending.add(7, { resolve, reject });
    expect(pending.size).toBe(1);
    expect(pending.settle(7, undefined, 'ok')).toBe(true);
    expect(resolve).toHaveBeenCalledWith('ok');
    expect(reject).not.toHaveBeenCalled();
    expect(pending.size).toBe(0);
  });

  it('rejects the request with the host error message', () => {
    const pending = new PendingRequests();
    const reject = vi.fn();
    pending.add(1, { resolve: vi.fn(), reject });
    pending.settle(1, 'no such method', undefined);
    expect(reject).toHaveBeenCalledWith(new Error('no such method'));
  });

  it('ignores answers nobody waits for', () => {
    const pending = new PendingRequests();
    expect(pending.settle(3, undefined, 'late')).toBe(false);
    const resolve = vi.fn();
    pending.add(4, { resolve, reject: vi.fn() });
    pending.settle(4, undefined, 'first');
    expect(pending.settle(4, undefined, 'second')).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('cancels everything still waiting, once', () => {
    const pending = new PendingRequests();
    const reject = vi.fn();
    pending.add(1, { resolve: vi.fn(), reject });
    pending.add(2, { resolve: vi.fn(), reject });
    expect(pending.cancelAll('The panel was closed.')).toBe(2);
    expect(reject).toHaveBeenCalledTimes(2);
    expect(reject).toHaveBeenCalledWith(new Error('The panel was closed.'));
    expect(pending.size).toBe(0);
    expect(pending.cancelAll('again')).toBe(0);
    expect(reject).toHaveBeenCalledTimes(2);
  });
});
