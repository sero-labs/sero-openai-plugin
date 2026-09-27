import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../../shared/config';
import { setDefault, setEnabled } from '../../shared/state';
import { closeOwnedSockets, storeConnection, type SocketLike } from '../provider/continuation';

const mocks = vi.hoisted(() => ({ config: undefined as ReturnType<typeof createDefaultConfig> | undefined }));
vi.mock('../state-io', () => ({ resolveStatePath: () => '/profile/state.json', readConfig: vi.fn(async () => mocks.config!) }));
vi.mock('../tools', () => ({ registerOwnedTools: vi.fn() }));
import openAIExtender from '../index';

const supported = { provider: 'openai', api: 'openai-responses', id: 'gpt-5.4' };
const oauth = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-5.4' };
function harness(model = supported) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>(); let active = ['read', 'other_tool', 'openai_extender_web_search'];
  const pi = {
    on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    getAllTools: () => [], getActiveTools: () => active,
    setActiveTools: vi.fn((next: string[]) => { active = next; }),
    registerProvider: vi.fn(), unregisterProvider: vi.fn(),
  };
  openAIExtender(pi as never);
  const ctx = { model, modelRegistry: { isUsingOAuth: () => model.provider === 'openai-codex' }, ui: { notify: vi.fn() }, sessionManager: { getSessionId: () => 'owned-session' } };
  return { handlers, pi, ctx, active: () => active };
}

describe('extension lifecycle', () => {
  beforeEach(() => { mocks.config = createDefaultConfig(); });
  it('retains desired owned tools and preserves foreign tools across turns', async () => {
    mocks.config = setDefault(setEnabled(createDefaultConfig(), true), 'webTools', true);
    const { handlers, ctx, active } = harness();
    await handlers.get('before_agent_start')!({ systemPrompt: 'Sero and project context' }, ctx as never);
    expect(active()).toEqual(['read', 'other_tool', 'openai_extender_web_search', 'openai_extender_read_page']);
  });
  it('removes only plugin-owned tools when the selected model becomes disabled', async () => {
    const { handlers, ctx, active } = harness();
    await handlers.get('model_select')!({ model: supported }, ctx as never);
    expect(active()).toEqual(['read', 'other_tool']);
  });
  it('closes only the shutting-down session\'s sockets and keeps the shared provider', async () => {
    const closed = { owned: false, foreign: false };
    const socket = (key: keyof typeof closed): SocketLike => ({ readyState: 1, send: () => undefined, close: () => { closed[key] = true; }, addEventListener: () => undefined, removeEventListener: () => undefined });
    const { handlers, ctx, pi } = harness(oauth);
    const provider = pi.registerProvider.mock.calls[0][1] as { streamSimple: (model: unknown, context: unknown, options: unknown) => { result(): Promise<unknown> } };
    const completed = `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } })}\n\n`;
    const token = `aaa.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })).toString('base64url')}.bbb`;
    mocks.config = setEnabled(createDefaultConfig(), true);
    await provider.streamSimple(oauth, { messages: [] }, { transport: 'sse', sessionId: 'owned-session', apiKey: token, fetch: async () => new Response(completed) }).result();
    storeConnection('owned-session', { socket: socket('owned'), routeKey: 'route', busy: false });
    storeConnection('foreign-session', { socket: socket('foreign'), routeKey: 'route', busy: false });
    await handlers.get('session_start')!({}, ctx as never);
    handlers.get('session_shutdown')!({ reason: 'quit' }, ctx as never);
    expect(pi.setActiveTools).toHaveBeenCalled();
    // Another live session, such as the chat that started this subagent, still streams through it.
    expect(pi.unregisterProvider).not.toHaveBeenCalled();
    expect(closed).toEqual({ owned: true, foreign: false });
    closeOwnedSockets('foreign-session');
  });
  it('removes the provider when a reload replaces the extension copy', () => {
    const { handlers, ctx, pi } = harness();
    handlers.get('session_shutdown')!({ reason: 'reload' }, ctx as never);
    expect(pi.unregisterProvider).toHaveBeenCalledWith('openai-codex');
  });
  it('registers the Codex override before session start without replacing provider metadata', () => {
    const { pi } = harness();
    expect(pi.registerProvider).toHaveBeenCalledWith('openai-codex', expect.objectContaining({ api: 'openai-codex-responses', streamSimple: expect.any(Function) }));
    expect(pi.registerProvider.mock.calls[0][1]).not.toHaveProperty('models');
    expect(pi.registerProvider.mock.calls[0][1]).not.toHaveProperty('oauth');
  });
  it('activates the OAuth route while keeping request-hook mutation on API-key routes', async () => {
    mocks.config = setDefault(setEnabled(createDefaultConfig(), true), 'webTools', true);
    const oauthHarness = harness(oauth); const prompt = await oauthHarness.handlers.get('before_agent_start')!({ systemPrompt: 'Sero and project context' }, oauthHarness.ctx as never);
    expect(prompt).toEqual({ systemPrompt: expect.stringContaining('OpenAI') }); expect(oauthHarness.active()).toContain('openai_extender_web_search');
    const oauthBody = { model: 'gpt-5.4', input: [], marker: 'unchanged' };
    expect(oauthHarness.handlers.get('before_provider_request')!({ payload: oauthBody }, oauthHarness.ctx as never)).toBe(oauthBody);
    mocks.config = createDefaultConfig(); await oauthHarness.handlers.get('model_select')!({ model: oauth }, oauthHarness.ctx as never);
    expect(oauthHarness.active()).toEqual(['read', 'other_tool']); expect(await oauthHarness.handlers.get('before_agent_start')!({ systemPrompt: 'Sero and project context' }, oauthHarness.ctx as never)).toBeUndefined();

    mocks.config = setDefault(setDefault(setEnabled(createDefaultConfig(), true), 'fastMode', true), 'verbosity', 'high');
    const apiHarness = harness(); await apiHarness.handlers.get('before_agent_start')!({ systemPrompt: 'Sero and project context' }, apiHarness.ctx as never);
    expect(apiHarness.handlers.get('before_provider_request')!({ payload: { model: 'gpt-5.4', input: [] } }, apiHarness.ctx as never)).toMatchObject({ service_tier: 'priority', text: { verbosity: 'high' } });
  });
});
