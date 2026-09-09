// Comment intent gate: only comments showing shopping interest earn the one
// private reply. Heuristic first (free, deterministic, drives the mock/smoke
// path); the LLM confirms borderline calls when the openai driver is active.
import { config } from '../config.js';
import { trace } from '../sim/trace.js';

const POSITIVE = /\bneed|\bwant|cop\b|buy|purchase|price|cost|how much|size|sizing|fit\b|ship|deliver|restock|drop\b|link\b|where .{0,12}(get|buy)|obsessed|love th|in my life|take my money|cart|order|available|in stock|stock\?|colou?rs?\b|when .{0,12}(back|available)|🔥|😍|🥵|😩|fr\b|must have/i;
const NOISE = /^(test|another test|testing|first|nice|cool|lol|ok|okay|wow|hi|hello|hey)[\s!.😂🙂]*$/i;

export function heuristicIntent(text) {
  const t = (text || '').trim();
  if (!t || NOISE.test(t)) return false;
  return POSITIVE.test(t);
}

export async function hasPurchaseIntent(text) {
  if (!config.commentIntentFilter) return true;
  const heuristic = heuristicIntent(text);
  if (config.llmDriver !== 'openai') return heuristic;
  // The model gets the final say — catches intent the regex can't ("i'd wear
  // this every single day") and rejects flattery with no shopping signal.
  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI();
    const res = await client.chat.completions.create({
      model: config.openaiModel,
      max_tokens: 3,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `An Instagram user commented on a brand's product post. Does the comment show ANY shopping interest — wanting the product, asking about price, size, shipping, availability, or admiring it like a potential buyer? Comments that are tests, greetings, spam, or unrelated get "no".\n\ncomment: "${(text || '').slice(0, 200)}"\n\nanswer with exactly one word: yes or no`,
      }],
    });
    return /yes/i.test(res.choices[0]?.message?.content || '');
  } catch (err) {
    trace('error', `intent classify failed (falling back to heuristic): ${err.message}`);
    return heuristic;
  }
}
