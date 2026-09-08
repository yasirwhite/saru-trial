// A tiny event log every part of the system writes to. It feeds the playground's
// live trace pane (via SSE) and the console — one place to watch webhooks get
// verified, tools fire, and messages go out. Not a durable log; a demo lens.
const listeners = new Set();
const ring = [];

export function trace(kind, text) {
  const ev = { at: Date.now(), kind, text };
  ring.push(ev);
  if (ring.length > 500) ring.shift();
  console.log(`[${kind}] ${text}`);
  for (const fn of listeners) fn(ev);
}

export const onTrace = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const recentTraces = () => [...ring];
