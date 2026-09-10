// The LLM behind one interface so the loop is provider-agnostic and testable:
import OpenAI from 'openai';
import { config } from '../config.js';
import { openerPrompt } from './prompts.js';
import { trace } from '../sim/trace.js';

// --- openai ------------------------------------------------------------
let client;
const openaiDriver = {
  async complete(messages, tools) {
    client ||= new OpenAI();
    const res = await client.chat.completions.create({
      model: config.openaiModel,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      max_tokens: 400, // short replies are the product; this is a backstop, not the mechanism
    });
    return res.choices[0].message;
  },
  async composeOpener(args) {
    // when the post's photo is available, the model SEES it — openers that
    // react to the actual picture, not just caption text.
    if (args.postImageUrl) {
      try {
        const content = [{ type: 'text', text: openerPrompt(args) },
                         { type: 'image_url', image_url: { url: args.postImageUrl } }];
        const msg = await this.complete([{ role: 'user', content }], []);
        return (msg.content || '').trim();
      } catch (err) {
        trace('error', `vision opener failed (${err.message}) — retrying caption-only`);
      }
    }
    const msg = await this.complete([{ role: 'user', content: openerPrompt({ ...args, postImageUrl: null }) }], []);
    return (msg.content || '').trim();
  },
};

// --- mock --------------------------------------------------------------
let mockCallId = 0;
const call = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: `call_${++mockCallId}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const say = (content) => ({ role: 'assistant', content });

// Walk a search_catalog result for a product/variant to act on.
const pickVariant = (raw) => {
  try {
    const data = JSON.parse(raw);
    let fallback = null;
    for (const p of data.products || [])
      for (const v of p.variants || []) {
        if (v.availability?.available) return { id: v.id, title: p.title };
        fallback ||= { id: v.id, title: p.title };
      }
    return fallback;
  } catch { return null; /* not a catalog payload */ }
};

const mockDriver = {
  async complete(messages, tools) {
    const names = tools.map((t) => t.function.name);
    const find = (frag) => names.find((n) => n.includes(frag));
    const lastUserIdx = messages.findLastIndex((m) => m.role === 'user');
    const lastUser = (messages[lastUserIdx]?.content || '').toLowerCase();
    const thisTurn = messages.slice(lastUserIdx + 1);
    const toolResults = thisTurn.filter((m) => m.role === 'tool');
    const calledThisTurn = (frag) =>
      thisTurn.some((m) => m.tool_calls?.some((tc) => tc.function.name.includes(frag)));

    // Round 2+: a tool already answered — chain to the next tool or reply.
    if (toolResults.length) {
      const text = toolResults.map((m) => m.content).join('\n');
      // real cart checkout urls have a /cart/c/<id> path.
      const checkout = text.match(/https?:\/\/[^\s"'\\]*\/cart\/c\/[^\s"'\\]*/i);
      if (checkout) return say(`cart's ready — ${checkout[0]}`);
      const wantsCart = /cart|buy|checkout|order/.test(lastUser);
      const pick = toolResults.map((m) => pickVariant(m.content)).find(Boolean);
      if (wantsCart && pick && find('update_cart') && !calledThisTurn('update_cart')) {
        return call(find('update_cart'), { add_items: [{ product_variant_id: pick.id, quantity: 1 }] });
      }
      const code = text.match(/"code"\s*:\s*"([^"]+)".*?"percent"\s*:\s*(\d+)/s);
      if (code) return say(`made you a code — ${code[1]}, ${code[2]}% off. it's good for a week, just enter it at checkout`);
      if (/error:/i.test(text)) return say("hmm, that lookup hiccuped on me — mind trying once more in a sec?");
      if (pick) return say(`the ${pick.title.toLowerCase()} is the one i'd grab — it's in stock. want me to put it in a cart for you?`);
      return say('here\'s what i found — short version: ' + text.replace(/\s+/g, ' ').slice(0, 180));
    }

    // Gated thread, first reply after the engagement opener: help, then make
    // the offer — mirrors the openai driver's gate rules deterministically.
    const gateMatch = /unlocks ONLY when they drop their (phone number|email)/.exec(messages[0]?.content || '');
    if (gateMatch) {
      const f = gateMatch[1] === 'email' ? 'email' : 'number';
      return say(`good q — it runs true to size. btw drop your ${f} here and i'll send back 20% off`);
    }

    // Round 1: pick a tool from the user's intent. A cart ask starts with a
    // catalog search (we need a variant id) and chains to update_cart above.
    if (/discount|code|deal/.test(lastUser) && find('issue_discount')) return call(find('issue_discount'), {});
    if (/cart|buy|checkout|order/.test(lastUser) && find('catalog')) {
      // resolve "it" the way a real model would: from the thread's last ask
      const prevUser = messages.slice(0, lastUserIdx).filter((m) => m.role === 'user').pop();
      return call(find('catalog'), { query: prevUser?.content || 'best seller' });
    }
    if (/polic|return|refund|ship/.test(lastUser) && find('polic')) return call(find('polic'), { query: lastUser });
    if (/recommend|best|gift|looking|hoodie|shorts|leggings|colorway/.test(lastUser) && find('catalog')) return call(find('catalog'), { query: lastUser });
    return say('hey! what can i help you find today?');
  },
  // Deterministic but grounded — built from the actually-fetched facts, so
  // smoke tests can assert personalization without an API key.
  async composeOpener({ commentText, discount, gate, greeting }) {
    // Address exactly what greeting.js resolved — never the raw profile name.
    // No usable name means a nameless opener, not a handle fallback.
    const who = greeting?.greetName ? `hey ${greeting.greetName}!` : 'hey!';
    if (gate && !discount) {
      // Engagement-only opener: no offer, no ask — the promo comes later in the dm.
      return `${who} ai intern here 😅 saw your comment ("${(commentText || '').slice(0, 60)}") — that one's been moving fast fr. what's the occasion?`;
    }
    const codeLine = discount ? ` made you a code — ${discount.code}, ${discount.percent}% off this week.` : '';
    return `${who} ai intern here 😅 saw your comment ("${(commentText || '').slice(0, 60)}") — love that.${codeLine} what are you shopping for today?`;
  },
};

export const getDriver = () => (config.llmDriver === 'openai' ? openaiDriver : mockDriver);
