<p align="center">
  <a href="https://www.npmjs.com/package/@archipelag/sdk"><img src="https://img.shields.io/npm/v/@archipelag/sdk?color=blue" alt="npm"></a>
  <a href="https://github.com/archipelag-io/archipelagio-js/blob/main/LICENSE"><img src="https://img.shields.io/github/license/archipelag-io/archipelagio-js" alt="License"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.0+-blue" alt="TypeScript"></a>
</p>

# Archipelag.io JavaScript SDK

Official JavaScript/TypeScript SDK for [Archipelag.io](https://archipelag.io) distributed compute platform.

## Packages

- **[@archipelag/sdk](./packages/sdk)** - Core SDK for Node.js and browsers
- **[@archipelag/react](./packages/react)** - React hooks and components

## Quick Start

### Installation

```bash
# Core SDK
npm install @archipelag/sdk

# React hooks (optional)
npm install @archipelag/react
```

### Basic Usage

```typescript
import { Archipelag } from '@archipelag/sdk';

const client = new Archipelag({ apiKey: 'ak_xxx' });

// Chat
const result = await client.chat('Hello!');
console.log(result.content);

// Streaming
await client.chatStream('Tell me a story', {
  onToken: (token) => process.stdout.write(token),
  onDone: (usage) => console.log(`\n[${usage.totalTokens} tokens]`),
});

// Image generation
const image = await client.generateImage('a sunset over mountains');
console.log(`Generated ${image.width}x${image.height} image`);
```

### Chat Completions (OpenAI-compatible)

```typescript
const completion = await client.chatCompletion(
  [
    { role: 'system', content: 'Answer in one sentence.' },
    { role: 'user', content: 'What is an archipelago?' },
  ],
  { model: 'auto', temperature: 0.3 } // any OpenAI parameter
);
console.log(completion.choices[0].message.content);

for await (const chunk of client.chatCompletionStream(messages)) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

### Tool Calling and Agents

Describe a tool with a JSON schema and a `run` function. `runAgent` sends the
conversation, runs the tools the model asks for (concurrently), feeds the
results back, and returns the final answer.

```typescript
import type { Tool } from '@archipelag/sdk';

const getWeather: Tool = {
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  run: async ({ city }) => ({ city, temp: 4, sky: 'rain' }),
};

const result = await client.runAgent(
  [{ role: 'user', content: 'Should I bring an umbrella in Oslo?' }],
  [getWeather],
  { maxSteps: 6, onStep: (message) => console.log(message.tool_calls ?? message.content) }
);
console.log(result.content);   // final answer
console.log(result.messages);  // full conversation, including tool calls and results
```

Tool errors are sent to the model as the tool's result, so it can recover.

### React Usage

```tsx
import { ArchipelagProvider, useChat } from '@archipelag/react';

function App() {
  return (
    <ArchipelagProvider apiKey="ak_xxx">
      <ChatComponent />
    </ArchipelagProvider>
  );
}

function ChatComponent() {
  // The whole conversation is sent each turn; stop() cancels a streaming answer
  const { messages, send, stop, isLoading, streamingContent } = useChat();

  return (
    <div>
      {messages.map((msg, i) => (
        <div key={i}>
          <strong>{msg.role}:</strong> {msg.content}
        </div>
      ))}
      {isLoading && <div>Assistant: {streamingContent}</div>}
      <input
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !isLoading) {
            send(e.currentTarget.value);
            e.currentTarget.value = '';
          }
        }}
      />
    </div>
  );
}
```

## Development

This is a pnpm workspace.

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test
```

## Contributing

Contributions are welcome! Please see our [Contributing Guidelines](https://github.com/archipelag-io/.github/blob/main/CONTRIBUTING.md) and [Code of Conduct](https://github.com/archipelag-io/.github/blob/main/CODE_OF_CONDUCT.md).

## License

MIT
