const fs = require('fs');
const path = require('path').join(__dirname, '..') + '/';
const html = fs.readFileSync(path + 'index.html', 'utf8');
// index.html loads several top-level scripts into one global scope, so every
// check that reasons about "the app's JS" has to see all of them.
const SCRIPTS = ['script.js', 'scan.js', 'offline.js', 'admin.js'];
const sources = SCRIPTS.map(name => [name, fs.readFileSync(path + name, 'utf8')]);
const js = sources.map(([, src]) => src).join('\n');
const css  = fs.readFileSync(path + 'style.css', 'utf8');

let problems = 0;
const fail = m => { problems++; console.log('  ✗ ' + m); };

// ---- 1. IDs declared in HTML, plus ids that script.js injects at runtime ----
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
for (const m of js.matchAll(/\sid="([a-zA-Z][\w-]*)"/g)) htmlIds.add(m[1]);   // template literals
for (const m of js.matchAll(/\.id\s*=\s*'([^']+)'/g)) htmlIds.add(m[1]);      // createElement().id =

// ---- 2. IDs the JS looks up ----
const jsIdRefs = new Set();
for (const m of js.matchAll(/\$\('([^']+)'\)/g)) jsIdRefs.add(m[1]);
for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) jsIdRefs.add(m[1]);
for (const m of js.matchAll(/\b(?:show|setText)\('([^']+)'/g)) jsIdRefs.add(m[1]);
for (const m of js.matchAll(/\b(?:openModal|closeModal)\('([^']+)'\)/g)) jsIdRefs.add(m[1]);
for (const m of js.matchAll(/showAlert\('([^']+)'/g)) jsIdRefs.add(m[1]);

console.log('\n[1] JS -> HTML element ids');
for (const id of [...jsIdRefs].sort()) {
  if (!htmlIds.has(id)) fail(`script.js looks up #${id} but no such id in index.html`);
}

// ---- 3. Functions referenced from inline handlers ----
const jsFns = new Set([...js.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map(m => m[1]));
for (const m of js.matchAll(/^(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function|\()/gm)) jsFns.add(m[1]);

console.log('\n[2] HTML inline handlers -> JS functions');
const inlineCalls = new Set();
for (const m of html.matchAll(/\bon\w+="([^"]+)"/g)) {
  for (const c of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) inlineCalls.add(c[1]);
}
for (const fn of [...inlineCalls].sort()) {
  if (!jsFns.has(fn)) fail(`inline handler calls ${fn}() which is not defined in script.js`);
}

console.log('\n[3] JS-generated inline handlers -> JS functions');
const generated = new Set();
for (const m of js.matchAll(/\bon(?:click|change|input)="([^"`]*?)"/g)) {
  for (const c of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) generated.add(c[1]);
}
for (const fn of [...generated].sort()) {
  if (!jsFns.has(fn)) fail(`generated markup calls ${fn}() which is not defined`);
}

// ---- 4. SVG sprite symbols ----
console.log('\n[4] <use href="#..."> -> sprite symbols');
const symbols = new Set([...html.matchAll(/<symbol id="([^"]+)"/g)].map(m => m[1]));
const used = new Set();
for (const m of html.matchAll(/<use href="#([^"]+)"/g)) used.add(m[1]);
for (const m of js.matchAll(/<use href="#([^"'\s]+)"/g)) used.add(m[1]);
for (const m of js.matchAll(/setIcon\([^,]+,\s*'([^']+)'\)/g)) used.add(m[1]);
for (const m of js.matchAll(/'#(i-[a-z]+)'/g)) used.add(m[1]);
for (const s of [...used].sort()) if (!symbols.has(s)) fail(`icon #${s} used but not defined in the sprite`);

// ---- 5. Duplicate ids ----
console.log('\n[5] duplicate ids in HTML');
const seen = {}, dupes = new Set();
for (const m of html.matchAll(/\sid="([^"]+)"/g)) { if (seen[m[1]]) dupes.add(m[1]); seen[m[1]] = 1; }
for (const d of dupes) fail(`duplicate id="${d}"`);

// ---- 6. Leftovers from the old implementation ----
console.log('\n[6] leftovers / known-bad patterns');
const banned = [
  ['getISTDate',            'old double-shifting timezone helper'],
  ['getISTMonthBounds',     'old timezone helper'],
  ["getElementById('current-password')", 'reference to a non-existent element'],
  ['readAsBinaryString',    'deprecated FileReader API, flaky in Safari'],
  ['toISOString().split',   'UTC date derivation'],
  ['CSS.escape',            'brittle selector escaping'],
];
// Strip comments first: a comment naming a bad API is documentation, not a use.
for (const [file, src] of sources) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [needle, why] of banned) if (code.includes(needle)) fail(`${file} still contains "${needle}" (${why})`);
}

// ---- 7. CSS classes used by JS that must exist ----
console.log('\n[7] key CSS classes exist');
for (const cls of ['modal-open','chart-empty','simple-mode','signed-in','skeleton-row','notification-action',
                   'billed-badge','unbilled-badge','budget-over-text','near-budget','radio-pill','switch']) {
  if (!css.includes('.' + cls)) fail(`CSS is missing a rule for .${cls}`);
}

// ---- 8. External scripts must be allowed by the CSP ----
console.log('\n[8] local scripts are all covered by these checks');
for (const m of html.matchAll(/<script src="(?!https:)([^"?]+)/g)) {
  if (!SCRIPTS.includes(m[1])) fail(`index.html loads ${m[1]}, which tests/validate.js does not read`);
}

console.log('\n[9] CSP allows every external script host');
const toml = fs.readFileSync(path + 'netlify.toml', 'utf8');
for (const m of html.matchAll(/<script src="https:\/\/([^/]+)/g)) {
  if (!toml.includes(m[1])) fail(`script host ${m[1]} is not in the CSP script-src`);
}

console.log(problems === 0
  ? '\n✅ All checks passed\n'
  : `\n❌ ${problems} problem(s)\n`);
process.exit(problems ? 1 : 0);
