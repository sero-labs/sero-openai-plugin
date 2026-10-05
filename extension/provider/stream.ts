import { createAssistantMessageEventStream, getDeclaredTools, normalizeContext, resolveTranscript, type AssistantMessage, type AssistantMessageEventStream, type TranscriptContext, type Usage } from '@earendil-works/pi-ai';
import { convertResponsesMessages, processResponsesStream } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { createGrammarToolInputProperties } from '@earendil-works/pi-ai/api/constrained-sampling';
import type { ResponseInput } from 'openai/resources/responses/responses.js';
import { CodexEventError, normalizeEvents } from './events';
import { buildFinalBody } from './request';
import { prepareRouting } from './routing';
import { openSse, parseSse } from './sse';
import { applyTierCost, resolveTier } from './usage';
import { discardWebSocket, finishWebSocket, openWebSocket } from './websocket';
import { closeOwnedSockets, type Connection } from './continuation';
import type { CodexModel, CodexOptions, SettingsLoader } from './types';

const TOOL_PROVIDERS = new Set(['openai', 'openai-codex', 'opencode']);
function emptyUsage(): Usage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
function outputFor(model: CodexModel): AssistantMessage { return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: 'pending', timestamp: Date.now() }; }
function safeMessage(error: unknown): string { if (error instanceof Error && /aborted/i.test(error.message)) return 'Request was aborted'; if (error instanceof CodexEventError) return error.message; return error instanceof Error && /^(OpenAI Codex|Provider|WebSocket)/.test(error.message) ? error.message : 'OpenAI Codex request failed.'; }
interface DispatchState { started: boolean }
function responseOptions(model: CodexModel, prepared: ReturnType<typeof prepareRouting>, grammarToolInputProperties: ReadonlyMap<string, string>) {
  return { serviceTier: prepared.requestedTier, grammarToolInputProperties, resolveServiceTier: (responseTier: Parameters<typeof resolveTier>[0], requested: Parameters<typeof resolveTier>[1]) => resolveTier(responseTier, requested), applyServiceTierPricing: (usage: Usage, tier: unknown) => applyTierCost(usage, tier, model, prepared.routedModelId) };
}
async function processSse(model: CodexModel, prepared: ReturnType<typeof prepareRouting>, output: AssistantMessage, stream: AssistantMessageEventStream, state: DispatchState, grammarToolInputProperties: ReadonlyMap<string, string>, options?: CodexOptions): Promise<void> {
  const response = await openSse(prepared, model, options); if (!state.started) { state.started = true; stream.push({ type: 'start', partial: output }); }
  await processResponsesStream(normalizeEvents(parseSse(response, options?.signal, options?.timeoutMs), output), output, stream, model, responseOptions(model, prepared, grammarToolInputProperties));
}
async function processSocket(model: CodexModel, prepared: ReturnType<typeof prepareRouting>, output: AssistantMessage, stream: AssistantMessageEventStream, state: DispatchState, grammarToolInputProperties: ReadonlyMap<string, string>, options?: CodexOptions): Promise<void> {
  let connection: Connection | undefined; const generator = openWebSocket(prepared, options, (value) => { connection = value; }); const iterator = generator[Symbol.asyncIterator]();
  async function* events() { while (true) { const item = await iterator.next(); if (item.done) return; yield item.value; } }
  async function* startedEvents() { for await (const event of normalizeEvents(events(), output)) { if (!state.started) { state.started = true; stream.push({ type: 'start', partial: output }); } yield event; } }
  try { await processResponsesStream(startedEvents(), output, stream, model, responseOptions(model, prepared, grammarToolInputProperties)); }
  catch (error) { if (connection) discardWebSocket(prepared, connection); throw error; }
  if (!connection) throw new Error('WebSocket connection was not established.');
  const responseItems: ResponseInput = convertResponsesMessages(model, normalizeContext({ messages: [output] }), TOOL_PROVIDERS, { includeSystemPrompt: false, grammarToolInputProperties }).filter((item) => item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output');
  finishWebSocket(prepared, connection, output.responseId, responseItems, options);
}
export function createCodexStream(loadSettings: SettingsLoader) {
  return (model: CodexModel, rawContext: TranscriptContext, options?: CodexOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream(); const output = outputFor(model);
    const context = resolveTranscript(rawContext, model.compat?.supportsMidConvoSystemMessages);
    void (async () => {
      try {
        const settings = await loadSettings(model); if (!settings) throw new Error('Provider settings changed before dispatch.');
        if (options?.cacheRetention === 'none') closeOwnedSockets(options.sessionId);
        const sessionId = options?.cacheRetention === 'none' ? undefined : options?.sessionId;
        const body = await buildFinalBody(model, context, options, settings, sessionId); const prepared = prepareRouting(model, body, options);
        const grammarToolInputProperties = createGrammarToolInputProperties(getDeclaredTools(context.messages), model.compat?.supportsOpenAIGrammarTools ?? false); const state: DispatchState = { started: false };
        let websocketStarted = false;
        if (options?.transport !== 'sse') {
          for (let attempt = 0; attempt < 2 && !websocketStarted; attempt += 1) {
            try { await processSocket(model, prepared, output, stream, state, grammarToolInputProperties, options); websocketStarted = true; }
            catch (error) {
              if (state.started || output.content.length > 0 || options?.signal?.aborted) throw error;
              const recoverable = error instanceof CodexEventError && (error.code === 'websocket_connection_limit_reached' || error.code === 'previous_response_not_found');
              if (error instanceof CodexEventError && !recoverable) throw error;
              if (recoverable && attempt === 0) continue;
              break;
            }
          }
        }
        if (!websocketStarted) await processSse(model, prepared, output, stream, state, grammarToolInputProperties, options);
        if (output.stopReason === 'pending' || output.stopReason === 'error' || output.stopReason === 'aborted') throw new Error('OpenAI Codex stream ended without a result.');
        stream.push({ type: 'done', reason: output.stopReason, message: output }); stream.end();
      } catch (error) {
        for (const block of output.content) {
          if (block.type !== 'toolCall') continue;
          delete (block as { partialJson?: unknown }).partialJson;
          delete (block as { customInput?: unknown }).customInput;
        }
        output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'; output.errorMessage = safeMessage(error); stream.push({ type: 'error', reason: output.stopReason, error: output }); stream.end();
      }
    })();
    return stream;
  };
}
