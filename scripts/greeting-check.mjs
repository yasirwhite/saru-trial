// Unit check for the greeting resolver's heuristic tier. Plain node, no server,
// no database, no API key: every fixture below MUST be decided deterministically
// (basis never 'ambiguous'), because these are the shapes real instagram names
// actually take and a live LLM call is not allowed to be in that path.
//
//   node scripts/greeting-check.mjs
import { resolveGreeting, heuristicGreeting } from '../src/agent/greeting.js';

const CASES = [
  // profile name                username        greetName      basis
  ['Amar Lathia',                null,           'amar',        'first-name'],
  ['Mr White',                   'mr.white',     'mr white',    'moniker'],
  ['Dr. Glow',                   null,           'dr. glow',    'moniker'],
  ['cloud mask stan',            null,           null,          'none'],
  ['MAYA',                       null,           'maya',        'first-name'],
  ['maya runs',                  null,           'maya',        'first-name'],
  ['xX_dark_Xx',                 null,           null,          'none'],
  ['',                           null,           null,          'none'],
  [null,                         null,           null,          'none'],
  ['The Real Tarun',             null,           'tarun',       'first-name'],
  ['priya',                      null,           'priya',       'first-name'],
  ['Saru Skin Fan',              null,           null,          'none'],
  // handle tier: only reached when the profile name gives nothing, and only the
  // FIRST segment of the handle counts
  ['glow.by.mia',                'amar.lathia',  'amar',        'handle'],
  ['✨glow✨',                    'yessir.white', null,          'none'],
  ['',                           'maya.runs',    'maya',        'handle'],
];

let passed = 0, failed = 0;
const show = (v) => (v === null ? 'null' : JSON.stringify(v));

for (const [name, username, wantName, wantBasis] of CASES) {
  const heur = heuristicGreeting({ name, username });
  const got = await resolveGreeting({ name, username });
  const label = `name ${show(name)}${username ? ` + @${username}` : ''}`;
  const decided = heur.basis !== 'ambiguous';
  const right = got.greetName === wantName && got.basis === wantBasis;
  if (decided && right) {
    console.log(`  PASS  ${label} → ${show(got.greetName)} (${got.basis})`);
    passed++;
  } else {
    console.log(`  FAIL  ${label} → ${show(got.greetName)} (${got.basis})` +
      `${decided ? '' : ' [needed the LLM tier]'}  expected ${show(wantName)} (${wantBasis})`);
    failed++;
  }
}

console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'} — ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
