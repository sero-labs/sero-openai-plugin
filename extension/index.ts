import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { OpenAIModelEnhancementConfig } from '../shared/config';
import { adaptSystemPrompt, desiredTools, reconcileTools, resolveActive, rewriteProviderPayload } from './behavior';
import { readConfig, resolveStatePath } from './state-io';
import { registerOwnedTools } from './tools';
import { registerCodexProvider } from './provider/register';
import { closeOwnedSockets } from './provider/continuation';

export default function openAIExtender(pi: ExtensionAPI): void {
  let config: OpenAIModelEnhancementConfig | undefined;
  const reload = async (): Promise<void> => { config = await readConfig(resolveStatePath()); };
  const active = (model: Parameters<typeof resolveActive>[1]) => !config ? undefined : resolveActive(config, model);
  const reconcile = (model: Parameters<typeof resolveActive>[1]) => pi.setActiveTools(reconcileTools(pi.getActiveTools(), desiredTools(active(model))));

  registerOwnedTools(pi);
  const unregisterProvider = registerCodexProvider(
    pi,
    async (model) => resolveActive(await readConfig(resolveStatePath()), model)?.settings,
  );
  pi.on('session_start', async (_event, ctx) => {
    try { await reload(); reconcile(ctx.model); }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : 'OpenAI enhancement state could not be loaded.', 'warning'); reconcile(undefined); }
  });
  pi.on('model_select', async (event, ctx) => {
    try { await reload(); reconcile(event.model); }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : 'OpenAI enhancement state could not be loaded.', 'warning'); reconcile(undefined); }
  });
  pi.on('before_agent_start', async (event, ctx) => {
    try { await reload(); reconcile(ctx.model); }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : 'OpenAI enhancement state could not be loaded.', 'warning'); config = undefined; reconcile(undefined); return; }
    const nextPrompt = adaptSystemPrompt(event.systemPrompt, active(ctx.model));
    if (nextPrompt !== event.systemPrompt) return { systemPrompt: nextPrompt };
  });
  pi.on('before_provider_request', (event, ctx) => ctx.model?.provider === 'openai' ? rewriteProviderPayload(event.payload, active(ctx.model)) : event.payload);
  // Every session in the app shares one model runtime, so the provider serves all of
  // them, subagents included. Close only this session's sockets, and remove the
  // provider only when a reload replaces this extension copy.
  pi.on('session_shutdown', (event, ctx) => {
    config = undefined;
    closeOwnedSockets(ctx.sessionManager.getSessionId());
    if (event.reason === 'reload') unregisterProvider();
  });
}
