// Run from the repo root:  node tests/audit.js
//
// A deeper pass than tests/validate.js, which checks one file at a time. This
// one reasons across files: does the load order actually satisfy what is
// referenced at load time, does the service worker cache everything the page
// needs, does every environment variable a function reads appear in
// .env.example, and has a secret reached a file that gets deployed.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..') + '/';
const read = f => fs.readFileSync(ROOT + f, 'utf8');

let issues = 0;
const fail = (cat, msg) => { issues++; console.log(`  ✗ [${cat}] ${msg}`); };
const note = (cat, msg) => console.log(`  · [${cat}] ${msg}`);

const APP_SCRIPTS = ['config.js', 'voice.js', 'offline.js', 'scan.js', 'admin.js', 'script.js'];
const html = read('index.html');
const css = read('style.css');
const sources = APP_SCRIPTS.map(f => [f, read(f)]);
const js = sources.map(([, s]) => s).join('\n');

/* ---- 1. script tags vs the files that exist and their order ---- */
console.log('\n[1] index.html script tags');
const loaded = [...html.matchAll(/<script src="(?!https:)([^"?]+)(\?v=([^"]+))?"/g)]
  .map(m => ({ file: m[1], version: m[3] }));
loaded.forEach(({ file }) => {
  if (!fs.existsSync(ROOT + file)) fail('scripts', `index.html loads ${file}, which does not exist`);
});
APP_SCRIPTS.forEach(f => {
  if (!loaded.some(l => l.file === f)) fail('scripts', `${f} exists but index.html never loads it`);
});
const versions = new Set(loaded.map(l => l.version).filter(Boolean));
const cssVersion = (html.match(/style\.css\?v=([^"]+)/) || [])[1];
if (cssVersion) versions.add(cssVersion);
if (versions.size > 1) fail('scripts', `mixed cache-buster versions: ${[...versions].join(', ')}`);
else note('scripts', `all assets at ?v=${[...versions][0]}, in order: ${loaded.map(l => l.file).join(' → ')}`);

const pkgVersion = JSON.parse(read('package.json')).version;
if (![...versions][0] || [...versions][0] !== pkgVersion) {
  fail('scripts', `asset version ${[...versions][0]} does not match package.json ${pkgVersion}`);
}

// The one version string nothing was checking. Forget it on a deploy and the
// browser keeps serving the previous shell, indefinitely.
const swCache = (read('sw.js').match(/const CACHE = '([^']+)'/) || [])[1];
if (!swCache) fail('scripts', 'sw.js has no CACHE constant');
else if (!swCache.endsWith(pkgVersion)) {
  fail('scripts', `sw.js CACHE is "${swCache}" but package.json is ${pkgVersion} — ` +
    'bump it or the old shell survives the deploy');
} else note('scripts', `sw.js CACHE "${swCache}" matches package.json`);

/* ---- 2. load order actually satisfies top-level references ---- */
console.log('\n[2] top-level evaluation order');
// A name used at the top level of file N must be defined in a file loaded before it.
const declaredIn = new Map();
sources.forEach(([file, src]) => {
  for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) declaredIn.set(m[1], file);
  for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm)) declaredIn.set(m[1], file);
});
// MODAL_CLOSERS is the one object literal evaluated at load that names functions
// from later-loaded files; check every value resolves to an earlier file.
const closers = (read('script.js').match(/const MODAL_CLOSERS = \{([\s\S]*?)\n\};/) || [])[1] || '';
const order = loaded.map(l => l.file);
for (const m of closers.matchAll(/:\s*([A-Za-z0-9_$]+)/g)) {
  const fn = m[1];
  const where = declaredIn.get(fn);
  if (!where) { fail('order', `MODAL_CLOSERS names ${fn}, which is defined nowhere`); continue; }
  if (order.indexOf(where) > order.indexOf('script.js')) {
    fail('order', `MODAL_CLOSERS names ${fn} from ${where}, loaded after script.js — ReferenceError at load`);
  }
}
note('order', `${closers.split('\n').filter(l => l.includes(':')).length} modal closers resolve`);

/* ---- 3. every function an inline handler calls exists ---- */
console.log('\n[3] handlers → definitions');
const defined = new Set(declaredIn.keys());
const BUILTIN = new Set(['event', 'this', 'window', 'document', 'Math', 'String', 'Number',
  'Array', 'Object', 'JSON', 'Date', 'parseInt', 'parseFloat', 'setTimeout', 'Event']);
const calls = new Set();
for (const m of html.matchAll(/\bon\w+="([^"]+)"/g))
  for (const c of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(c[1]);
for (const m of js.matchAll(/\bon(?:click|change|input|blur|focus)="([^"`]*?)"/g))
  for (const c of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(c[1]);
[...calls].sort().forEach(fn => {
  if (!defined.has(fn) && !BUILTIN.has(fn)) fail('handlers', `${fn}() is called from markup but never defined`);
});
note('handlers', `${calls.size} distinct functions called from markup`);

/* ---- 4. ids ---- */
console.log('\n[4] element ids');
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
for (const m of js.matchAll(/\sid="([a-zA-Z][\w-]*)"/g)) htmlIds.add(m[1]);
for (const m of js.matchAll(/id="([a-zA-Z][\w-]*)-\$\{/g)) htmlIds.add(m[1]);
for (const m of js.matchAll(/\.id\s*=\s*'([^']+)'/g)) htmlIds.add(m[1]);
const seen = {}, dupes = new Set();
for (const m of html.matchAll(/\sid="([^"]+)"/g)) { if (seen[m[1]]) dupes.add(m[1]); seen[m[1]] = 1; }
dupes.forEach(d => fail('ids', `duplicate id="${d}" in index.html`));

const looked = new Set();
for (const m of js.matchAll(/\$\('([^']+)'\)/g)) looked.add(m[1]);
for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) looked.add(m[1]);
for (const m of js.matchAll(/\b(?:show|setText)\('([^']+)'/g)) looked.add(m[1]);
for (const m of js.matchAll(/\b(?:openModal|closeModal)\('([^']+)'\)/g)) looked.add(m[1]);
for (const m of js.matchAll(/showAlert\('([^']+)'/g)) looked.add(m[1]);
[...looked].sort().forEach(id => {
  if (!htmlIds.has(id)) fail('ids', `#${id} is looked up but never rendered`);
});
note('ids', `${htmlIds.size} ids declared, ${looked.size} looked up, ${dupes.size} duplicates`);

/* ---- 5. sprite icons ---- */
console.log('\n[5] svg sprite');
const symbols = new Set([...html.matchAll(/<symbol id="([^"]+)"/g)].map(m => m[1]));
const used = new Set();
for (const m of html.matchAll(/<use href="#([^"]+)"/g)) used.add(m[1]);
for (const m of js.matchAll(/<use href="#([^"'\s]+)"/g)) used.add(m[1]);
for (const m of js.matchAll(/setIcon\([^,]+,\s*'([^']+)'\)/g)) used.add(m[1]);
for (const m of js.matchAll(/'#(i-[a-z]+)'/g)) used.add(m[1]);
[...used].sort().forEach(s => { if (!symbols.has(s)) fail('icons', `#${s} used but not in the sprite`); });
[...symbols].sort().forEach(s => { if (!used.has(s)) note('icons', `#${s} is defined but never used`); });

/* ---- 6. service worker shell vs what the page actually needs ---- */
console.log('\n[6] service worker shell');
const shell = [...read('sw.js').matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);
loaded.forEach(({ file }) => {
  if (!shell.includes(file)) fail('sw', `${file} is loaded by index.html but not in the sw.js shell`);
});
if (!shell.includes('style.css')) fail('sw', 'style.css is not in the sw.js shell');
shell.forEach(f => {
  if (f === '' || f.endsWith('/')) return;
  if (!fs.existsSync(ROOT + f)) fail('sw', `sw.js caches ${f}, which does not exist`);
});
note('sw', `${shell.length} shell entries, all present`);

/* ---- 7. CSS classes the JS depends on ---- */
console.log('\n[7] CSS classes referenced from JS');
const jsClasses = new Set();
for (const m of js.matchAll(/class="([a-z][\w\s-]*)"/g))
  m[1].split(/\s+/).filter(Boolean).forEach(c => jsClasses.add(c));
for (const m of js.matchAll(/classList\.(?:add|toggle|remove|contains)\('([\w-]+)'/g)) jsClasses.add(m[1]);
const missing = [...jsClasses].filter(c => !c.includes('${') && !css.includes('.' + c));
missing.sort().forEach(c => fail('css', `.${c} is applied by JS but has no rule`));
note('css', `${jsClasses.size} classes applied from JS`);

/* ---- 8. secrets ---- */
console.log('\n[8] secrets in shipped files');
const SHIPPED = ['index.html', 'config.js', ...APP_SCRIPTS, 'sw.js', 'style.css', 'manifest.json'];
const PATTERNS = [
  [/service_role/i, 'the words service_role'],
  [/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./, 'a JWT'],
  [/AIza[0-9A-Za-z_-]{30,}/, 'a Google API key'],
  [/sb_secret_/, 'a Supabase secret key'],
];
// Comments are stripped first: every one of these files *talks about* the
// service_role key precisely to say it must never be here, and flagging the
// warning as the thing it warns about would train everyone to ignore this.
const stripComments = s => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^\s*#.*$/gm, '');
[...new Set(SHIPPED)].forEach(f => {
  const code = stripComments(read(f));
  PATTERNS.forEach(([re, what]) => {
    if (re.test(code)) fail('secrets', `${f} contains ${what}`);
  });
});
if (fs.existsSync(ROOT + '.env')) {
  // A .env that is not ignored is the single worst outcome here, so a missing
  // git is reported rather than treated as a pass.
  let ignored = null;
  try {
    ignored = require('child_process')
      .execSync('git check-ignore .env || true', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { ignored = null; }
  if (ignored === null) fail('secrets', '.env exists and git could not confirm it is ignored');
  else if (ignored !== '.env') fail('secrets', '.env exists but is NOT gitignored');
  else note('secrets', '.env present and gitignored');
} else {
  note('secrets', 'no local .env (fine — the deployed site never reads one)');
}
// Only the values are scanned: SUPABASE_SERVICE_ROLE_KEY is a variable NAME
// that has to appear here, and it is the value beside it that must not.
const exampleEnv = read('.env.example');
const exampleValues = [...exampleEnv.matchAll(/^[A-Z0-9_]+=(.*)$/gm)]
  .map(m => m[1]).join('\n');
PATTERNS.forEach(([re, what]) => {
  if (re.test(exampleValues)) fail('secrets', `.env.example ships ${what}`);
});
[...exampleEnv.matchAll(/^([A-Z0-9_]+)=(.+)$/gm)].forEach(([, key, value]) => {
  if (/SERVICE_ROLE|GEMINI_API_KEY/.test(key) && value.trim()) {
    fail('secrets', `.env.example gives ${key} a value; it must ship empty`);
  }
});

/* ---- 9. env vars: declared, documented, used ---- */
console.log('\n[9] environment variables');
const fnSources = fs.readdirSync(ROOT + 'netlify/functions')
  .map(f => read('netlify/functions/' + f)).join('\n') + read('scripts/build-config.mjs');
const usedEnv = new Set([...fnSources.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(m => m[1]));
for (const m of fnSources.matchAll(/const \{([^}]+)\} = process\.env/g))
  m[1].split(',').map(s => s.trim()).filter(Boolean).forEach(v => usedEnv.add(v));
// build-config.mjs indexes process.env by a name from a lookup table.
for (const m of read('scripts/build-config.mjs').matchAll(/^\s{2}([A-Z0-9_]+):/gm))
  usedEnv.add(m[1]);
const documented = new Set([...exampleEnv.matchAll(/^([A-Z0-9_]+)=/gm)].map(m => m[1]));
[...usedEnv].sort().forEach(v => {
  if (!documented.has(v)) fail('env', `${v} is read by a function but absent from .env.example`);
});
[...documented].sort().forEach(v => {
  if (!usedEnv.has(v)) fail('env', `${v} is documented in .env.example but nothing reads it`);
});
note('env', `${usedEnv.size} variables read, all documented`);

/* ---- 10. markup and stylesheet are structurally sound ---- */
console.log('\n[10] structure');
const VOID = new Set(['area','base','br','col','embed','hr','img','input','link',
  'meta','param','source','track','wbr','path','circle','rect','use','stop','polygon','line','ellipse']);
const stack = [];
let balanced = true;
const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/i, '');
for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
  const [, closing, tag, attrs, selfClosed] = m;
  const name = tag.toLowerCase();
  if (VOID.has(name) || selfClosed) continue;
  if (!closing) { stack.push(name); continue; }
  if (!stack.length) {
    fail('html', `</${name}> with nothing open`); balanced = false; break;
  }
  const open = stack.pop();
  if (open !== name) {
    fail('html', `</${name}> closes <${open}> — tags are crossed near "${attrs.slice(0, 40)}"`);
    balanced = false; break;
  }
}
if (balanced && stack.length) fail('html', `never closed: <${stack.join('>, <')}>`);
else if (balanced) note('html', 'every tag in index.html is balanced');

const braces = css.replace(/\/\*[\s\S]*?\*\//g, '');
const opens = (braces.match(/\{/g) || []).length;
const closes = (braces.match(/\}/g) || []).length;
if (opens !== closes) fail('css', `style.css has ${opens} { and ${closes} } — unbalanced`);
else note('css', `style.css balanced, ${opens} rule blocks`);

['package.json', 'manifest.json'].forEach(f => {
  try { JSON.parse(read(f)); note('json', `${f} parses`); }
  catch (e) { fail('json', `${f} is not valid JSON: ${e.message}`); }
});

/* ---- 11. the SQL migration ---- */
console.log('\n[11] supabase/admin.sql');
const sql = read('supabase/admin.sql');
const dollarBlocks = (sql.match(/\$\$/g) || []).length;
if (dollarBlocks % 2 !== 0) fail('sql', `odd number of $$ delimiters (${dollarBlocks}) — a function body is unterminated`);
else note('sql', `${dollarBlocks / 2} function bodies delimited`);
// Every admin_* function the client calls must exist in the migration.
const rpcCalls = new Set([...js.matchAll(/adminRpc\('([a-z_]+)'/g)].map(m => m[1]));
rpcCalls.forEach(fn => {
  if (!new RegExp('function public\\.' + fn + '\\b').test(sql)) {
    fail('sql', `admin.js calls ${fn}() but the migration does not define it`);
  }
});
note('sql', `${rpcCalls.size} RPC functions called by the client, all defined`);
// Every action the client posts must be one the function accepts.
const fnActions = read('netlify/functions/admin.mjs');
const allowed = new Set(((fnActions.match(/const ACTIONS = new Set\(\[([\s\S]*?)\]\)/) || [])[1] || '')
  .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean));
[...js.matchAll(/adminCall\('([a-z-]+)'/g)].map(m => m[1]).forEach(action => {
  if (!allowed.has(action)) fail('sql', `admin.js posts action "${action}", which admin.mjs rejects`);
});
note('sql', `${allowed.size} server actions declared, all client calls accepted`);

console.log(issues === 0 ? '\n✅ audit clean\n' : `\n❌ ${issues} issue(s)\n`);
process.exit(issues ? 1 : 0);
