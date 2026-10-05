import type { ResponseCreateParamsStreaming, ResponseInput, ResponseStreamEvent } from 'openai/resources/responses/responses.js';
import type { Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { EnhancementSettings } from '../../shared/config';

export interface CodexRequestBody {
  model: string; store: boolean; stream: boolean; instructions: string; input: ResponseInput;
  tools?: unknown[]; tool_choice: 'auto'; parallel_tool_calls: boolean;
  reasoning?: { effort?: string; summary: string }; text?: Record<string, unknown>;
  temperature?: number;
  include: string[]; prompt_cache_key?: string; service_tier?: unknown;
  previous_response_id?: string; [key: string]: unknown;
}
export interface PreparedRequest {
  body: CodexRequestBody; accountId: string; sessionId?: string; requestId: string;
  routeKey: string; headers: Headers; endpoint: string; requestedTier?: ServiceTier; routedModelId: string;
}
export type ServiceTier = ResponseCreateParamsStreaming['service_tier'];
export type CodexModel = Model<'openai-codex-responses'>;
export type CodexOptions = SimpleStreamOptions;
export type SettingsLoader = (model: CodexModel) => Promise<Readonly<EnhancementSettings> | undefined>;
export type CodexEvent = ResponseStreamEvent;
