import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, normalizeContext, type TranscriptContext, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { DEFAULT_SETTINGS } from '../../shared/config';
import { composeModelProvider, type ProviderConfigInput } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js';
import { ModelConfig } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js';

const mocks = vi.hoisted(() => ({ stock: vi.fn(() => {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], api: 'openai-codex-responses', provider: 'openai-codex', model: 'stock', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'error', errorMessage: 'stock', timestamp: 1 } }));
  return stream;
}) }));
vi.mock('@earendil-works/pi-ai/api/openai-codex-responses', () => ({ streamSimple: mocks.stock }));
import { registerCodexProvider } from '../provider/register';

const model = (id: string): Model<'openai-codex-responses'> => ({ id, name: id, api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://example.test', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 });
const context = normalizeContext({ messages: [] }); const options: SimpleStreamOptions = { transport: 'sse' };

describe('Codex provider registration', () => {
  it('delegates unsupported and disabled requests to stock with unchanged arguments', async () => {
    let registered: { streamSimple: (model: Model<'openai-codex-responses'>, context: TranscriptContext, options?: SimpleStreamOptions) => ReturnType<typeof createAssistantMessageEventStream> } | undefined;
    const pi = { registerProvider: vi.fn((_name, config) => { registered = config; }), unregisterProvider: vi.fn() };
    registerCodexProvider(pi as never, async () => undefined);
    const unsupported = model('not-compatible'); await registered!.streamSimple(unsupported, context, options).result();
    const disabled = model('gpt-5.4'); await registered!.streamSimple(disabled, context, options).result();
    expect(mocks.stock).toHaveBeenNthCalledWith(1, unsupported, context, options); expect(mocks.stock).toHaveBeenNthCalledWith(2, disabled, context, options);
  });
  it('selects the owned stream only for an enabled exact record', async () => {
    let registered: { streamSimple: (model: Model<'openai-codex-responses'>, context: TranscriptContext, options?: SimpleStreamOptions) => ReturnType<typeof createAssistantMessageEventStream> } | undefined;
    const pi = { registerProvider: (_name: string, config: typeof registered) => { registered = config; }, unregisterProvider: vi.fn() };
    const trackSession = vi.fn();
    registerCodexProvider(pi as never, async () => DEFAULT_SETTINGS, trackSession);
    const completed = `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } })}\n\n`;
    const fetcher = vi.fn(async () => new Response(completed, { status: 200 }));
    const before = mocks.stock.mock.calls.length;
    const token = `aaa.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })).toString('base64url')}.bbb`;
    const result = await registered!.streamSimple(model('gpt-5.4'), context, { ...options, sessionId: 'session-1', apiKey: token, fetch: fetcher }).result();
    expect(result.stopReason).toBe('stop'); expect(fetcher).toHaveBeenCalledOnce(); expect(mocks.stock.mock.calls).toHaveLength(before);
    expect(trackSession).toHaveBeenCalledWith('session-1');
  });
  it('preserves the built-in catalog, OAuth, headers, and filtering through Pi composition', async () => {
    let extension: ProviderConfigInput | undefined;
    const pi = { registerProvider: (_name: string, config: ProviderConfigInput) => { extension = config; }, unregisterProvider: vi.fn() };
    registerCodexProvider(pi as never, async () => undefined);
    const base = openaiCodexProvider();
    const composed = composeModelProvider('openai-codex', base, await ModelConfig.load(undefined), extension);
    expect(composed.getModels()).toEqual(base.getModels());
    expect(composed.baseUrl).toBe(base.baseUrl); expect(composed.headers).toEqual(base.headers);
    expect(composed.auth.oauth?.name).toBe(base.auth.oauth?.name); expect(composed.filterModels).toBe(base.filterModels);
  });
});
