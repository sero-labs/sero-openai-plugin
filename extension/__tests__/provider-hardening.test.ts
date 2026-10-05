import { afterEach, describe, expect, it, vi } from 'vitest';
import { zstdDecompressSync } from 'node:zlib';
import { normalizeContext, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { isContextOverflow } from '../../node_modules/@earendil-works/pi-ai/dist/utils/overflow.js';
import { DEFAULT_SETTINGS } from '../../shared/config';
import { normalizeEvents } from '../provider/events';
import { closeOwnedSockets, storeConnection, takeConnection, type SocketLike } from '../provider/continuation';
import { buildFinalBody } from '../provider/request';
import { prepareRouting } from '../provider/routing';
import { MAX_SSE_FRAME_BYTES, openSse, parseSse } from '../provider/sse';
import { createCodexStream } from '../provider/stream';
import type { PreparedRequest } from '../provider/types';
import { applyTierCost } from '../provider/usage';
import { MAX_WEBSOCKET_MESSAGE_BYTES, discardWebSocket, openWebSocket } from '../provider/websocket';

const model: Model<'openai-codex-responses'> = {
  id: 'gpt-5.5', name: 'GPT-5.5', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', reasoning: true,
  input: ['text'], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, contextWindow: 100_000, maxTokens: 10_000,
  compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: true },
};
const token = (account = 'account') => `a.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.b`;
const plainContext: Context = { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] };
const context = normalizeContext(plainContext);
const settings = { ...DEFAULT_SETTINGS, fastMode: false, verbosity: 'off' as const };
const completed = { type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
const sse = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
const prepared = (overrides: Partial<PreparedRequest> = {}): PreparedRequest => ({
  body: { model: 'gpt-5.5', store: false, stream: true, instructions: 'x', input: [], include: [], tool_choice: 'auto', parallel_tool_calls: true },
  accountId: 'account', requestId: 'request', routeKey: 'route', headers: new Headers(), endpoint: 'https://example.test/codex/responses', routedModelId: 'gpt-5.5',
  ...overrides,
});
afterEach(() => { closeOwnedSockets(); FakeSocket.payload = undefined; FakeSocket.delay = 0; FakeSocket.peerCloseCode = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('request parity and isolation', () => {
  it('serializes grammar tools and maps reasoning off without a reasoning object', async () => {
    const grammarContext: Context = { ...plainContext, tools: [{
      name: 'query', description: 'query', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      constrainedSampling: { type: 'grammar', variants: { openai_lark: 'start: /.+/' } },
    }] };
    const body = await buildFinalBody({ ...model, reasoning: false }, normalizeContext(grammarContext), { reasoning: 'high' }, settings);
    expect(body.reasoning).toBeUndefined();
    expect(body.tools).toEqual([expect.objectContaining({ type: 'custom', name: 'query', format: expect.objectContaining({ type: 'grammar', syntax: 'lark' }) })]);
  });

  it('derives model hints, cache routes, and pricing identity from final body.model', async () => {
    const body = await buildFinalBody(model, context, { onPayload: (value) => ({ ...(value as Record<string, unknown>), model: 'gpt-5.4', service_tier: 'priority' }) }, settings, 'session');
    const route = prepareRouting(model, body, { apiKey: token('profile-a'), sessionId: 'session' });
    const otherModel = prepareRouting(model, { ...body, model: 'gpt-5.5' }, { apiKey: token('profile-a'), sessionId: 'session' });
    const otherProfile = prepareRouting(model, body, { apiKey: token('profile-b'), sessionId: 'session' });
    expect(route.headers.get('x-codex-routing-hint')).toBe('model=gpt-5.4;tier=priority');
    expect(new Set([route.routeKey, otherModel.routeKey, otherProfile.routeKey])).toHaveLength(3);
    expect(route.routedModelId).toBe('gpt-5.4');
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 } };
    applyTierCost(usage, 'priority', model, route.routedModelId); expect(usage.cost.total).toBe(8);
  });

  it('normalizes terminal status and records end_turn', async () => {
    const output: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: 'pending', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    async function* source() { yield { type: 'response.done', response: { status: 'unexpected', end_turn: true } }; }
    const events = []; for await (const event of normalizeEvents(source(), output)) events.push(event);
    expect(events).toEqual([expect.objectContaining({ type: 'response.completed', response: expect.objectContaining({ status: undefined }) })]);
    expect(output.endTurn).toBe(true);
  });
});

describe('SSE safety and retries', () => {
  it('compresses SSE requests without changing the final body', async () => {
    let captured: RequestInit | undefined;
    const response = await openSse(prepared(), model, { apiKey: token(), fetch: async (_input, init) => { captured = init; return new Response(sse(completed), { status: 200 }); } });
    expect(response.ok).toBe(true);
    const headers = new Headers(captured?.headers);
    expect(headers.get('content-encoding')).toBe('zstd');
    const bytes = captured?.body instanceof Uint8Array ? captured.body : new Uint8Array();
    expect(JSON.parse(zstdDecompressSync(bytes).toString('utf8'))).toEqual(prepared().body);
  });
  it('cancels and releases a reader on success and parser failure', async () => {
    for (const text of [sse(completed), 'data: {bad}\n\n']) {
      let read = false; const cancel = vi.fn(async () => undefined); const releaseLock = vi.fn();
      const reader = { read: vi.fn(async () => read ? { done: true, value: undefined } : (read = true, { done: false, value: new TextEncoder().encode(text) })), cancel, releaseLock };
      const response = { body: { getReader: () => reader } } as unknown as Response;
      try { for await (const _event of parseSse(response)) { /* consume */ } } catch { /* malformed fixture */ }
      expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
    }
  });

  it('bounds SSE frames', async () => {
    const response = new Response(`data: ${'x'.repeat(MAX_SSE_FRAME_BYTES + 1)}`);
    await expect(async () => { for await (const _event of parseSse(response)) { /* consume */ } }).rejects.toThrow('size limit');
  });

  it('times out SSE headers and body while zero disables the body timeout', async () => {
    const hangingFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    await expect(openSse(prepared(), model, { apiKey: token(), fetch: hangingFetch, timeoutMs: 5 })).rejects.toThrow('headers timed out');
    const body = new ReadableStream<Uint8Array>({ start(controller) { setTimeout(() => { controller.enqueue(new TextEncoder().encode(sse(completed))); controller.close(); }, 10); } });
    const events = []; for await (const event of parseSse(new Response(body), undefined, 0)) events.push(event);
    expect(events).toHaveLength(1);
    const never = new ReadableStream<Uint8Array>();
    await expect(async () => { for await (const _event of parseSse(new Response(never), undefined, 5)) { /* consume */ } }).rejects.toThrow('body timed out');
  });

  it('aborts during header wait and retry sleep, and rejects early EOF without retry', async () => {
    const headersController = new AbortController();
    const hanging = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('provider detail')))));
    const headers = openSse(prepared(), model, { apiKey: token(), fetch: hanging, signal: headersController.signal }); queueMicrotask(() => headersController.abort());
    await expect(headers).rejects.toThrow('Request was aborted'); expect(hanging).toHaveBeenCalledOnce();

    const retryController = new AbortController(); const retrying = vi.fn(async () => new Response('busy', { status: 503, headers: { 'retry-after': '1' } }));
    const retry = openSse(prepared(), model, { apiKey: token(), fetch: retrying, signal: retryController.signal, maxRetries: 1 }); setTimeout(() => retryController.abort(), 0);
    await expect(retry).rejects.toThrow('Request was aborted'); expect(retrying).toHaveBeenCalledOnce();

    const eofFetch = vi.fn(async () => new Response('', { status: 200 }));
    const eof = await createCodexStream(async () => settings)(model, context, { apiKey: token(), transport: 'sse', fetch: eofFetch, maxRetries: 2 }).result();
    expect(eof.stopReason).toBe('error'); expect(eofFetch).toHaveBeenCalledOnce();
  });

  it('suppresses terminal quota retries, parses HTTP-date, and caps exponential waits', async () => {
    const terminal = vi.fn(async () => new Response('insufficient_quota', { status: 429 }));
    await expect(openSse(prepared(), model, { apiKey: token(), fetch: terminal, maxRetries: 2 })).rejects.toThrow('provider returned an error'); expect(terminal).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const dated = vi.fn(async () => new Response('busy', { status: 503, headers: { 'retry-after': 'Thu, 01 Jan 2026 00:02:00 GMT' } }));
    await expect(openSse(prepared(), model, { apiKey: token(), fetch: dated, maxRetries: 1, maxRetryDelayMs: 10 })).rejects.toThrow('retry delay'); expect(dated).toHaveBeenCalledOnce();
    const network = vi.fn(async () => { throw new Error('offline'); });
    await expect(openSse(prepared(), model, { apiKey: token(), fetch: network, maxRetries: 1, maxRetryDelayMs: 10 })).rejects.toThrow('retry delay'); expect(network).toHaveBeenCalledOnce();
  });

  it('retries a transient status before headers and never retries after streamed output', async () => {
    const retrying = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(sse(completed), { status: 200 }));
    const response = await openSse(prepared(), model, { apiKey: token(), fetch: retrying, maxRetries: 1 });
    const events = []; for await (const event of parseSse(response)) events.push(event);
    expect(events).toEqual([completed]); expect(retrying).toHaveBeenCalledTimes(2);

    const partial = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'visible' },
    ].map(sse).join('');
    let sent = false;
    const brokenBody = new ReadableStream<Uint8Array>({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(partial)); } else controller.error(new Error('body failed')); } });
    const bodyFetch = vi.fn(async () => new Response(brokenBody, { status: 200 })); const eventTypes: string[] = []; const deltas: string[] = [];
    for await (const event of createCodexStream(async () => settings)(model, context, { apiKey: token(), transport: 'sse', fetch: bodyFetch, maxRetries: 2 })) {
      eventTypes.push(event.type); if (event.type === 'text_delta') deltas.push(event.delta);
    }
    expect(eventTypes).toContain('error'); expect(deltas).toEqual(['visible']); expect(bodyFetch).toHaveBeenCalledOnce();
  });

  it('preserves sanitized HTTP and streamed context-overflow semantics', async () => {
    const overflow = 'Your input exceeds the context window of this model';
    const http = await createCodexStream(async () => settings)(model, context, {
      apiKey: token(), transport: 'sse', fetch: async () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: `${overflow} Bearer secret-token` } }), { status: 400 }),
    }).result();
    expect(isContextOverflow(http, model.contextWindow)).toBe(true); expect(http.errorMessage).toContain(overflow); expect(http.errorMessage).not.toContain('secret-token');

    const event = await createCodexStream(async () => settings)(model, context, {
      apiKey: token(), transport: 'sse', fetch: async () => new Response(sse({ type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: `${overflow} sk-sensitive` } } }), { status: 200 }),
    }).result();
    expect(isContextOverflow(event, model.contextWindow)).toBe(true); expect(event.errorMessage).toContain(overflow); expect(event.errorMessage).not.toContain('sk-sensitive');

    const sensitive = 'account-123 raw prompt encrypted_content ciphertext';
    const genericHttp = await createCodexStream(async () => settings)(model, context, {
      apiKey: token(), transport: 'sse', fetch: async () => new Response(JSON.stringify({ error: { code: 'bad_request', message: sensitive } }), { status: 400 }),
    }).result();
    const genericEvent = await createCodexStream(async () => settings)(model, context, {
      apiKey: token(), transport: 'sse', fetch: async () => new Response(sse({ type: 'error', code: 'bad_request', message: sensitive }), { status: 200 }),
    }).result();
    expect(genericHttp.errorMessage).toBe('OpenAI Codex provider returned an error.'); expect(genericEvent.errorMessage).toBe(genericHttp.errorMessage);
  });
});

class FakeSocket implements SocketLike {
  static payload: unknown; static delay = 0; static peerCloseCode?: number; readyState = 1; closedWith?: number;
  private listeners = new Map<string, Set<(event: unknown) => void>>();
  constructor(_url: string, _options?: { headers?: Record<string, string> }) { queueMicrotask(() => this.emit('open', {})); }
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void) { this.listeners.get(type)?.delete(listener); }
  send() { if (FakeSocket.peerCloseCode) setTimeout(() => this.emit('close', { code: FakeSocket.peerCloseCode, reason: '' }), FakeSocket.delay); else if (FakeSocket.payload !== undefined) setTimeout(() => this.emit('message', { data: FakeSocket.payload }), FakeSocket.delay); }
  close(code?: number) { this.closedWith = code; this.readyState = 3; this.emit('close', { code, reason: code === 1009 ? 'message_too_big' : '' }); }
  emit(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

describe('WebSocket safety and lifecycle', () => {
  it.each([
    ['string', () => JSON.stringify(completed)],
    ['ArrayBuffer', () => new TextEncoder().encode(JSON.stringify(completed)).buffer],
    ['typed array', () => new TextEncoder().encode(JSON.stringify(completed))],
    ['Blob', () => new Blob([JSON.stringify(completed)])],
  ])('decodes %s messages', async (_name, makePayload) => {
    FakeSocket.payload = makePayload(); vi.stubGlobal('WebSocket', FakeSocket); let connection;
    const events = []; for await (const event of openWebSocket(prepared(), { apiKey: token(), timeoutMs: 50 }, (value) => { connection = value; })) events.push(event);
    expect(events).toEqual([completed]); if (connection) discardWebSocket(prepared(), connection);
  });

  it('bounds messages, closes with 1009, handles peer 1009, and enforces idle timeout', async () => {
    FakeSocket.payload = { size: MAX_WEBSOCKET_MESSAGE_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) }; vi.stubGlobal('WebSocket', FakeSocket);
    await expect(async () => { for await (const _event of openWebSocket(prepared(), { apiKey: token(), timeoutMs: 50 })) { /* consume */ } }).rejects.toThrow(/size limit|1009/);
    FakeSocket.payload = undefined; FakeSocket.peerCloseCode = 1009;
    await expect(async () => { for await (const _event of openWebSocket(prepared(), { apiKey: token(), timeoutMs: 50 })) { /* consume */ } }).rejects.toThrow('1009 message too big');
    FakeSocket.peerCloseCode = undefined;
    await expect(async () => { for await (const _event of openWebSocket(prepared(), { apiKey: token(), timeoutMs: 5 })) { /* consume */ } }).rejects.toThrow('idle timeout');
  });

  it('disables idle timeout at zero and expires cached sockets after 55 minutes', async () => {
    FakeSocket.payload = JSON.stringify(completed); FakeSocket.delay = 10; vi.stubGlobal('WebSocket', FakeSocket);
    const events = []; for await (const event of openWebSocket(prepared(), { apiKey: token(), timeoutMs: 0 })) events.push(event); expect(events).toHaveLength(1);
    const socket = new FakeSocket('wss://example'); const connection = { socket, routeKey: 'aged', busy: false, createdAt: Date.now() - 55 * 60 * 1000 };
    storeConnection('session', connection); expect(takeConnection('aged', 'session')).toBeUndefined(); expect(socket.closedWith).toBe(1000);
  });

  it('falls back before output without emitting duplicate start', async () => {
    FakeSocket.payload = 'not-json'; FakeSocket.delay = 0; vi.stubGlobal('WebSocket', FakeSocket);
    const fetcher = vi.fn(async () => new Response(sse(completed), { status: 200 }));
    const stream = createCodexStream(async () => settings)(model, context, { apiKey: token(), fetch: fetcher });
    const eventTypes = []; for await (const event of stream) eventTypes.push(event.type);
    expect(eventTypes.filter((type) => type === 'start')).toHaveLength(1); expect(eventTypes.at(-1)).toBe('done');
  });

  it.each(['websocket_connection_limit_reached', 'previous_response_not_found'])('recovers once from %s before output', async (code) => {
    let sockets = 0; const handshakes: Array<Record<string, string> | undefined> = [];
    class RecoverableSocket extends FakeSocket {
      private readonly sequence: number;
      constructor(url: string, options?: { headers?: Record<string, string> }) { super(url, options); this.sequence = ++sockets; handshakes.push(options?.headers); }
      send() { queueMicrotask(() => this.emit('message', { data: JSON.stringify(this.sequence === 1 ? { type: 'error', code } : completed) })); }
    }
    vi.stubGlobal('WebSocket', RecoverableSocket); const fetcher = vi.fn();
    const result = await createCodexStream(async () => ({ ...settings, fastMode: true }))(model, context, { apiKey: token(), transport: 'auto', fetch: fetcher }).result();
    expect(result.stopReason).toBe('stop'); expect(sockets).toBe(2); expect(fetcher).not.toHaveBeenCalled();
    for (const headers of handshakes) expect(headers).toMatchObject({ originator: 'codex_cli_rs', 'x-codex-routing-hint': 'model=gpt-5.5;tier=priority' });
  });

  it('falls back to SSE after a WebSocket connect failure', async () => {
    let socketHeaders: Record<string, string> | undefined;
    class ConnectFailureSocket implements SocketLike {
      private listeners = new Map<string, Set<(event: unknown) => void>>();
      constructor(_url: string, options?: { headers?: Record<string, string> }) { socketHeaders = options?.headers; queueMicrotask(() => { for (const listener of this.listeners.get('error') ?? []) listener({}); }); }
      addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
      removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void) { this.listeners.get(type)?.delete(listener); }
      send() { /* connection never opens */ } close() { /* connection is discarded */ }
    }
    vi.stubGlobal('WebSocket', ConnectFailureSocket); let sseHeaders: Headers | undefined;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { sseHeaders = new Headers(init?.headers); return new Response(sse(completed), { status: 200 }); });
    const result = await createCodexStream(async () => ({ ...settings, fastMode: true }))(model, context, { apiKey: token(), transport: 'auto', fetch: fetcher }).result();
    expect(result.stopReason).toBe('stop'); expect(fetcher).toHaveBeenCalledOnce();
    expect(socketHeaders).toMatchObject({ originator: 'codex_cli_rs', 'x-codex-routing-hint': 'model=gpt-5.5;tier=priority' });
    expect(sseHeaders?.get('originator')).toBe('codex_cli_rs'); expect(sseHeaders?.get('x-codex-routing-hint')).toBe('model=gpt-5.5;tier=priority');
  });

  it('returns an error without SSE replay when a socket fails after output', async () => {
    class OutputThenCloseSocket extends FakeSocket {
      send() {
        const events = [
          { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', status: 'in_progress', content: [] } },
          { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'visible' },
        ];
        queueMicrotask(() => { for (const event of events) this.emit('message', { data: JSON.stringify(event) }); this.emit('close', { code: 1011, reason: 'account-123 raw prompt encrypted_content ciphertext' }); });
      }
    }
    vi.stubGlobal('WebSocket', OutputThenCloseSocket); const fetcher = vi.fn(); const eventTypes: string[] = []; const deltas: string[] = []; let errorMessage = '';
    for await (const event of createCodexStream(async () => settings)(model, context, { apiKey: token(), fetch: fetcher })) {
      eventTypes.push(event.type); if (event.type === 'text_delta') deltas.push(event.delta); if (event.type === 'error') errorMessage = event.error.errorMessage ?? '';
    }
    expect(eventTypes).toContain('error'); expect(deltas).toEqual(['visible']); expect(fetcher).not.toHaveBeenCalled(); expect(errorMessage).toBe('WebSocket closed (1011)');
  });

  it('closes cached session sockets for an explicit no-cache request', async () => {
    const cachedSocket = new FakeSocket('wss://cached');
    storeConnection('session', { socket: cachedSocket, routeKey: 'old-route', busy: false });
    const fetcher = vi.fn(async () => new Response(sse(completed), { status: 200 }));
    const result = await createCodexStream(async () => settings)(model, context, { apiKey: token(), transport: 'sse', sessionId: 'session', cacheRetention: 'none', fetch: fetcher }).result();
    expect(result.stopReason).toBe('stop');
    expect(cachedSocket.readyState).toBe(3);
  });
});
