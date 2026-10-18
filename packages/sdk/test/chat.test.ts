import { afterEach, describe, expect, it, vi } from 'vitest';
import { Archipelag, JobFailedError, ValidationError, type Tool } from '../src';

const URL = 'https://app.archipelag.io/api/v1/chat/completions';

function completion(message: Record<string, unknown>, finish_reason = 'stop', total = 15) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'auto',
    choices: [{ index: 0, message, finish_reason }],
    usage: { prompt_tokens: total - 5, completion_tokens: 5, total_tokens: total },
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** An SSE body delivered in awkward pieces, to test reassembly */
function sseResponse(events: unknown[], pieceSize = 7): Response {
  const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += pieceSize) controller.enqueue(bytes.slice(i, i + pieceSize));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function mockFetch(...responses: Response[]) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const weather: Tool = {
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  run: async ({ city }) => ({ city, temp: 4 }),
};

afterEach(() => vi.unstubAllGlobals());

describe('chatCompletion', () => {
  it('posts OpenAI parameters and tools to the working API host', async () => {
    const calls = mockFetch(json(completion({ role: 'assistant', content: 'Hi' })));
    const client = new Archipelag({ apiKey: 'ak_test' });

    const result = await client.chatCompletion([{ role: 'user', content: 'Hi' }], {
      tools: [weather],
      temperature: 0,
      max_tokens: undefined,
    });

    expect(result.choices[0].message.content).toBe('Hi');
    expect(calls[0].url).toBe(URL);
    expect(calls[0].body).toEqual({
      model: 'auto',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0,
      tools: [{ type: 'function', function: { name: 'get_weather', description: weather.description, parameters: weather.parameters } }],
    });
  });

  it('turns 400s into ValidationError', async () => {
    mockFetch(json({ error: { message: 'n > 1 is not supported' } }, 400));
    const client = new Archipelag({ apiKey: 'ak_test' });
    await expect(client.chatCompletion([{ role: 'user', content: 'Hi' }], { n: 2 })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('chatCompletionStream', () => {
  it('reassembles events split across network chunks', async () => {
    const calls = mockFetch(
      sseResponse([
        { object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hello, ' }, finish_reason: null }] },
        { object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'world' }, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    );
    const client = new Archipelag({ apiKey: 'ak_test' });

    let text = '';
    for await (const chunk of client.chatCompletionStream([{ role: 'user', content: 'Hi' }])) {
      text += chunk.choices[0].delta.content || '';
    }
    expect(text).toBe('Hello, world');
    expect(calls[0].headers.Accept).toBe('text/event-stream, application/json');
  });

  it('throws when the Island fails mid-stream', async () => {
    mockFetch(sseResponse([{ error: { message: 'Job failed: Island disconnected' } }, '[DONE]']));
    const client = new Archipelag({ apiKey: 'ak_test' });

    const run = async () => {
      for await (const _ of client.chatCompletionStream([{ role: 'user', content: 'Hi' }])) {
        // drain
      }
    };
    await expect(run()).rejects.toBeInstanceOf(JobFailedError);
  });
});

describe('runAgent', () => {
  it('runs tools and returns the final answer with the full conversation', async () => {
    const calls = mockFetch(
      json(completion({ role: 'assistant', content: '', tool_calls: [toolCall('c1', 'get_weather', { city: 'Oslo' })] }, 'tool_calls')),
      json(completion({ role: 'assistant', content: '4°C in Oslo.' }))
    );
    const client = new Archipelag({ apiKey: 'ak_test' });
    const steps: unknown[] = [];

    const result = await client.runAgent([{ role: 'user', content: 'Weather in Oslo?' }], [weather], {
      onStep: (m) => steps.push(m),
    });

    expect(result.content).toBe('4°C in Oslo.');
    expect(result.steps).toBe(1);
    expect(result.usage.total_tokens).toBe(30);
    expect(steps).toHaveLength(2);
    expect(calls[1].body.messages).toEqual([
      { role: 'user', content: 'Weather in Oslo?' },
      { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'get_weather', { city: 'Oslo' })] },
      { role: 'tool', tool_call_id: 'c1', name: 'get_weather', content: JSON.stringify({ city: 'Oslo', temp: 4 }) },
    ]);
  });

  it('sends tool errors and unknown tools back to the model', async () => {
    const failing: Tool = { name: 'explode', run: () => { throw new Error('boom'); } };
    const calls = mockFetch(
      json(completion({ role: 'assistant', content: '', tool_calls: [toolCall('a', 'explode', {}), toolCall('b', 'nope', {})] }, 'tool_calls')),
      json(completion({ role: 'assistant', content: 'Sorry.' }))
    );
    const client = new Archipelag({ apiKey: 'ak_test' });

    await client.runAgent([{ role: 'user', content: 'go' }], [failing]);

    const toolMessages = (calls[1].body.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.content)).toEqual(['Error: boom', "Error: unknown tool 'nope'"]);
  });

  it('gives up after maxSteps', async () => {
    const looping = () => json(completion({ role: 'assistant', content: '', tool_calls: [toolCall('c', 'get_weather', { city: 'X' })] }, 'tool_calls'));
    mockFetch(looping(), looping(), looping());
    const client = new Archipelag({ apiKey: 'ak_test' });

    await expect(client.runAgent([{ role: 'user', content: 'loop' }], [weather], { maxSteps: 2 })).rejects.toThrow('after 2 rounds');
  });
});

describe('chat and chatStream', () => {
  it('use the chat API instead of the removed llm-chat Cargo', async () => {
    const calls = mockFetch(
      json(completion({ role: 'assistant', content: 'Hello!' })),
      sseResponse([
        { object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hey' }, finish_reason: null }] },
        { object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
        '[DONE]',
      ])
    );
    const client = new Archipelag({ apiKey: 'ak_test' });

    const result = await client.chat('Hi', { systemPrompt: 'Be brief.' });
    expect(result.content).toBe('Hello!');
    expect(result.usage.totalTokens).toBe(15);
    expect(calls[0].body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ]);

    const tokens: string[] = [];
    let total = 0;
    await client.chatStream('Hi', { onToken: (t) => tokens.push(t), onDone: (u) => (total = u.totalTokens || 0) });
    expect(tokens).toEqual(['Hey']);
    expect(total).toBe(4);
    expect(calls[1].body.stream).toBe(true);
  });
});
