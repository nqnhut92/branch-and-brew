import { PendingRequests } from '../../shared/pendingRequests';
import type { RpcRequest, RpcResponse } from '../../shared/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

/** The webview guide allows one acquireVsCodeApi call per page, so it lives here. */
export const vscodeApi = acquireVsCodeApi();

const pending = new PendingRequests();
const listeners = new Set<(event: { kind: 'event'; event: string }) => void>();
let nextId = 1;

window.addEventListener('message', (e: MessageEvent<RpcResponse | { kind: 'event'; event: string }>) => {
  const msg = e.data;
  if (msg.kind === 'event') return listeners.forEach((listener) => listener(msg));
  pending.settle(msg.id, msg.error, msg.result);
});

// The host can close the panel while a request is still running (Save does): reject what is left,
// so no caller waits forever for an answer nobody can send.
window.addEventListener('pagehide', () => pending.cancelAll('The panel was closed.'));

/** A typed client for one panel's method table (see shared/protocol.ts). */
export function createClient<Methods extends { [M in keyof Methods]: { params: unknown; result: unknown } }>() {
  return function request<M extends keyof Methods & string>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      // Registered before posting: a host that answers at once still finds the waiter.
      pending.add(id, { resolve: resolve as (v: unknown) => void, reject });
      vscodeApi.postMessage({ kind: 'request', id, method, params } satisfies RpcRequest);
    });
  };
}

/** Listens for events the host sends without being asked. Returns the function that stops it. */
export function onHostEvent(listener: (event: { kind: 'event'; event: string }) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Script errors and CSP violations, reported to the host so tests can assert there are none. */
export const pageErrors: string[] = [];
window.addEventListener('error', (e) => pageErrors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => pageErrors.push(String((e.reason as Error)?.message ?? e.reason)));
window.addEventListener('securitypolicyviolation', (e) => pageErrors.push(`CSP blocked ${e.violatedDirective}: ${e.blockedURI}`));
