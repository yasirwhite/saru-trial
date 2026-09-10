// One-off: existing threads recorded WHAT was commented ("instagram.comment" /
// "instagram.comment.post" memories) but not WHERE — the post permalink wasn't
// captured until 2026-09-10. This matches each stored caption against the
// account's own media list and fills in "instagram.comment.link".
//
//   node --env-file=.env scripts/backfill-comment-links.mjs
//
// Idempotent: reruns overwrite the same memory key with the same value.

import postgres from 'postgres';

const token = process.env.IG_ACCESS_TOKEN;
const graphBase = process.env.GRAPH_BASE || 'https://graph.instagram.com/v23.0';
const igId = process.env.IG_ID;
const dbUrl = process.env.DATABASE_URL;
if (!token || !igId || !dbUrl) {
  console.error('IG_ACCESS_TOKEN, IG_ID and DATABASE_URL are required (run with --env-file=.env)');
  process.exit(1);
}

const media = [];
let url = `${graphBase}/${igId}/media?fields=caption,permalink&limit=50&access_token=${token}`;
while (url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`media list failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const page = await res.json();
  media.push(...(page.data || []));
  url = page.paging?.next || null;
}
console.log(`account media: ${media.length} posts`);

const sql = postgres(dbUrl, { max: 1, prepare: false });
const rows = await sql`
  SELECT m.brand_id, m.customer_id, m.value AS caption
  FROM private.memories m
  WHERE m.key = 'instagram.comment.post'
    AND NOT EXISTS (
      SELECT 1 FROM private.memories l
      WHERE l.brand_id = m.brand_id AND l.customer_id = m.customer_id
        AND l.key = 'instagram.comment.link')`;
console.log(`captions missing a link: ${rows.length}`);

// The stored caption is truncated to 140 chars, so match on a prefix from
// either side; normalize whitespace, which Meta is loose about.
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
let filled = 0;
for (const row of rows) {
  const want = norm(row.caption).slice(0, 60);
  const hit = media.find((m) => {
    const have = norm(m.caption);
    return want && have && (have.startsWith(want) || want.startsWith(have.slice(0, 60)));
  });
  if (!hit?.permalink) {
    console.log(`  no media match for customer ${row.customer_id} ("${row.caption.slice(0, 50)}…")`);
    continue;
  }
  await sql`
    INSERT INTO private.memories (brand_id, customer_id, key, kind, value)
    VALUES (${row.brand_id}, ${row.customer_id}, 'instagram.comment.link', 'fact', ${hit.permalink})
    ON CONFLICT (brand_id, customer_id, key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  console.log(`  customer ${row.customer_id} → ${hit.permalink}`);
  filled += 1;
}
console.log(`done — ${filled} link(s) written`);
await sql.end();
