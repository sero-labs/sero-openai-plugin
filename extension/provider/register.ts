import { streamSimple as stockCodexStream } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { createAssistantMessageEventStream, type Api, type Model, type SimpleStreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { findCompatibility } from '../../shared/compatibility';
import { createCodexStream } from './stream';
import type { CodexModel, SettingsLoader } from './types';

export function registerCodexProvider(
  pi: ExtensionAPI,
  loadSettings: SettingsLoader,
  trackSession: (sessionId: string) => void = () => undefined,
): () => void {
  pi.registerProvider('openai-codex', {
    api: 'openai-codex-responses',
    streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
      const compatible = findCompatibility(model.provider, model.api, model.id);
      if (!compatible || model.api !== 'openai-codex-responses') return stockCodexStream(model as unknown as CodexModel, context, options);
      if (options?.sessionId) trackSession(options.sessionId);
      const codexModel = model as unknown as CodexModel;
      const output = createAssistantMessageEventStream();
      void (async () => {
        try {
          let settings: Awaited<ReturnType<SettingsLoader>>;
          try { settings = await loadSettings(codexModel); } catch { settings = undefined; }
          const source = settings ? createCodexStream(async () => settings)(codexModel, context, options) : stockCodexStream(codexModel, context, options);
          for await (const event of source) output.push(event);
        } finally { output.end(); }
      })();
      return output;
    },
  });
  return () => pi.unregisterProvider('openai-codex');
}
