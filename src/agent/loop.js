// The heart: one concierge turn. The model reads the thread, decides which
// tools to call (or none), reads the results, iterates, and settles on a reply.
import { getDriver } from './llm.js';
import { systemPrompt } from './prompts.js';
import { toBubbles } from './shorten.js';
import { buildToolset } from '../shopify/tools.js';
import { getThread, history, appendMessage, getCollected } from '../store/db.js';
import { escalationFact, openEscalation, flagForHuman } from '../flows/escalation.js';
import { config } from '../config.js';
import { trace } from '../sim/trace.js';

const MAX_ROUNDS = 6; // enough for search → details → cart → link, with slack

// "i'll get someone from the team to confirm — they'll reply right here." The
// shapes a promise of a human takes, so the guard below can tell when one was
// made without the tool that makes it true.
const PROMISED_A_HUMAN =
  /\b(someone|somebody|a person|the team|my team|a teammate|a human|our team)\b[^.!?]{0,60}\b(will|can|to|'?ll)\b[^.!?]{0,40}\b(reply|reach out|get back|follow up|confirm|check|look|pick (this|it) up|be in touch|help)\b|\b(looping|bringing|pulling|getting) (in |someone|a person|the team)/i;

export async function runAgentTurn(igsid) {
  const thread = getThread(igsid);
  const awaiting = getCollected(igsid, '_awaiting');
  // '' is a decision (no usable name), null is "never decided" — both mean the
  // agent addresses nobody; neither re-runs the resolver mid-conversation.
  const flow = {
    greetName: getCollected(igsid, 'greeting.name') || null,
    captured: getCollected(igsid, 'phone') || getCollected(igsid, 'email'),
    awaitingField: (awaiting === 'phone' || awaiting === 'email') && !getCollected(igsid, awaiting) ? awaiting : null,
    // A question already waiting on a teammate: the model must not answer it
    // itself, must not raise a second flag for it, and must keep handling
    // everything else in the thread as normal.
    escalationFact: escalationFact(igsid),
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
  // The promise guard. A model that TELLS someone a teammate will get back to
  // them but never called escalate_to_human has made a promise nobody recorded:
  // no flag in the portal, no courtesy dm, nobody waiting. Rather than let the
  // customer hold that bag, the promise itself raises the flag — traced as the
  // guard, so the console shows who actually raised it.
  if (PROMISED_A_HUMAN.test(bubbles.join(' ')) && !openEscalation(igsid)) {
    const lastAsk = [...history(igsid, 8)].reverse().find((m) => m.role === 'user')?.content || '';
    trace('guard', `reply promised a human but escalate_to_human was never called — raising the flag anyway`);
    flagForHuman(igsid, { reason: 'agent promised a teammate would follow up', question: lastAsk });
  }
  appendMessage(igsid, 'assistant', bubbles.join('\n'));
  return bubbles;
}
