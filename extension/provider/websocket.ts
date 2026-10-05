import type { ResponseInput } from 'openai/resources/responses/responses.js';
import { continuationBody, releaseConnection, storeConnection, takeConnection, type Connection, type SocketLike } from './continuation';
import { websocketHeaders } from './routing';
import type { CodexOptions, PreparedRequest } from './types';

type SocketConstructor = new (url: string, options?: { headers?: Record<string, string> }) => SocketLike;
export const MAX_WEBSOCKET_MESSAGE_BYTES = 8 * 1024 * 1024;
function usesContinuation(options?: CodexOptions): boolean { return options?.transport === 'auto' || options?.transport === 'websocket-cached'; }

function normalizedTimeout(value: number | undefined, fallback?: number): number | undefined {
  const timeout = value ?? fallback; if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error(`Invalid timeoutMs: ${String(timeout)}`);
  return Math.floor(timeout);
}
async function connect(url: string, headers: Headers, options?: CodexOptions): Promise<SocketLike> {
  const constructor = globalThis.WebSocket as unknown as SocketConstructor | undefined; if (!constructor) throw new Error('WebSocket transport is unavailable.');
  const headerRecord: Record<string, string> = {}; headers.forEach((value, name) => { headerRecord[name] = value; });
  const socket = new constructor(url, { headers: headerRecord }); const connectTimeout = normalizedTimeout(options?.websocketConnectTimeoutMs, 15_000);
  return new Promise((resolve, reject) => {
    let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer) clearTimeout(timer); socket.removeEventListener('open', open); socket.removeEventListener('error', error); socket.removeEventListener('close', close); options?.signal?.removeEventListener('abort', abort); };
    const fail = (cause: Error) => { if (settled) return; settled = true; cleanup(); socket.close(1000, 'connect_failed'); reject(cause); };
    const open = () => { if (settled) return; settled = true; cleanup(); resolve(socket); };
    const error = () => fail(new Error('WebSocket connection failed.'));
    const close = (event: unknown) => fail(closeError(event));
    const abort = () => fail(new Error('Request was aborted'));
    socket.addEventListener('open', open); socket.addEventListener('error', error); socket.addEventListener('close', close); options?.signal?.addEventListener('abort', abort, { once: true });
    if (connectTimeout && connectTimeout > 0) timer = setTimeout(() => fail(new Error(`WebSocket connect timeout after ${connectTimeout}ms`)), connectTimeout);
    if (options?.signal?.aborted) abort();
  });
}
function closeError(event: unknown): Error {
  if (typeof event !== 'object' || event === null) return new Error('WebSocket closed.');
  const code = 'code' in event && typeof event.code === 'number' ? event.code : undefined;
  return new Error(code === 1009 ? 'WebSocket closed (1009 message too big).' : `WebSocket closed${code ? ` (${code})` : '.'}`);
}
async function decodeData(data: unknown): Promise<string | undefined> {
  let bytes: Uint8Array | undefined;
  if (typeof data === 'string') {
    if (new TextEncoder().encode(data).byteLength > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error('WebSocket message exceeded the size limit.');
    return data;
  }
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else if (typeof data === 'object' && data !== null && 'arrayBuffer' in data && typeof data.arrayBuffer === 'function') {
    if ('size' in data && typeof data.size === 'number' && data.size > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error('WebSocket message exceeded the size limit.');
    bytes = new Uint8Array(await data.arrayBuffer());
  }
  if (!bytes) return undefined;
  if (bytes.byteLength > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error('WebSocket message exceeded the size limit.');
  return new TextDecoder().decode(bytes);
}

export async function* openWebSocket(prepared: PreparedRequest, options?: CodexOptions, onConnection?: (connection: Connection) => void): AsyncGenerator<Record<string, unknown>, void> {
  const cached = usesContinuation(options);
  let connection = cached ? takeConnection(prepared.routeKey, prepared.sessionId) : undefined;
  if (!connection) {
    const url = new URL(prepared.endpoint); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    connection = { socket: await connect(url.toString(), websocketHeaders(prepared), options), routeKey: prepared.routeKey, busy: true, createdAt: Date.now() };
    if (cached) storeConnection(prepared.sessionId, connection);
  }
  onConnection?.(connection); const socket = connection.socket;
  const request = cached ? continuationBody(connection, prepared.body) : prepared.body; socket.send(JSON.stringify({ type: 'response.create', ...request }));
  const queue: Record<string, unknown>[] = []; let wake: (() => void) | undefined; let failure: Error | undefined; let complete = false; let decoding = Promise.resolve();
  const notify = () => { wake?.(); wake = undefined; };
  const message = (event: unknown) => {
    decoding = decoding.then(async () => {
      if (typeof event !== 'object' || event === null || !('data' in event)) return;
      const text = await decodeData(event.data); if (text === undefined) return;
      const parsed: unknown = JSON.parse(text); if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('malformed event');
      const record = parsed as Record<string, unknown>; queue.push(record);
      if (record.type === 'response.completed' || record.type === 'response.done' || record.type === 'response.incomplete') complete = true;
    }).catch((cause: unknown) => {
      failure = cause instanceof Error && /size limit/.test(cause.message) ? cause : new Error('OpenAI Codex returned malformed WebSocket data.');
      if (/size limit/.test(failure.message)) socket.close(1009, 'message_too_big');
    }).finally(notify);
  };
  const failAfterDecode = (cause: Error) => { void decoding.finally(() => { if (!complete && !failure) failure = cause; notify(); }); };
  const error = () => failAfterDecode(new Error('WebSocket stream failed.'));
  const close = (event: unknown) => failAfterDecode(closeError(event));
  const abort = () => { queue.length = 0; failure = new Error('Request was aborted'); notify(); };
  socket.addEventListener('message', message); socket.addEventListener('error', error); socket.addEventListener('close', close); options?.signal?.addEventListener('abort', abort, { once: true });
  const idleTimeout = normalizedTimeout(options?.timeoutMs);
  try {
    while (!complete || queue.length) {
      // Events that arrived before a close or an error are delivered first, so output the socket already sent is not lost.
      if (queue.length) { yield queue.shift()!; continue; }
      if (failure) throw failure;
      await new Promise<void>((resolve, reject) => {
        wake = resolve;
        if (idleTimeout && idleTimeout > 0) {
          const timer = setTimeout(() => { const timeoutError = new Error(`WebSocket idle timeout after ${idleTimeout}ms`); failure = timeoutError; wake = undefined; socket.close(1000, 'idle_timeout'); reject(timeoutError); }, idleTimeout);
          const original = wake; wake = () => { clearTimeout(timer); original(); };
        }
      });
    }
  } finally {
    socket.removeEventListener('message', message); socket.removeEventListener('error', error); socket.removeEventListener('close', close); options?.signal?.removeEventListener('abort', abort);
  }
}
export function finishWebSocket(prepared: PreparedRequest, connection: Connection, responseId: string | undefined, responseItems: ResponseInput, options?: CodexOptions): void {
  const cached = usesContinuation(options); if (cached && responseId) connection.continuation = { body: prepared.body, responseId, responseItems };
  releaseConnection(cached ? prepared.sessionId : undefined, connection, cached && Boolean(responseId));
}
export function discardWebSocket(prepared: PreparedRequest, connection: Connection): void { releaseConnection(prepared.sessionId, connection, false); }
