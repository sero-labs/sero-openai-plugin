import { convertResponsesMessages, convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { clampThinkingLevel, getDeclaredTools, getInitialSystemMessage, getSystemMessageText, resolveTranscript, resolveTranscriptTools, type TranscriptContext } from '@earendil-works/pi-ai';
import { createGrammarToolInputProperties } from '@earendil-works/pi-ai/api/constrained-sampling';
import type { EnhancementSettings } from '../../shared/config';
import type { CodexModel, CodexOptions, CodexRequestBody } from './types';

const TOOL_PROVIDERS = new Set(['openai', 'openai-codex', 'opencode']);
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export async function buildFinalBody(model: CodexModel, rawContext: TranscriptContext, options: CodexOptions | undefined, settings: Readonly<EnhancementSettings>, sessionId?: string): Promise<CodexRequestBody> {
  const context = resolveTranscript(rawContext, model.compat?.supportsMidConvoSystemMessages);
  const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
  const grammarToolInputProperties = createGrammarToolInputProperties(getDeclaredTools(context.messages), supportsOpenAIGrammarTools);
  const supportsAdditionalTools = model.compat?.supportsAdditionalTools ?? false; const supportsToolSearch = model.compat?.supportsToolSearch ?? false;
  // The system prompt and the tools are in the transcript. Pi's own Codex provider reads them the same way.
  const transcriptTools = resolveTranscriptTools(context.messages, supportsAdditionalTools || supportsToolSearch);
  const initialSystemMessage = getInitialSystemMessage(context.messages);
  const instructions = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : '';
  const body: CodexRequestBody = {
    model: model.id, store: false, stream: true, instructions: instructions || 'You are a helpful assistant.',
    input: convertResponsesMessages(model, context, TOOL_PROVIDERS, { includeSystemPrompt: false, grammarToolInputProperties, supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false, supportsAdditionalTools, supportsToolSearch, toolOptions: { strict: null, supportsStrictMode: model.compat?.supportsStrictMode ?? true, supportsOpenAIGrammarTools } }),
    include: ['reasoning.encrypted_content'], prompt_cache_key: sessionId, tool_choice: 'auto', parallel_tool_calls: true,
  };
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (transcriptTools.requestTools.length) body.tools = convertResponsesTools(transcriptTools.requestTools, { strict: null, supportsStrictMode: model.compat?.supportsStrictMode ?? true, supportsOpenAIGrammarTools });
  if (options?.reasoning) {
    const clamped = clampThinkingLevel(model, options.reasoning);
    if (clamped !== 'off') {
      const effort = model.thinkingLevelMap?.[clamped] ?? clamped;
      if (effort !== null) body.reasoning = { effort, summary: 'auto' };
    }
  }
  if (settings.fastMode) body.service_tier = 'priority';
  if (settings.verbosity !== 'off') body.text = { verbosity: settings.verbosity };
  const replacement = await options?.onPayload?.(body, model);
  if (replacement === undefined) return body;
  if (!isRecord(replacement) || typeof replacement.model !== 'string' || !Array.isArray(replacement.input)) throw new Error('Provider request hook returned an invalid body.');
  return replacement as CodexRequestBody;
}
