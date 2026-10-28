// Anthropic TypeScript SDK: on an API error, look it up and attach the explanation.
import Anthropic from '@anthropic-ai/sdk';
import { withBreakwire } from 'breakwire';

const anthropic = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL, maxRetries: 0 });

// --- the drop-in part ---------------------------------------------------------
const createMessage = withBreakwire((params) => anthropic.messages.create(params), {
  service: 'anthropic-api', sdk: 'anthropic-typescript', version: Anthropic.VERSION ?? undefined,
});
// ------------------------------------------------------------------------------

export async function main() {
  try {
    await createMessage({
      model: 'claude-opus-5-5', max_tokens: 256,
      tool_choice: { type: 'any' },
      tools: [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: 'Weather in Paris?' }],
    });
  } catch (err) {
    // err is the original Anthropic.BadRequestError; Breakwire adds err.breakwire
    console.log(err.status, err.breakwire?.id, err.breakwire?.confidence, '->', err.breakwire?.fix);
    return err.breakwire;
  }
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
