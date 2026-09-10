// The heart: one concierge turn. The model reads the thread, decides which
// tools to call (or none), reads the results, iterates, and settles on a reply.
import { getDriver } from './llm.js';
import { systemPrompt } from './prompts.js';
import { toBubbles } from './shorten.js';
import { buildToolset } from '../shopify/tools.js';
import { getThread, history, appendMessage, getCollected } from '../store/db.js';
import { config } from '../config.js';
import { trace } from '../sim/trace.js';

const MAX_ROUNDS = 6; // enough for search → details → cart → link, with slack

export async function runAgentTurn(igsid) {
  const thread = getThread(igsid);
  const awaiting = getCollected(igsid, '_awaiting');
  // '' is a decision (no usable name), null is "never decided" — both mean the
  // agent addresses nobody; neither re-runs the resolver mid-conversation.
  const flow = {
    greetName: getCollected(igsid, 'greeting.name') || null,
    captured: getCollected(igsid, 'phone') || getCollected(igsid, 'email'),
    awaitingField: (awaiting === 'phone' || awaiting === 'email') && !getCollected(igsid, awaiting) ? awaiting : null,
  };
  const toolset = await buildToolset({ igsid, username: thread?.username });
  const messages = [
    { role: 'system', content: systemPrompt(thread, flow) },
    ...history(igsid),
  ];

  let final = null;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const msg = await getDriver().complete(messages, toolset.defs);
      if (!msg.tool_calls?.length) { final = msg.content; break; }
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        const result = await toolset.run(tc.function.name, tc.function.arguments);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }
  } catch (err) {
    trace('error', `llm turn failed: ${err.message}`);
  }

  // Degrade in-conversation, never silently: if the model errored out or spent
  // every round calling tools, the customer still hears back.
  final ||= "ugh, i'm glitching for a second — say that once more and i'll get you sorted";

  const bubbles = toBubbles(final);
  appendMessage(igsid, 'assistant', bubbles.join('\n'));
  return bubbles;
}
