// The LLM behind one interface so the loop is provider-agnostic and testable:
import OpenAI from 'openai';
import { config } from '../config.js';
import { openerPrompt, continuationPrompt, shipmentDmPrompt } from './prompts.js';
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
  // Repeat-comment acknowledgment — caption-only, one fast call.
  async composeContinuation(args) {
    const msg = await this.complete([{ role: 'user', content: continuationPrompt(args) }], []);
    return (msg.content || '').trim();
  },
  // The unprompted shipment milestone DM.
  async composeShipmentDm(args) {
    const msg = await this.complete([{ role: 'user', content: shipmentDmPrompt(args) }], []);
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

// What an order question looks like, in the four shapes customers actually
// send. All of them route to the SAME tool — that's the point of one rich
// order_status — and the answer branches below read the same text again to
// decide which part of the result to quote.
const ASKS_SHIPMENT = /where.{0,12}(my |the )?(order|package|parcel)|track(ing)?\b|shipped yet|has it shipped|delivery status|when.{0,20}(arrive|get here|delivered)/;
const ASKS_ADDRESS = /(address|shipping to).{0,24}(on file|do you have|have for me|you have|i have)|what.{0,12}address|address.{0,8}(for|on).{0,12}(my|that|this|order)|where.{0,12}(is it|are you) (ship|send)/;
const ASKS_CODE = /did i (use|apply|have).{0,20}(code|qr|discount)|(qr|discount|promo)\s?code.{0,28}(use|used|applied|on that|in that|on my|on this)|code.{0,12}(on|in) (that|this|my) (order|purchase)/;
const ASKS_ITEMS = /what did i (order|buy|get)|what.{0,10}(was|is|did i have) in (my|that|the) order|items in (my|that|the) order/;
const isOrderQuestion = (t) => ASKS_SHIPMENT.test(t) || ASKS_ADDRESS.test(t) || ASKS_CODE.test(t) || ASKS_ITEMS.test(t);
// Asking for a person. Deliberately narrow — a mock that escalated on the word
// "help" would never exercise anything else.
const WANTS_HUMAN = /\b(real|actual) (person|human)\b|\bspeak (to|with) (a|an|someone)\b|\btalk to (a|an|someone)\b|\bhuman\b|\bmanager\b|\bsomeone from the team\b/;

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
      // A raised escalation flag ends the turn in ONE message, by construction:
      // no offer, no argument, no second run at the question.
      if (/"flagged"\s*:\s*true/.test(text)) {
        return say('looping in the team on this one — someone will pick it up right here');
      }
      // order_status is self-describing JSON — answer straight from it, and
      // never pretend to an order the tool says isn't linked.
      const order = toolResults
        .map((m) => { try { const d = JSON.parse(m.content); return d && 'linked' in d ? d : null; } catch { return null; } })
        .find(Boolean);
      if (order) {
        if (!order.linked) return say("i don't see an order tied to this chat yet — what email did you use at checkout?");
        const o = order.order || {};
        // The address, the codes and the items come from the SAME result — the
        // mock answers each question from the field that answers it, and from
        // nothing else (an absent field is said out loud, never filled in).
        if (ASKS_ADDRESS.test(lastUser)) {
          const a = o.shipping_address;
          if (!a || !(a.address1 || a.city)) return say(`i can't see a shipping address on ${o.name}`);
          const street = [a.name, a.address1, a.address2].filter(Boolean).join(', ');
          const region = [a.city, a.province, a.zip].filter(Boolean).join(' ');
          return say(`${o.name} ships to ${street}`.trim() + (region ? `\n${region}` : ''));
        }
        if (ASKS_CODE.test(lastUser)) {
          const codes = o.discount_codes;
          if (codes == null) return say(`i can't see the codes on ${o.name} right now`);
          if (!codes.length) return say(`no code on ${o.name} — it went through at full price`);
          return say(`yep — ${codes.join(', ')} was applied on ${o.name}`);
        }
        if (ASKS_ITEMS.test(lastUser)) {
          const items = o.line_items || [];
          if (!items.length) return say(`i can't see the items on ${o.name} right now`);
          return say(`${o.name}: ${items.map((i) => `${i.quantity}x ${String(i.title).toLowerCase()}`).join(', ')}`);
        }
        if (!order.shipment) return say(`${o.name} is paid and being packed — no tracking scan yet`);
        const sh = order.shipment;
        const where = sh.latest_scan?.city ? ` — last scan ${sh.latest_scan.city.toLowerCase()}` : '';
        const eta = sh.estimated_delivery ? `, eta ${sh.estimated_delivery}` : '';
        return say(`${o.name} is ${String(sh.status).replace(/_/g, ' ')}${where}${eta}\n${sh.tracking_url || ''}`.trim());
      }
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
    // Asking for a human goes FIRST of all — "i want a real person about my
    // broken order" is a complaint, not a shopping question, and every branch
    // below would happily read it as one.
    if (WANTS_HUMAN.test(lastUser) && find('escalate_to_human')) {
      return call(find('escalate_to_human'), {
        question: String(messages[lastUserIdx]?.content || '').slice(0, 200),
        reason: 'customer asked for a person',
      });
    }
    // Order questions next: "where's my order", "has it shipped", "did i use a
    // code" and "what address do you have" all contain words the cart, discount
    // and policy branches below would otherwise grab.
    if (isOrderQuestion(lastUser) && find('order_status')) return call(find('order_status'), {});
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
  async composeContinuation({ greetName, commentText }) {
    const who = greetName ? `${greetName} ` : '';
    return `saw your comment ${who}("${(commentText || '').slice(0, 40)}") — glad it's still hitting.`;
  },
  // Deterministic milestone DM: built only from facts that were actually
  // scanned, and structurally incapable of carrying an offer.
  async composeShipmentDm({ milestone, orderName, latest, eta }) {
    const where = latest?.city ? ` — last scan ${String(latest.city).toLowerCase()}` : '';
    if (milestone === 'out_for_delivery') {
      return `${orderName} is out for delivery today${where}. keep an eye on the door`;
    }
    if (milestone === 'delivered') {
      return `${orderName} just got delivered${where}. hope it's everything you wanted`;
    }
    return `${orderName} is on its way${where}${eta ? `, should land ${eta}` : ''}`;
  },
};

export const getDriver = () => (config.llmDriver === 'openai' ? openaiDriver : mockDriver);
