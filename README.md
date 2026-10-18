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
  const { messages, send, isLoading, streamingContent } = useChat();

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

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test
```

## Contributing

Contributions are welcome! Please see our [Contributing Guidelines](https://github.com/archipelag-io/.github/blob/main/CONTRIBUTING.md) and [Code of Conduct](https://github.com/archipelag-io/.github/blob/main/CODE_OF_CONDUCT.md).

## License

MIT
