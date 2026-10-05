import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeContext, type Context, type Model, type SimpleStreamOptions, type Usage } from '@earendil-works/pi-ai';
import { DEFAULT_SETTINGS } from '../../shared/config';
import { buildFinalBody } from '../provider/request';
import { prepareRouting } from '../provider/routing';
import { applyTierCost, resolveTier } from '../provider/usage';
import { createCodexStream } from '../provider/stream';
import { closeOwnedSockets, continuationBody, storeConnection, takeConnection, type SocketLike } from '../provider/continuation';
import type { CodexRequestBody } from '../provider/types';

const model: Model<'openai-codex-responses'> = {
  id: 'gpt-5.5', name: 'GPT-5.5', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', reasoning: true,
  input: ['text', 'image'], cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }, contextWindow: 100_000, maxTokens: 10_000,
  compat: { supportsStrictMode: true, supportsAdditionalTools: true },
};
const context = normalizeContext({ systemPrompt: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], timestamp: 1 }], tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {}, additionalProperties: false }, constrainedSampling: { type: 'json_schema', strict: 'require' } }] });
const token = (account = 'account-a') => `aaa.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.bbb`;
const settings = (fastMode: boolean, verbosity: 'off' | 'low' | 'medium' | 'high') => ({ ...DEFAULT_SETTINGS, fastMode, verbosity });
afterEach(() => { closeOwnedSockets(); vi.unstubAllGlobals(); });

describe('Codex request and transport', () => {
  it.each([false, true].flatMap((fastMode) => (['off', 'low', 'medium', 'high'] as const).map((verbosity) => [fastMode, verbosity] as const)))('applies Fast %s and verbosity %s independently without replacing body fields', async (fastMode, verbosity) => {
    const body = await buildFinalBody(model, context, { reasoning: 'high' }, settings(fastMode, verbosity), 'session');
    expect(body.instructions).toBe('system'); expect(body.input).toEqual(expect.any(Array)); expect(body.tools).toHaveLength(1); expect(body.reasoning?.effort).toBe('high');
    expect(body.text).toEqual(verbosity === 'off' ? undefined : { verbosity });
    expect(body.service_tier).toBe(fastMode ? 'priority' : undefined);
    const route = prepareRouting(model, body, { apiKey: token() });
    expect(route.headers.get('originator')).toBe(fastMode ? 'codex_cli_rs' : 'pi');
    expect(route.headers.get('x-codex-routing-hint')).toBe(fastMode ? 'model=gpt-5.5;tier=priority' : null);
  });
  it('derives Fast routing only from the final hook body', async () => {
    const onPayload = vi.fn(async (body: unknown) => ({ ...(body as Record<string, unknown>), service_tier: 'default', text: { format: 'kept', verbosity: 'high' } }));
    const body = await buildFinalBody(model, context, { onPayload }, settings(true, 'low'), 'session');
    const route = prepareRouting(model, body, { apiKey: token(), sessionId: 'session' });
    expect(onPayload).toHaveBeenCalledOnce(); expect(route.headers.get('originator')).toBe('pi'); expect(route.headers.has('x-codex-routing-hint')).toBe(false); expect(body.text).toEqual({ format: 'kept', verbosity: 'high' });
    const priority = prepareRouting(model, await buildFinalBody(model, context, undefined, settings(true, 'off')), { apiKey: token() });
    expect(priority.headers.get('originator')).toBe('codex_cli_rs'); expect(priority.headers.get('x-codex-routing-hint')).toBe('model=gpt-5.5;tier=priority');
  });
  it('rejects malformed OAuth claims without exposing credentials', async () => {
    const body = await buildFinalBody(model, context, undefined, settings(false, 'off'));
    for (const apiKey of ['credential-secret', token('')]) {
      let message = ''; try { prepareRouting(model, body, { apiKey }); } catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).toMatch(/^OAuth credential/); expect(message).not.toContain(apiKey);
    }
  });
  it('serializes native images, strict tools, deferred tools, and encrypted reasoning replay', async () => {
    const base = await buildFinalBody(model, context, undefined, settings(false, 'off'));
    expect(base.input).toEqual([expect.objectContaining({ role: 'user', content: expect.arrayContaining([
      { type: 'input_text', text: 'hello' },
      { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,aGVsbG8=' },
    ]) })]);
    expect(base.tools).toEqual([expect.objectContaining({ type: 'function', name: 'lookup', strict: true })]);

    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const history: Context = {
      messages: [
        { role: 'user', content: 'use tools', timestamp: 1 },
        { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'toolCall', id: 'call_1', name: 'base_tool', arguments: {} }], usage, stopReason: 'toolUse', timestamp: 2 },
        { role: 'toolResult', toolCallId: 'call_1', toolName: 'base_tool', content: [{ type: 'text', text: 'done' }], isError: false, timestamp: 3 },
        { role: 'system', content: '', toolsAdded: [{ name: 'late_tool', description: 'Late', parameters: { type: 'object', properties: {} } }], timestamp: 3 },
        { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'thinking', thinking: 'summary', thinkingSignature: JSON.stringify({ type: 'reasoning', id: 'rs_1', encrypted_content: 'ciphertext', summary: [] }) }], usage, stopReason: 'stop', timestamp: 4 },
        { role: 'user', content: 'continue', timestamp: 5 },
      ],
      tools: [
        { name: 'base_tool', description: 'Base', parameters: { type: 'object', properties: {} } },
      ],
    };
    const body = await buildFinalBody({ ...model, compat: { ...model.compat, supportsMidConvoSystemMessages: true } }, normalizeContext(history), undefined, settings(false, 'off'));
    const toolNames = (body.tools ?? []).map((tool) => typeof tool === 'object' && tool !== null && 'name' in tool && typeof tool.name === 'string' ? tool.name : undefined);
    expect(toolNames).toEqual(['base_tool']);
    expect(body.input).toContainEqual(expect.objectContaining({ type: 'additional_tools', tools: [expect.objectContaining({ name: 'late_tool' })] }));
    expect(body.input).toContainEqual(expect.objectContaining({ type: 'reasoning', id: 'rs_1', encrypted_content: 'ciphertext' }));
  });
  it('uses priority fallback and exact cost multipliers', () => {
    const usage: Usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
    expect(resolveTier('default', 'priority')).toBe('priority'); applyTierCost(usage, 'priority', model); expect(usage.cost.total).toBe(25);
    const standard = structuredClone(usage); applyTierCost(standard, 'default', model); expect(standard).toEqual(usage);
  });
  it.each([
    ['gpt-5.3-codex-spark', 2], ['gpt-5.4', 2], ['gpt-5.4-mini', 2], ['gpt-5.5', 2.5],
    ['gpt-5.6-luna', 2], ['gpt-5.6-sol', 2], ['gpt-5.6-terra', 2],
  ])('uses the approved priority multiplier for %s', (id, multiplier) => {
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
    applyTierCost(usage, 'priority', { ...model, id }, id); expect(usage.cost.total).toBe(10 * multiplier);
  });
  it('streams deterministic SSE events and calls response hook before body reads', async () => {
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hello' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] } },
      { type: 'response.completed', response: { id: 'r', status: 'completed', service_tier: 'default', output: [], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } },
    ];
    const sse = `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`; const order: string[] = [];
    const fetcher = vi.fn(async () => { order.push('fetch'); return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }); });
    const options: SimpleStreamOptions = { apiKey: token(), transport: 'sse', fetch: fetcher, onResponse: () => { order.push('response'); } };
    const stream = createCodexStream(async () => settings(false, 'off'))(model, context, options); const types: string[] = []; let finalText = '';
    for await (const event of stream) { types.push(event.type); if (event.type === 'done') finalText = event.message.content[0]?.type === 'text' ? event.message.content[0].text : ''; }
    expect(order).toEqual(['fetch', 'response']); expect(types).toEqual(['start', 'text_start', 'text_delta', 'text_end', 'done']); expect(finalText).toBe('Hello');
  });
  it('bounds retries and aborts retry sleep without leaking credentials', async () => {
    const controller = new AbortController(); const fetcher = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '999' } }));
    const stream = createCodexStream(async () => settings(false, 'off'))(model, context, { apiKey: token('secret-account'), transport: 'sse', fetch: fetcher, maxRetries: 1, maxRetryDelayMs: 10, signal: controller.signal });
    const result = await stream.result(); expect(result.stopReason).toBe('error'); expect(result.errorMessage).not.toContain('secret-account');
  });
  it('aborts while reading an SSE body', async () => {
    const controller = new AbortController(); let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(streamController) { streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', status: 'in_progress', content: [] } })}\n\n`)); }, cancel() { cancelled = true; } });
    const stream = createCodexStream(async () => settings(false, 'off'))(model, context, { apiKey: token(), transport: 'sse', signal: controller.signal, fetch: async () => new Response(body, { status: 200 }) });
    await new Promise((resolve) => setTimeout(resolve, 0)); controller.abort(); const result = await stream.result();
    expect(result.stopReason).toBe('aborted'); expect(cancelled).toBe(true);
  });
  it('streams WebSocket events and keeps account and route continuation isolated', async () => {
    class FakeSocket implements SocketLike {
      readyState = 1; listeners = new Map<string, Set<(event: unknown) => void>>(); closed = false;
      constructor(_url: string, readonly options?: { headers?: Record<string, string> }) { queueMicrotask(() => this.emit('open', {})); }
      addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void) { const values = this.listeners.get(type) ?? new Set(); values.add(listener); this.listeners.set(type, values); }
      removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void) { this.listeners.get(type)?.delete(listener); }
      emit(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
      send(_data: string) { const fixtures = [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'WS' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'WS', annotations: [] }] } },
        { type: 'response.completed', response: { id: 'response-1', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } },
      ]; queueMicrotask(() => fixtures.forEach((event) => this.emit('message', { data: JSON.stringify(event) }))); }
      close() { this.closed = true; this.readyState = 3; }
    }
    vi.stubGlobal('WebSocket', FakeSocket); const stream = createCodexStream(async () => settings(true, 'off'))(model, context, { apiKey: token(), transport: 'websocket', sessionId: 's' });
    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'WS' }] });
    const socketA = new FakeSocket('wss://one'); const first = { socket: socketA, busy: false, routeKey: 'account-a|default' }; storeConnection('shared-session', first);
    expect(takeConnection('account-a|default', 'shared-session')).toBe(first); first.busy = false;
    const socketB = new FakeSocket('wss://two'); storeConnection('shared-session', { socket: socketB, busy: false, routeKey: 'account-b|default' });
    takeConnection('account-b|default', 'shared-session');
    expect(socketA.closed).toBe(true);
  });
  it('sends only a valid continuation delta and rejects a changed request route', async () => {
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() } satisfies SocketLike;
    const baseline = await buildFinalBody(model, normalizeContext({ messages: [{ role: 'user', content: 'one', timestamp: 1 }] }), undefined, settings(false, 'off'));
    const responseItems = [{ role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }] as unknown as typeof baseline.input;
    const connection = { socket, routeKey: 'route', busy: true, continuation: { body: baseline, responseId: 'r1', responseItems } };
    const current = { ...baseline, input: [...baseline.input, ...connection.continuation.responseItems, { role: 'user', content: 'two' }] } as unknown as CodexRequestBody;
    expect(continuationBody(connection, current).input).toEqual([{ role: 'user', content: 'two' }]);
    expect(continuationBody(connection, { ...current, service_tier: 'priority' }).previous_response_id).toBeUndefined();
  });
  it.each([
    ['websocket-cached', true],
    ['websocket', false],
  ] as const)('%s reuses continuation only when Pi requests caching', async (transport, cached) => {
    const instances: SocketLike[] = []; const requests: Array<Record<string, unknown>> = []; const handshakes: Array<{ url: string; headers?: Record<string, string> }> = [];
    class CapturingSocket implements SocketLike {
      readyState = 1; private listeners = new Map<string, Set<(event: unknown) => void>>();
      constructor(url: string, options?: { headers?: Record<string, string> }) { instances.push(this); handshakes.push({ url, headers: options?.headers }); queueMicrotask(() => this.emit('open', {})); }
      addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
      removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void) { this.listeners.get(type)?.delete(listener); }
      send(data: string) {
        const request = JSON.parse(data) as Record<string, unknown>; requests.push(request); const responseId = `response-${requests.length}`;
        const fixtures = [
          { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', status: 'in_progress', content: [] } },
          { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'answer' },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] } },
          { type: 'response.completed', response: { id: responseId, status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        queueMicrotask(() => { for (const event of fixtures) this.emit('message', { data: JSON.stringify(event) }); });
      }
      close() { this.readyState = 3; }
      private emit(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
    }
    vi.stubGlobal('WebSocket', CapturingSocket); const firstContext: Context = { messages: [{ role: 'user', content: 'one', timestamp: 1 }] };
    const first = await createCodexStream(async () => settings(true, 'off'))(model, normalizeContext(firstContext), { apiKey: token(), transport, sessionId: 'two-turn' }).result();
    const secondContext: Context = { messages: [...firstContext.messages, first, { role: 'user', content: 'two', timestamp: 2 }] };
    const second = await createCodexStream(async () => settings(true, 'off'))(model, normalizeContext(secondContext), { apiKey: token(), transport, sessionId: 'two-turn' }).result();
    expect(instances).toHaveLength(cached ? 1 : 2);
    expect(handshakes[0].url).toBe('wss://chatgpt.com/backend-api/codex/responses'); expect(handshakes[0].headers).toMatchObject({
      authorization: expect.stringMatching(/^Bearer /), 'chatgpt-account-id': 'account-a', 'openai-beta': 'responses_websockets=2026-02-06', originator: 'codex_cli_rs', 'x-codex-routing-hint': 'model=gpt-5.5;tier=priority',
    });
    expect(requests[0]).toMatchObject({ type: 'response.create', model: 'gpt-5.5', service_tier: 'priority', input: expect.any(Array) });
    expect(requests[1].previous_response_id).toBe(cached ? 'response-1' : undefined);
    expect(requests[1].input).toEqual(cached ? [expect.objectContaining({ role: 'user' })] : expect.arrayContaining([expect.objectContaining({ role: 'assistant' }), expect.objectContaining({ role: 'user' })]));
    if (cached) {
      const thirdContext: Context = { messages: [...secondContext.messages, second, { role: 'user', content: 'three', timestamp: 3 }] };
      await createCodexStream(async () => settings(true, 'off'))(model, normalizeContext(thirdContext), { apiKey: token('account-b'), transport, sessionId: 'two-turn' }).result();
      expect(instances).toHaveLength(2); expect(requests[2].previous_response_id).toBeUndefined();
    }
  });
});
