// The texting shape: the model writes each bubble on its own line and we honor
// those breaks — split-as-rhetoric (react → substance → move), not
// split-as-overflow.
const BUBBLE_CAP = 300; // per-bubble hard cap; Instagram's real limit is 1000
const MAX_BUBBLES = 3;

function stripMarkdown(text) {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$2') // md links → bare url
    .replace(/[*_`#]+/g, '')
    .replace(/^\s*[-•]\s*/gm, '')
    .trim();
}

// Fallback for a model that ignored the one-line-per-bubble contract.
function splitLong(text) {
  const cut = (() => {
    const sentence = Math.max(
      text.lastIndexOf('. ', BUBBLE_CAP),
      text.lastIndexOf('! ', BUBBLE_CAP),
      text.lastIndexOf('? ', BUBBLE_CAP),
    );
    if (sentence > 40) return sentence + 1;
    const space = text.lastIndexOf(' ', BUBBLE_CAP);
    return space > 40 ? space : BUBBLE_CAP;
  })();
  return [text.slice(0, cut).trim(), text.slice(cut).trim()];
}

export function toBubbles(text) {
  const clean = stripMarkdown(text || '');
  if (!clean) return [];
  let parts = clean.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1 && parts[0].length > BUBBLE_CAP) parts = splitLong(parts[0]);
  // more lines than the cap: keep the first two, merge the rest into bubble 3
  if (parts.length > MAX_BUBBLES) {
    parts = [...parts.slice(0, MAX_BUBBLES - 1), parts.slice(MAX_BUBBLES - 1).join(' ')];
  }
  return parts.map((p) => (p.length > BUBBLE_CAP ? p.slice(0, BUBBLE_CAP) : p));
}
