/**
 * Archipelag.io SDK Client
 */

import {
  ArchipelagError,
  AuthenticationError,
  InsufficientCreditsError,
  JobFailedError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from './errors';
import type {
  Account,
  AgentOptions,
  AgentResult,
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionParams,
  ChatMessage,
  CompletionUsage,
  Tool,
  ToolCall,
  ToolDefinition,
  ApiKey,
  BatchJob,
  BatchOptions,
  BatchProgress,
  BatchProgressCallback,
  ChatOptions,
  ChatResult,
  ClientOptions,
  CreateJobRequest,
  ImageOptions,
  ImageResult,
  Job,
  StreamCallbacks,
  StreamEvent,
  Usage,
  Workload,
} from './types';

const DEFAULT_BASE_URL = 'https://app.archipelag.io';
const DEFAULT_TIMEOUT = 60000;
// Chat completions wait for an Island to generate the whole answer
const CHAT_TIMEOUT = 180000;
const DEFAULT_MAX_STEPS = 6;

/** Split a fetch body into SSE `data:` payloads, across chunk boundaries */
async function* sseData(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ArchipelagError('No response body');
  }
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield data;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function toDefinition(tool: Tool | ToolDefinition): ToolDefinition {
  if ('type' in tool && tool.type === 'function') return tool;
  const t = tool as Tool;
  return {
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

function chatPayload(
  messages: ChatMessage[],
  params: ChatCompletionParams
): Record<string, unknown> {
  const { tools, model, ...rest } = params;
  const payload: Record<string, unknown> = { model: model || 'auto', messages };
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) payload[key] = value;
  }
  if (tools && tools.length > 0) payload.tools = tools.map(toDefinition);
  return payload;
}

async function runToolCall(tools: Map<string, Tool>, call: ToolCall): Promise<ChatMessage> {
  const name = call.function?.name;
  const message = (content: string): ChatMessage => ({
    role: 'tool',
    tool_call_id: call.id,
    name,
    content,
  });
  const tool = tools.get(name);
  if (!tool) return message(`Error: unknown tool '${name}'`);
  try {
    const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    const result = await tool.run(args);
    return message(typeof result === 'string' ? result : JSON.stringify(result));
  } catch (error) {
    // The model sees the failure and can recover
    return message(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function addUsage(total: CompletionUsage, usage?: CompletionUsage): CompletionUsage {
  return {
    prompt_tokens: total.prompt_tokens + (usage?.prompt_tokens || 0),
    completion_tokens: total.completion_tokens + (usage?.completion_tokens || 0),
    total_tokens: total.total_tokens + (usage?.total_tokens || 0),
  };
}

/**
 * Archipelag.io API Client
 *
 * @example
 * ```typescript
 * const client = new Archipelag({ apiKey: 'ak_xxx' });
 *
 * // Chat
 * const result = await client.chat('Hello!');
 * console.log(result.content);
 *
 * // Streaming
 * await client.chatStream('Tell me a story', {
 *   onToken: (token) => process.stdout.write(token),
 *   onDone: (usage) => console.log(`\n[${usage.totalTokens} tokens]`),
 * });
 * ```
 */
export class Archipelag {
  private apiKey: string;
  private baseUrl: string;
  private timeout: number;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  /**
   * Make an API request
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': '@archipelag/sdk/0.2.0',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return this.handleResponse<T>(response);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ArchipelagError('Request timed out');
      }
      throw error;
    }
  }

  /**
   * Handle API response
   */
  private async handleResponse<T>(response: Response): Promise<T> {
    if (response.ok) {
      const data = await response.json();
      return data.data as T;
    }

    let message: string;
    let errorData: Record<string, unknown> | undefined;

    try {
      errorData = await response.json();
      message =
        (errorData?.error as Record<string, unknown>)?.message as string ||
        response.statusText;
    } catch {
      message = response.statusText;
    }

    switch (response.status) {
      case 401:
        throw new AuthenticationError(message);
      case 402:
        throw new InsufficientCreditsError(message);
      case 404:
        throw new NotFoundError(message);
      case 400:
      case 422:
        throw new ValidationError(
          message,
          errorData?.errors as Record<string, string[]>
        );
      case 429:
        const retryAfter = response.headers.get('Retry-After');
        throw new RateLimitError(
          message,
          retryAfter ? parseInt(retryAfter, 10) : undefined
        );
      default:
        throw new ArchipelagError(message, response.status, errorData);
    }
  }

  // ===========================================================================
  // Account
  // ===========================================================================

  /**
   * Get current account information
   */
  async getAccount(): Promise<Account> {
    return this.request<Account>('GET', '/api/v1/account');
  }

  // ===========================================================================
  // Jobs
  // ===========================================================================

  /**
   * Create a new job
   */
  async createJob(workload: string, input: Record<string, unknown>): Promise<Job> {
    return this.request<Job>('POST', '/api/v1/jobs', { workload, input });
  }

  /**
   * Get job by ID
   */
  async getJob(jobId: string): Promise<Job> {
    return this.request<Job>('GET', `/api/v1/jobs/${jobId}`);
  }

  /**
   * List recent jobs
   */
  async listJobs(limit = 20, offset = 0): Promise<Job[]> {
    return this.request<Job[]>(
      'GET',
      `/api/v1/jobs?limit=${limit}&offset=${offset}`
    );
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId: string): Promise<Job> {
    return this.request<Job>('DELETE', `/api/v1/jobs/${jobId}`);
  }

  /**
   * Wait for a job to complete
   */
  async waitForJob(
    jobId: string,
    pollInterval = 1000,
    timeout?: number
  ): Promise<Job> {
    const start = Date.now();

    while (true) {
      const job = await this.getJob(jobId);

      if (this.isJobComplete(job)) {
        if (job.status === 'failed') {
          throw new JobFailedError(job.error || 'Job failed', jobId);
        }
        return job;
      }

      if (timeout && Date.now() - start > timeout) {
        throw new ArchipelagError(`Job ${jobId} did not complete within ${timeout}ms`);
      }

      await this.sleep(pollInterval);
    }
  }

  /**
   * Stream job output using SSE
   */
  async *streamJob(jobId: string): AsyncGenerator<StreamEvent> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/jobs/${jobId}/stream`,
      {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'text/event-stream',
        },
      }
    );

    if (!response.ok) {
      await this.handleResponse(response);
    }

    for await (const data of sseData(response)) {
      yield this.parseStreamEvent(data);
    }
  }

  private parseStreamEvent(data: string): StreamEvent {
    const parsed = JSON.parse(data);
    return {
      type: parsed.type || 'token',
      content: parsed.content || parsed.chunk,
      step: parsed.step,
      total: parsed.total,
      imageData: parsed.image_data,
      imageFormat: parsed.format,
      error: parsed.error,
      usage: parsed.usage
        ? {
            promptTokens: parsed.usage.prompt_tokens,
            completionTokens: parsed.usage.completion_tokens,
            totalTokens: parsed.usage.total_tokens,
            creditsUsed: parsed.usage.credits_used || 0,
          }
        : undefined,
    };
  }

  // ===========================================================================
  // Workloads
  // ===========================================================================

  /**
   * List available workloads
   */
  async listWorkloads(): Promise<Workload[]> {
    return this.request<Workload[]>('GET', '/api/v1/workloads');
  }

  /**
   * Get workload by slug
   */
  async getWorkload(slug: string): Promise<Workload> {
    return this.request<Workload>('GET', `/api/v1/workloads/${slug}`);
  }

  // ===========================================================================
  // API Keys
  // ===========================================================================

  /**
   * List API keys
   */
  async listApiKeys(): Promise<ApiKey[]> {
    return this.request<ApiKey[]>('GET', '/api/v1/api-keys');
  }

  /**
   * Create a new API key
   */
  async createApiKey(name: string): Promise<{ apiKey: ApiKey; key: string }> {
    const response = await this.request<{ data: ApiKey; key: string }>(
      'POST',
      '/api/v1/api-keys',
      { name }
    );
    return { apiKey: response.data, key: response.key };
  }

  /**
   * Delete an API key
   */
  async deleteApiKey(keyId: string): Promise<void> {
    await this.request<void>('DELETE', `/api/v1/api-keys/${keyId}`);
  }

  // ===========================================================================
  // High-level helpers
  // ===========================================================================

  /**
   * POST to the chat API, which answers in OpenAI shape (not `{data: ...}`)
   */
  private async postChat(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.max(this.timeout, CHAT_TIMEOUT));
    signal?.addEventListener('abort', () => controller.abort());

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          // Servers that only accept JSON reject a bare text/event-stream
          'Accept': payload.stream ? 'text/event-stream, application/json' : 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        await this.handleResponse(response);
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ArchipelagError(signal?.aborted ? 'Request cancelled' : 'Request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Create a chat completion (OpenAI-compatible).
   *
   * @example
   * ```typescript
   * const completion = await client.chatCompletion(
   *   [{ role: 'user', content: 'What is an archipelago?' }],
   *   { model: 'auto', temperature: 0.3 }
   * );
   * console.log(completion.choices[0].message.content);
   * ```
   */
  async chatCompletion(
    messages: ChatMessage[],
    params: ChatCompletionParams = {}
  ): Promise<ChatCompletion> {
    const response = await this.postChat(chatPayload(messages, params));
    return (await response.json()) as ChatCompletion;
  }

  /**
   * Stream a chat completion as OpenAI `chat.completion.chunk` objects.
   * Throws `JobFailedError` if the Island fails mid-stream.
   */
  async *chatCompletionStream(
    messages: ChatMessage[],
    params: ChatCompletionParams & { signal?: AbortSignal } = {}
  ): AsyncGenerator<ChatCompletionChunk> {
    const { signal, ...rest } = params;
    const payload = { ...chatPayload(messages, rest), stream: true };
    const response = await this.postChat(payload, signal);

    for await (const data of sseData(response)) {
      if (data === '[DONE]') return;
      const chunk = JSON.parse(data);
      if (chunk.error) {
        throw new JobFailedError(chunk.error.message || 'Chat completion failed');
      }
      yield chunk as ChatCompletionChunk;
    }
  }

  /**
   * Run a tool-using conversation until the model answers.
   *
   * Each round sends the conversation with the tools; when the model asks
   * for tools, they run in your process (concurrently) and their results go
   * back to it.
   *
   * @example
   * ```typescript
   * const result = await client.runAgent(
   *   [{ role: 'user', content: 'Weather in Oslo?' }],
   *   [{
   *     name: 'get_weather',
   *     description: 'Current weather for a city',
   *     parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
   *     run: async ({ city }) => ({ city, temp: 4 }),
   *   }]
   * );
   * console.log(result.content);
   * ```
   */
  async runAgent(
    messages: ChatMessage[],
    tools: Tool[],
    options: AgentOptions = {}
  ): Promise<AgentResult> {
    const { maxSteps = DEFAULT_MAX_STEPS, onStep, ...params } = options;
    const byName = new Map(tools.map((t) => [t.name, t]));
    const conversation = [...messages];
    let usage: CompletionUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    for (let step = 0; step <= maxSteps; step++) {
      const completion = await this.chatCompletion(conversation, { ...params, tools });
      usage = addUsage(usage, completion.usage);
      const choice = completion.choices[0];
      const message = choice.message;
      conversation.push(message);
      onStep?.(message);

      const calls = message.tool_calls || [];
      if (calls.length === 0) {
        return {
          content: message.content || '',
          messages: conversation,
          steps: step,
          finishReason: choice.finish_reason,
          usage,
        };
      }
      if (step === maxSteps) break;
      conversation.push(...(await Promise.all(calls.map((c) => runToolCall(byName, c)))));
    }

    throw new ArchipelagError(`Model still calling tools after ${maxSteps} rounds`);
  }

  /**
   * Send a chat message and get a response
   */
  async chat(prompt: string, options: ChatOptions = {}): Promise<ChatResult> {
    const completion = await this.chatCompletion(simpleMessages(prompt, options), {
      model: options.workload,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
    });
    const choice = completion.choices[0];

    return {
      content: choice.message.content || '',
      jobId: completion.id,
      usage: toUsage(completion.usage),
      model: completion.model,
      finishReason: choice.finish_reason,
    };
  }

  /**
   * Send a chat message and stream the response
   */
  async chatStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options: ChatOptions = {}
  ): Promise<void> {
    let usage: CompletionUsage | undefined;
    try {
      for await (const chunk of this.chatCompletionStream(simpleMessages(prompt, options), {
        model: options.workload,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        stream_options: { include_usage: true },
      })) {
        if (chunk.usage) usage = chunk.usage;
        for (const choice of chunk.choices || []) {
          if (choice.delta?.content) callbacks.onToken?.(choice.delta.content);
        }
      }
    } catch (error) {
      callbacks.onError?.(error instanceof Error ? error.message : String(error));
      return;
    }
    callbacks.onDone?.(toUsage(usage));
  }

  /**
   * Generate an image from a text prompt
   */
  async generateImage(
    prompt: string,
    options: ImageOptions = {}
  ): Promise<ImageResult> {
    const input: Record<string, unknown> = {
      prompt,
      width: options.width || 1024,
      height: options.height || 1024,
      steps: options.steps || 30,
      guidance_scale: options.guidanceScale || 7.5,
    };
    if (options.negativePrompt) input.negative_prompt = options.negativePrompt;
    if (options.seed !== undefined) input.seed = options.seed;

    const job = await this.createJob(options.workload || 'sdxl', input);
    const completed = await this.waitForJob(job.id);

    const output = JSON.parse(completed.output || '{}');

    return {
      imageData: output.image_data || '',
      imageFormat: output.format || 'png',
      width: output.width || options.width || 1024,
      height: output.height || options.height || 1024,
      seed: output.seed,
      jobId: completed.id,
      usage: completed.usage || { creditsUsed: 0 },
    };
  }

  /**
   * Create multiple jobs at once
   */
  async batch(jobs: CreateJobRequest[]): Promise<Job[]> {
    const created: Job[] = [];
    for (const spec of jobs) {
      const job = await this.createJob(spec.workload, spec.input);
      created.push(job);
    }
    return created;
  }

  /**
   * Wait for multiple jobs to complete
   */
  async waitAll(
    jobs: Job[],
    pollInterval = 1000,
    timeout?: number
  ): Promise<Job[]> {
    const results: Job[] = [];
    for (const job of jobs) {
      const completed = await this.waitForJob(job.id, pollInterval, timeout);
      results.push(completed);
    }
    return results;
  }

  // ===========================================================================
  // Server-side Batch Jobs
  // ===========================================================================

  /**
   * Submit a batch job to be distributed across multiple Islands
   */
  async submitBatch(
    workload: string,
    inputs: Record<string, unknown>[],
    options: BatchOptions = {}
  ): Promise<BatchJob> {
    const body: Record<string, unknown> = {
      workload,
      inputs,
      merge_strategy: options.mergeStrategy || 'concat',
      fail_mode: options.failMode || 'best_effort',
    };
    if (options.maxParallelism !== undefined) body.max_parallelism = options.maxParallelism;
    if (options.region !== undefined) body.region = options.region;
    if (options.bidPrice !== undefined) body.bid_price = String(options.bidPrice);

    // Use raw request since batch response shape differs from standard {data: ...}
    const response = await fetch(`${this.baseUrl}/api/v1/jobs/batch`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      await this.handleResponse(response);
    }

    const data = await response.json();
    return this.mapBatchJob(data);
  }

  /**
   * Get batch job progress
   */
  async getBatchStatus(batchId: string): Promise<BatchProgress> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/jobs/${batchId}/batch-status`,
      {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      await this.handleResponse(response);
    }

    const data = await response.json();
    return {
      parentId: data.parent_id,
      parentState: data.parent_state,
      chunkCount: data.chunk_count,
      mergeStrategy: data.merge_strategy,
      failMode: data.fail_mode,
      childStates: data.child_states || {},
      children: (data.children || []).map((c: any) => ({
        id: c.id,
        batchIndex: c.batch_index,
        state: c.state,
        error: c.error,
        hostId: c.host_id,
      })),
    };
  }

  /**
   * Wait for a batch job to complete
   */
  async waitForBatch(
    batchId: string,
    pollInterval = 2000,
    timeout?: number,
    onProgress?: BatchProgressCallback
  ): Promise<BatchProgress> {
    const start = Date.now();

    while (true) {
      const progress = await this.getBatchStatus(batchId);

      if (onProgress) {
        const completed = progress.childStates['succeeded'] || 0;
        const failed = progress.childStates['failed'] || 0;
        onProgress(completed, failed, progress.chunkCount);
      }

      if (['succeeded', 'failed', 'cancelled'].includes(progress.parentState)) {
        if (progress.parentState === 'failed') {
          throw new JobFailedError('Batch failed', batchId);
        }
        return progress;
      }

      if (timeout && Date.now() - start > timeout) {
        throw new ArchipelagError(`Batch ${batchId} did not complete within ${timeout}ms`);
      }

      await this.sleep(pollInterval);
    }
  }

  private mapBatchJob(data: any): BatchJob {
    return {
      id: data.id,
      state: data.state,
      workload: data.workload,
      batch: {
        chunkCount: data.batch?.chunk_count || 0,
        mergeStrategy: data.batch?.merge_strategy || 'concat',
        failMode: data.batch?.fail_mode || 'best_effort',
        completed: data.batch?.completed || 0,
        failed: data.batch?.failed || 0,
      },
      children: (data.children || []).map((c: any) => ({
        id: c.id,
        batchIndex: c.batch_index,
        state: c.state,
        error: c.error,
        hostId: c.host_id,
      })),
      createdAt: data.created_at,
    };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private isJobComplete(job: Job): boolean {
    return ['completed', 'failed', 'cancelled', 'timeout'].includes(job.status);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function simpleMessages(prompt: string, options: ChatOptions): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (options.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt });
  messages.push({ role: 'user', content: prompt });
  return messages;
}

function toUsage(usage?: CompletionUsage): Usage {
  return {
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens,
    creditsUsed: 0,
  };
}
