/**
 * useChat hook for chat completions
 */

import { useCallback, useRef, useState } from 'react';
import type { ChatOptions, ChatMessage as SdkChatMessage, Usage } from '@archipelag/sdk';
import { useArchipelag } from '../context';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface UseChatOptions extends ChatOptions {
  /**
   * Initial messages
   */
  initialMessages?: ChatMessage[];
  /**
   * Called when streaming starts
   */
  onStart?: () => void;
  /**
   * Called for each token during streaming
   */
  onToken?: (token: string) => void;
  /**
   * Called when streaming completes
   */
  onFinish?: (content: string, usage: Usage) => void;
  /**
   * Called on error
   */
  onError?: (error: Error) => void;
}

export interface UseChatReturn {
  /**
   * All messages in the conversation
   */
  messages: ChatMessage[];
  /**
   * Send a message
   */
  send: (content: string) => Promise<void>;
  /**
   * Whether a response is being generated
   */
  isLoading: boolean;
  /**
   * Whether streaming is in progress
   */
  isStreaming: boolean;
  /**
   * Current streaming content
   */
  streamingContent: string;
  /**
   * Last error
   */
  error: Error | null;
  /**
   * Stop the answer being generated
   */
  stop: () => void;
  /**
   * Clear all messages
   */
  clear: () => void;
  /**
   * Set messages manually
   */
  setMessages: (messages: ChatMessage[]) => void;
}

/**
 * Hook for chat completions with streaming support
 *
 * @example
 * ```tsx
 * function ChatComponent() {
 *   const { messages, send, isLoading, streamingContent } = useChat();
 *
 *   return (
 *     <div>
 *       {messages.map((msg, i) => (
 *         <div key={i}>
 *           <strong>{msg.role}:</strong> {msg.content}
 *         </div>
 *       ))}
 *       {isLoading && <div>Assistant: {streamingContent}</div>}
 *       <input
 *         onKeyDown={(e) => {
 *           if (e.key === 'Enter') {
 *             send(e.currentTarget.value);
 *             e.currentTarget.value = '';
 *           }
 *         }}
 *       />
 *     </div>
 *   );
 * }
 * ```
 */
export function useChat(options: UseChatOptions = {}): UseChatReturn {
  const { client } = useArchipelag();
  const [messages, setMessages] = useState<ChatMessage[]>(
    options.initialMessages || []
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<Error | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (content: string) => {
      if (isLoading) return;

      setError(null);
      setIsLoading(true);
      setIsStreaming(true);
      setStreamingContent('');
      options.onStart?.();

      // Add user message
      const userMessage: ChatMessage = { role: 'user', content };
      setMessages((prev) => [...prev, userMessage]);

      // The model sees the whole conversation, not just the new message
      const history: SdkChatMessage[] = [
        ...(options.systemPrompt ? [{ role: 'system' as const, content: options.systemPrompt }] : []),
        ...messages,
        userMessage,
      ];

      const controller = new AbortController();
      abortRef.current = controller;
      let fullContent = '';
      let usage: Usage = { creditsUsed: 0 };

      try {
        for await (const chunk of client.chatCompletionStream(history, {
          model: options.workload,
          max_tokens: options.maxTokens,
          temperature: options.temperature,
          stream_options: { include_usage: true },
          signal: controller.signal,
        })) {
          if (chunk.usage) {
            usage = {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
              creditsUsed: 0,
            };
          }
          const token = chunk.choices?.[0]?.delta?.content;
          if (token) {
            fullContent += token;
            setStreamingContent(fullContent);
            options.onToken?.(token);
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          const error = err instanceof Error ? err : new Error(String(err));
          setError(error);
          options.onError?.(error);
        }
      } finally {
        // Keep whatever arrived, including after stop()
        if (fullContent) {
          const assistantMessage: ChatMessage = { role: 'assistant', content: fullContent };
          setMessages((prev) => [...prev, assistantMessage]);
          options.onFinish?.(fullContent, usage);
        }
        abortRef.current = null;
        setStreamingContent('');
        setIsLoading(false);
        setIsStreaming(false);
      }
    },
    [client, isLoading, messages, options]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    setStreamingContent('');
    setError(null);
  }, []);

  return {
    messages,
    send,
    isLoading,
    isStreaming,
    streamingContent,
    error,
    stop,
    clear,
    setMessages,
  };
}
