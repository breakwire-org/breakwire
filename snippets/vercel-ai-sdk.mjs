// Vercel AI SDK (ai@7): (1) wrap generateText so a failed call carries its explanation,
// (2) optionally give the model Breakwire tools so it can look errors up itself.
import { generateText, isStepCount } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { withBreakwire } from 'breakwire';
import { breakwireTools } from 'breakwire/ai-sdk';

const anthropic = createAnthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });

// --- the drop-in part ---------------------------------------------------------
const generate = withBreakwire(generateText, { service: 'anthropic-api', sdk: 'ai-sdk' });
// ------------------------------------------------------------------------------

export async function main() {
  try {
    await generate({
      model: anthropic('claude-opus-5-5'),
      prompt: 'Weather in Paris?',
      tools: { ...breakwireTools() },          // (2) optional: the model can call breakwire_lookup_error itself
      toolChoice: 'required',
      stopWhen: isStepCount(3),
      maxRetries: 0,
    });
  } catch (err) {
    // err is the AI SDK APICallError (or RetryError); Breakwire adds err.breakwire
    console.log(err.statusCode, err.breakwire?.id, err.breakwire?.confidence, '->', err.breakwire?.fix);
    return err.breakwire;
  }
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
