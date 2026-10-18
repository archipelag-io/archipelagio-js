/**
 * Archipelag.io SDK Types
 */

export type JobStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export type RuntimeType = 'container' | 'wasm';

export type StreamEventType =
  | 'token'
  | 'status'
  | 'progress'
  | 'image'
  | 'error'
  | 'done';

/**
 * Token/resource usage information
 */
export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  creditsUsed: number;
}

/**
 * Job information
 */
export interface Job {
  id: string;
  workloadId: number;
  workloadSlug?: string;
  status: JobStatus;
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  usage?: Usage;
}

/**
 * Streaming event
 */
export interface StreamEvent {
  type: StreamEventType;
  content?: string;
  step?: number;
  total?: number;
  imageData?: string;
  imageFormat?: string;
  error?: string;
  usage?: Usage;
}

/**
 * Chat completion result
 */
export interface ChatResult {
  content: string;
  jobId: string;
  usage: Usage;
  model?: string;
  finishReason?: string;
}

/**
 * Image generation result
 */
export interface ImageResult {
  imageData: string;
  imageFormat: string;
  width: number;
  height: number;
  seed?: number;
  jobId: string;
  usage: Usage;
}

/**
 * Workload information
 */
export interface Workload {
  id: number;
  name: string;
  slug: string;
  description?: string;
  runtimeType: RuntimeType;
  requiredVramMb?: number;
  requiredRamMb?: number;
  pricePerJob: number;
  isEnabled: boolean;
}

/**
 * API key information
 */
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

/**
 * Account information
 */
export interface Account {
  id: string;
  email: string;
  credits: number;
  createdAt: string;
}

/**
 * Client configuration options
 */
export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

/**
 * Chat request options
 */
export interface ChatOptions {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  workload?: string;
}

/**
 * Image generation options
 */
export interface ImageOptions {
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  guidanceScale?: number;
  seed?: number;
  workload?: string;
}

/**
 * Stream callbacks
 */
export interface StreamCallbacks {
  onToken?: (token: string) => void;
  onProgress?: (step: number, total: number) => void;
  onImage?: (imageData: string, format: string) => void;
  onError?: (error: string) => void;
  onDone?: (usage: Usage) => void;
}

/**
 * Job creation request
 */
export interface CreateJobRequest {
  workload: string;
  input: Record<string, unknown>;
}

// ===========================================================================
// Batch Jobs
// ===========================================================================

/**
 * A child job within a batch
 */
export interface BatchChild {
  id: string;
  batchIndex: number;
  state: string;
  error?: string;
  hostId?: string;
}

/**
 * Batch configuration and counters
 */
export interface BatchConfig {
  chunkCount: number;
  mergeStrategy: string;
  failMode: string;
  completed: number;
  failed: number;
}

/**
 * A batch job with its children
 */
export interface BatchJob {
  id: string;
  state: string;
  workload: string;
  batch: BatchConfig;
  children: BatchChild[];
  createdAt: string;
}

/**
 * Batch progress information
 */
export interface BatchProgress {
  parentId: string;
  parentState: string;
  chunkCount: number;
  mergeStrategy: string;
  failMode: string;
  childStates: Record<string, number>;
  children: BatchChild[];
}

/**
 * Options for submitting a batch job
 */
export interface BatchOptions {
  mergeStrategy?: 'concat' | 'flatten';
  failMode?: 'best_effort' | 'fail_fast';
  maxParallelism?: number;
  region?: string;
  bidPrice?: number;
}

/**
 * Callback for batch progress updates
 */
export interface BatchProgressCallback {
  (completed: number, failed: number, total: number): void;
}

// =============================================================================
// Chat completions (OpenAI-compatible) and tool calling
// =============================================================================

/**
 * A tool call the model made (OpenAI shape)
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded arguments */
    arguments: string;
  };
}

/**
 * A message in a conversation (OpenAI shape)
 */
export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Assistant turns that call tools */
  tool_calls?: ToolCall[];
  /** Tool results: the call this answers */
  tool_call_id?: string;
  name?: string;
  /** A reasoning model's thinking (responses only) */
  reasoning_content?: string;
}

/**
 * An OpenAI tool definition
 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    /** JSON schema for the arguments */
    parameters?: Record<string, unknown>;
  };
}

/**
 * Parameters for `chatCompletion`. Any other OpenAI parameter is passed
 * through as-is.
 */
export interface ChatCompletionParams {
  /** Cargo slug, OpenAI alias, or 'auto' (default) */
  model?: string;
  tools?: Array<Tool | ToolDefinition>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  seed?: number;
  stop?: string | string[];
  response_format?: Record<string, unknown>;
  /** false skips the thinking phase of reasoning models */
  enable_thinking?: boolean;
  [key: string]: unknown;
}

/**
 * Token counts reported by the chat API
 */
export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * A chat completion (OpenAI shape)
 */
export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls' | string;
  }>;
  usage?: CompletionUsage;
}

/**
 * One streamed chunk (OpenAI shape). The last chunk may carry only `usage`.
 */
export interface ChatCompletionChunk {
  id?: string;
  object: 'chat.completion.chunk';
  created?: number;
  model?: string;
  choices: Array<{
    index: number;
    delta: Partial<ChatMessage> & { tool_calls?: Array<Partial<ToolCall> & { index: number }> };
    finish_reason: string | null;
  }>;
  usage?: CompletionUsage;
}

/**
 * A tool the model can call, implemented in your code
 */
export interface Tool {
  name: string;
  description?: string;
  /** JSON schema for the arguments */
  parameters?: Record<string, unknown>;
  /** Runs the tool; the return value is sent to the model (as JSON unless a string) */
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/**
 * Options for `runAgent`
 */
export interface AgentOptions extends Omit<ChatCompletionParams, 'tools'> {
  /** Most tool rounds before giving up (default 6) */
  maxSteps?: number;
  /** Called with each assistant message as it arrives */
  onStep?: (message: ChatMessage) => void;
}

/**
 * Outcome of `runAgent`
 */
export interface AgentResult {
  /** The model's final answer */
  content: string;
  /** The whole conversation, including tool calls and results */
  messages: ChatMessage[];
  /** How many tool rounds ran */
  steps: number;
  finishReason?: string;
  usage: CompletionUsage;
}
