  // Append as the LAST element of `tools` in content/tools-registry/registry.ts (after the `agentmail` entry).
  {
    slug: 'breakwire',
    name: 'Breakwire',
    description:
      'Let agents explain API and SDK errors. Look up an error message and get the source-linked breaking change, deprecation or security advisory behind it, with the fix, affected versions and deadline. Also lists upcoming deprecation deadlines per service. No API key required.',
    packageName: 'breakwire',
    tags: ['debugging', 'errors', 'deprecations', 'api'],
    installCommand: {
      pnpm: 'pnpm add breakwire',
      npm: 'npm install breakwire',
      yarn: 'yarn add breakwire',
      bun: 'bun add breakwire',
    },
    codeExample: `import { generateText, isStepCount } from 'ai';
import { breakwireTools } from 'breakwire/ai-sdk';

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-5.5',
  tools: breakwireTools(),
  stopWhen: isStepCount(5),
  prompt:
    'My Anthropic call fails with: tool_choice: type "tool" and "any" are not supported for this model. ' +
    'What changed and how do I fix it?',
});

console.log(text);`,
    docsUrl: 'https://github.com/breakwire-org/breakwire/tree/main/packages/js#vercel-ai-sdk-tools',
    websiteUrl: 'https://breakwire.org',
    npmUrl: 'https://www.npmjs.com/package/breakwire',
  },
