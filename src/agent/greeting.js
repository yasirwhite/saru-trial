// How much of an instagram profile name is actually a name you can say out loud?
// Instagram names are titles, jokes, brands and meme handles as often as they're
// names, and "hey mr white" / "hey cloud mask" is the loudest bot tell we ship.
// Same shape as intent.js: cheap deterministic heuristics carry the obvious
// cases (and the whole mock/smoke path), the LLM is asked only about the
// ambiguous middle — but the fail direction is the opposite of intent's. A
// missing greeting is invisible; a wrong one is a tell. So this gate fails
// CLOSED: any doubt, any LLM error, no name.
import { config } from '../config.js';
import { trace } from '../sim/trace.js';

// Address titles. A title glued to a name is a self-chosen moniker ("Mr White",
// "Dr. Glow") — a thing people answer to whole. It is never a first name on its
// own, and its second half is never a first name either.
const TITLES = new Set([
  'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'miss', 'mx', 'mx.', 'dr', 'dr.', 'doctor',
  'sir', 'madam', 'madame', 'lord', 'lady', 'prof', 'prof.', 'professor', 'rev', 'rev.',
  'capt', 'capt.', 'captain', 'chef', 'coach', 'sensei', 'master', 'st', 'st.', 'saint',
]);

// Hype wrappers. These decorate a name rather than form an address ("The Real
// Tarun" is Tarun with a boast on the front) — strip them and judge what's left.
const HYPE = new Set([
  'the', 'real', 'official', 'its', 'itz', "it's", 'im', "i'm", 'just', 'only',
  'king', 'queen', 'lil', 'big', 'young', 'yours', 'ur', 'ya',
]);

// Words that show up in handles, brands and fandom names — never given names.
const JUNK = new Set([
  'fan', 'fans', 'stan', 'stans', 'lover', 'lovers', 'addict', 'obsessed', 'era',
  'shop', 'store', 'brand', 'co', 'inc', 'hq', 'studio', 'club', 'team', 'world',
  'skin', 'skincare', 'care', 'beauty', 'glow', 'glowing', 'mask', 'masks', 'serum',
  'hair', 'nails', 'lash', 'lashes', 'makeup', 'derm', 'saru',
  'girl', 'girls', 'boy', 'boys', 'guy', 'guys', 'babe', 'baby', 'bae', 'bestie',
  'mom', 'mum', 'dad', 'mama', 'wife', 'husband', 'life', 'daily', 'diary', 'blog',
  'fit', 'fitness', 'gym', 'runs', 'run', 'running', 'lifts', 'eats', 'travels',
  'vibe', 'vibes', 'aesthetic', 'core', 'energy', 'moods', 'mood',
  'xo', 'xoxo', 'xx', 'lol', 'lmao', 'bruh', 'yessir', 'yes', 'nah', 'fr',
  'ceo', 'admin', 'anon', 'user', 'insta', 'ig', 'dm', 'dms', 'page', 'media',
  'sale', 'sales', 'deals', 'promo', 'shopper', 'bot', 'main', 'alt', 'fake', 'not',
  'and', 'of', 'by', 'my', 'me', 'we', 'us', 'your', 'you', 'here', 'now', 'that', 'this',
]);

const NONE = Object.freeze({ greetName: null, basis: 'none' });
const AMBIGUOUS = Object.freeze({ greetName: null, basis: 'ambiguous' });

// Emoji, sparkles, hearts, flags — decoration, never signal.
const DECOR = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu;

export function cleanName(name) {
  return String(name ?? '')
    .normalize('NFKC')
    .replace(DECOR, ' ')
    // keep digits and underscores: they're evidence (handle-shaped), not noise
    .replace(/[^\p{L}\p{N}\s'’._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Looks like a word a person could be called (no digits, no decoration).
const wordShaped = (t) => /^[\p{L}][\p{L}'’.-]{0,19}$/u.test(t);

// Looks like a given name specifically: word-shaped, sane length, and not one of
// the words we know brands and fandom accounts are built from.
function plausibleGiven(token) {
  const t = String(token || '');
  if (!/^[\p{L}][\p{L}'’-]{1,14}$/u.test(t)) return false;
  const low = t.toLowerCase();
  return !JUNK.has(low) && !TITLES.has(low) && !HYPE.has(low);
}

// The profile-name tier. Returns a decision, AMBIGUOUS (hand to the LLM), or
// NONE (this name gives us nothing — the caller may still try the handle).
function nameDecision(cleaned) {
  if (!cleaned) return NONE;
  // handle-shaped or decorated: "xX_dark_Xx", "glow.by.mia", "maya2001"
  if (/[\p{N}_]/u.test(cleaned)) return NONE;
  if (/\p{L}\.\p{L}/u.test(cleaned)) return NONE;

  let toks = cleaned.split(' ');
  while (toks.length > 1 && HYPE.has(toks[0].toLowerCase())) toks = toks.slice(1);
  const head = toks[0].toLowerCase();

  if (TITLES.has(head)) {
    const rest = toks.slice(1);
    // title + one word = a moniker someone answers to WHOLE ("mr white").
    // Greeting it is fine; dissecting it ("hey mr", "hey white") or formalizing
    // it ("Hello Mr. White") is what reads wrong.
    if (rest.length === 1 && wordShaped(rest[0])) {
      return { greetName: toks.join(' ').toLowerCase(), basis: 'moniker' };
    }
    // title + two words is genuinely unclear: "Dr Amar Lathia" (a name behind a
    // title) vs "Mr Cloud Mask" (a longer persona). Let the model look.
    if (rest.length === 2 && rest.every(wordShaped)) return AMBIGUOUS;
    return NONE;
  }
  if (HYPE.has(head)) return NONE; // nothing but hype left ("The Official")

  if (toks.length >= 3) {
    // three-plus words is a phrase until proven otherwise; one junk word settles it
    if (toks.some((t) => !wordShaped(t) || JUNK.has(t.toLowerCase()))) return NONE;
    return AMBIGUOUS; // "Ana Maria Souza" vs "Sun Kissed Bella"
  }

  // one or two words: the first is the given name if it can be one at all
  if (plausibleGiven(toks[0])) return { greetName: toks[0].toLowerCase(), basis: 'first-name' };
  // "Glow Mia" — the first word is brand noise but the second could be the person
  if (toks.length === 2 && plausibleGiven(toks[1])) return AMBIGUOUS;
  return NONE;
}

// The handle tier, used only when the profile name gave us nothing. ONLY the
// first segment counts: "amar.lathia" is a person, "yessir.white" is a phrase
// with a surname stapled on, and greeting someone "white" is the same failure
// as greeting them "mr".
function handleDecision(username) {
  const u = String(username || '').toLowerCase().replace(/^@/, '');
  const seg = u.split(/[^a-z’']+/).filter(Boolean)[0];
  if (!seg || seg.length < 3 || !plausibleGiven(seg)) return NONE;
  return { greetName: seg, basis: 'handle' };
}

// Sync tier — deterministic, no network, and the whole story for the obvious
// cases. basis 'ambiguous' means "ask the model".
export function heuristicGreeting({ name, username } = {}) {
  const d = nameDecision(cleanName(name));
  if (d.basis !== 'none') return d;
  return handleDecision(username);
}

async function classifyGreeting(cleaned, username) {
  // No live model (mock driver, no key) → no guess. Fail closed.
  if (config.llmDriver !== 'openai') return NONE;
  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI();
    const res = await client.chat.completions.create({
      model: config.openaiModel,
      max_tokens: 12,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `An Instagram profile name, and the handle it belongs to. Decide how a friendly brand rep should address this person in a DM.\n\nprofile name: "${cleaned.slice(0, 80)}"\nhandle: @${String(username || '').slice(0, 40)}\n\nanswer with exactly one of:\nfirst:<word> — the profile name contains a real given name; <word> is that name\nmoniker — the whole profile name is a persona someone would answer to as a whole (a title plus a name, a stage name)\nnone — it's a brand, a fandom name, a joke, or a phrase, and no part of it is safe to call them`,
      }],
    });
    const raw = (res.choices[0]?.message?.content || '').trim().toLowerCase();
    const first = /^first:\s*([^\s,.]+)/.exec(raw);
    if (first) {
      const tok = first[1].replace(/["'“”]/g, '');
      const inName = cleaned.toLowerCase().split(' ').includes(tok);
      // never let free text become a greeting: it has to be a word actually in
      // their name, and it has to look like a name
      if (inName && plausibleGiven(tok)) return { greetName: tok, basis: 'first-name' };
      return NONE;
    }
    if (/^moniker/.test(raw)) {
      const toks = cleaned.split(' ');
      if (toks.length <= 3 && toks.every(wordShaped)) {
        return { greetName: cleaned.toLowerCase(), basis: 'moniker' };
      }
    }
    return NONE;
  } catch (err) {
    trace('error', `greeting classify failed (going nameless rather than wrong): ${err.message}`);
    return NONE;
  }
}

// The decision, made once per person (the caller persists it).
//   { greetName: 'amar',    basis: 'first-name' }  greet by given name
//   { greetName: 'mr white', basis: 'moniker' }    greet by the whole moniker
//   { greetName: 'amar',    basis: 'handle' }      the handle carried a name
//   { greetName: null,      basis: 'none' }        greet with no name at all
export async function resolveGreeting({ name, username } = {}) {
  const cleaned = cleanName(name);
  const d = nameDecision(cleaned);
  if (d.basis !== 'none' && d.basis !== 'ambiguous') return d;
  if (d.basis === 'ambiguous') {
    const llm = await classifyGreeting(cleaned, username);
    if (llm.greetName) return llm;
  }
  return handleDecision(username);
}
