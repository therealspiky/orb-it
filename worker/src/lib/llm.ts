import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { toolSchema } from './schemas.js';

export interface StructuredCall<T> {
  model: string;
  system: string;
  /** Large, reusable context (the transcript). Sent as a cached system block. */
  cachedContext?: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: z.ZodType<T>;
  maxTokens: number;
}

export interface StructuredResult<T> {
  value: T;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface LlmClient {
  structured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>>;
}

/** Rough token estimate (≈3.5 chars/token) used to stay under model price/length tiers. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export class AnthropicLlm implements LlmClient {
  private client: Anthropic;
  /**
   * Keys not scoped to a workspace in the Anthropic Console must name the
   * workspace on every request (anthropic-workspace-id header).
   */
  constructor(apiKey: string, workspaceId?: string) {
    this.client = new Anthropic({
      apiKey, maxRetries: 3,
      defaultHeaders: workspaceId ? { 'anthropic-workspace-id': workspaceId } : undefined,
    });
  }

  async structured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
    const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: call.system }];
    if (call.cachedContext) {
      system.push({ type: 'text', text: call.cachedContext, cache_control: { type: 'ephemeral' } });
    }
    const tool: Anthropic.Tool = {
      name: call.toolName,
      description: call.toolDescription,
      input_schema: toolSchema(call.schema) as Anthropic.Tool.InputSchema,
    };
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: call.user }];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    // One corrective retry: schema errors are returned to the model verbatim.
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.client.messages.create({
        model: call.model,
        max_tokens: call.maxTokens,
        system,
        messages,
        tools: [tool],
        tool_choice: { type: 'tool', name: call.toolName },
      });
      usage.input += res.usage.input_tokens;
      usage.output += res.usage.output_tokens;
      usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
      const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (!block) throw new Error(`Model returned no ${call.toolName} call (stop: ${res.stop_reason})`);
      const parsed = call.schema.safeParse(block.input);
      if (parsed.success) return { value: parsed.data, model: res.model, usage };
      if (res.stop_reason === 'max_tokens') {
        throw new Error(`Model output was truncated at ${call.maxTokens} tokens`);
      }
      messages.push({ role: 'assistant', content: res.content });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: `The input did not match the schema. Fix these problems and call ${call.toolName} again:\n${parsed.error.message.slice(0, 4000)}`,
        }],
      });
    }
    throw new Error(`Model output failed schema validation twice for ${call.toolName}`);
  }
}
