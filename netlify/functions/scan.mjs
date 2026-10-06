// ---------------------------------------------------------------------------
//  Read a receipt with a vision model
//
//  Every reader here is a vision model. There was an on-device Tesseract
//  fallback and it was worse than nothing: character recognition has never
//  been shown a ₹, so it reads the symbol as a digit, and it loses decimal
//  points, turning ₹100.00 into ₹10,000. A total wrong by a factor of a
//  hundred, saved without anyone noticing which reader produced it, is worse
//  than a scanner that admits it cannot read the receipt today.
//
//  Providers are tried in order and the first that answers wins, so one being
//  out of quota does not end the scan. A provider that rate-limits is put on a
//  cooldown so the next attempt skips straight past it.
//
//  MODEL NAMES ROT. Providers retire them, and a model that was the good free
//  one last quarter is the degraded one this quarter. So each provider's model
//  list is fetched live, filtered to the ones that can see images, and sorted
//  newest-first — the static list below is only the fallback for when that
//  fetch fails. Nothing has to be edited here when a provider ships v4.
//
//  Note the trade: the picture leaves the phone. The scanner says so before
//  it is used.
// ---------------------------------------------------------------------------

const MAX_IMAGES = Number(process.env.SCAN_MAX_IMAGES) || 5;

// Netlify kills a synchronous function at 26s (10s unless netlify.toml raises
// it). Walking a congested provider's model list can take longer than that, so
// the chain stops starting new attempts once the budget is nearly spent and
// returns a "busy, try again" the client can act on — a timeout kills the
// request and the client gets nothing to explain.
//
// ponytail: 24s is all a synchronous Netlify function gets, and a successful
// read off a congested free tier measured 13-21s in testing — so there is
// room for roughly one good attempt plus a few fast failures (a 429 or a bad
// key answers in about a second). When the first provider is slow AND busy,
// this returns "too slow, try again" and the client offers a retry button.
// If that becomes common, the fix is a background function plus polling, not
// a bigger number here.
const TIME_BUDGET_MS = Number(process.env.SCAN_TIME_BUDGET_MS) || 24000;
const MAX_BYTES = 5 * 1024 * 1024;       // per image, after the client shrinks it
const DEFAULT_COOLDOWN_MS = 60 * 1000;
const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;

const PROMPT = [
  'These images are screenshots of ONE receipt or order — typically an Indian',
  'quick-commerce or food app (Zepto, Blinkit, Swiggy Instamart, BigBasket,',
  'Zomato, Dunzo), but a shop bill works the same way. Several images are',
  'consecutive parts of the same scrolling list, so an item visible in two of',
  'them is ONE item — never list it twice.',
  '',
  'List every line the customer actually bought.',
  '',
  'price: the rupee amount CHARGED for that line, as a number. These apps show',
  'a discount by printing the old MRP struck through, smaller or greyed, under',
  'or beside the amount paid — use the amount PAID, which is the smaller and',
  'bolder of the two. The price shown against a row is the total for that row.',
  'Read decimals exactly: 100.00 is one hundred, not ten thousand. The ₹ or Rs',
  'symbol is never part of the number.',
  '',
  'qty: how many of it were bought. "1 unit", "2 units", "x2". A pack size',
  '("500 g", "12 x 70 g", "1 pack (6 pcs)") is NOT a quantity — that is 1.',
  '',
  'kind: "fee" for handling, delivery, platform, packaging, surge, rain, tip,',
  'GST and other taxes. "item" for anything anyone ate or unpacked. A fee shown',
  'as FREE or ₹0 is not a line at all — leave it out.',
  '',
  'Leave out order totals, subtotals, "you saved", order ids, addresses,',
  'delivery times, and anything that is app furniture rather than the order.',
  'Give the product name as printed, without the size line beneath it.',
  'If an image is not a receipt at all, return an empty list.',
  '',
  'Reply with JSON only, no prose and no code fence, shaped exactly like:',
  '{"rows":[{"name":"Onion 1 kg","qty":1,"price":42,"kind":"item"}]}',
].join('\n');

// Gemini can be handed a schema outright; the others are told in the prompt
// and checked on the way out.
const SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          qty: { type: 'integer' },
          price: { type: 'number' },
          kind: { type: 'string', enum: ['item', 'fee'] },
        },
        required: ['name', 'qty', 'price', 'kind'],
      },
    },
  },
  required: ['rows'],
};

class Refusal extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;   // the provider's own Retry-After, if it sent one
  }
}

/* ===========================================================================
   Providers

   `vision` decides which of a provider's models can be sent an image, and is
   what keeps model discovery from offering a text-only model. `fallback` is
   used only when the live list cannot be fetched.
   =========================================================================== */

// Chat-completions shape, which OpenAI, Groq, OpenRouter, Mistral, DeepSeek,
// Together, xAI and most others all copy. One adapter, five providers.
function openAiLike({ id, label, env, base, fallback, vision, headers, free }) {
  return {
    id, label, env, free, vision, fallback,
    async listModels(key) {
      const res = await fetch(base + '/models', {
        headers: Object.assign({ authorization: 'Bearer ' + key }, headers || {}),
      });
      if (!res.ok) throw new Refusal(res.status, 'model list unavailable');
      const body = await res.json();
      return body.data || body.models || [];
    },
    async send(key, model, images) {
      const content = [{ type: 'text', text: PROMPT }].concat(images.map(img => ({
        type: 'image_url',
        image_url: { url: 'data:' + img.mime + ';base64,' + img.data },
      })));
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: Object.assign({
          'content-type': 'application/json',
          authorization: 'Bearer ' + key,
        }, headers || {}),
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 4096,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content }],
        }),
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new Refusal(res.status, raw.slice(0, 200), res.headers.get('retry-after'));
      }
      return JSON.parse(raw)?.choices?.[0]?.message?.content || '{}';
    },
  };
}

const PROVIDERS = [
  {
    id: 'gemini',
    label: 'Gemini',
    env: 'GEMINI_API_KEY',
    free: true,
    idOf: m => String(m.name || '').replace(/^models\//, ''),
    // Gemini publishes no modality flag, but every gemini-N-flash/pro takes
    // images; the embedding, TTS and image-generation models are named apart.
    vision: m => /^gemini-[\d.]+-(flash|pro)(-latest|-lite)?$/
      .test(String(m.name || '').replace(/^models\//, '')),
    fallback: ['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-flash-latest'],
    async listModels(key) {
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
        { headers: { 'x-goog-api-key': key } });
      if (!res.ok) throw new Refusal(res.status, 'model list unavailable');
      const body = await res.json();
      return (body.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'));
    },
    async send(key, model, images) {
      const parts = [{ text: PROMPT }].concat(images.map(img => ({
        inline_data: { mime_type: img.mime, data: img.data },
      })));
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              temperature: 0,
              responseMimeType: 'application/json',
              responseSchema: SCHEMA,
            },
          }),
        });
      const raw = await res.text();
      if (!res.ok) throw new Refusal(res.status, raw.slice(0, 200));
      return JSON.parse(raw)?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    },
  },

  openAiLike({
    id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY',
    base: 'https://api.openai.com/v1',
    // OpenAI's /models says nothing about modality, so the name is all there
    // is to go on.
    vision: m => /^(gpt-4o|gpt-4\.1|gpt-5|o[34])/.test(String(m.id || '')) &&
      !/(tts|audio|realtime|search|codex|transcribe|image|embed|moderation)/i
        .test(String(m.id || '')),
    fallback: ['gpt-4o-mini', 'gpt-4o'],
  }),

  openAiLike({
    id: 'groq', label: 'Groq', env: 'GROQ_API_KEY', free: true,
    base: 'https://api.groq.com/openai/v1',
    // Groq's catalogue is mostly audio and text; the multimodal Llamas come
    // and go. No modality flag, so match on name and accept finding nothing.
    vision: m => /(scout|maverick|vision|-vl)/i.test(String(m.id || '')),
    fallback: ['meta-llama/llama-4-scout-17b-16e-instruct',
               'meta-llama/llama-4-maverick-17b-128e-instruct'],
  }),

  openAiLike({
    id: 'mistral', label: 'Mistral', env: 'MISTRAL_API_KEY', free: true,
    base: 'https://api.mistral.ai/v1',
    // Mistral publishes capabilities.vision, which is the whole point of
    // asking. The OCR, audio and CLI models answer on different endpoints.
    vision: m => m.capabilities && m.capabilities.vision === true &&
      !/(ocr|voxtral|vibe|moderation|embed)/i.test(String(m.id || '')),
    fallback: ['pixtral-12b-2409', 'mistral-small-latest'],
  }),

  openAiLike({
    id: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY', free: true,
    base: 'https://openrouter.ai/api/v1',
    // OpenRouter publishes input_modalities and pricing, so both questions —
    // can it see, and is it free — are answered rather than guessed at.
    vision: m => (m.architecture?.input_modalities || []).includes('image') &&
      Number(m.pricing?.prompt ?? 1) === 0 &&
      !/(safety|guard|lyria|omni)/i.test(String(m.id || '')),
    fallback: ['meta-llama/llama-4-scout:free',
               'google/gemini-2.0-flash-exp:free'],
    headers: {
      'http-referer': 'https://github.com/sdukesameer/MyExpenseTracker',
      'x-title': 'MyExpenseTracker',
    },
  }),

  {
    id: 'anthropic',
    label: 'Claude',
    env: 'ANTHROPIC_API_KEY',
    vision: m => /^claude-/.test(String(m.id || '')),
    fallback: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'],
    async listModels(key) {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) throw new Refusal(res.status, 'model list unavailable');
      return (await res.json()).data || [];
    },
    async send(key, model, images) {
      const content = images.map(img => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mime, data: img.data },
      })).concat([{ type: 'text', text: PROMPT }]);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model, max_tokens: 4096, temperature: 0,
          messages: [{ role: 'user', content }],
        }),
      });
      const raw = await res.text();
      if (!res.ok) throw new Refusal(res.status, raw.slice(0, 200));
      return JSON.parse(raw)?.content?.find(b => b.type === 'text')?.text || '{}';
    },
  },
];

/* ===========================================================================
   Keeping up with model names

   A model id carries its version in its digits — gemini-3.6-flash,
   llama-4-scout, claude-haiku-4-5. Sorting those digit runs numerically puts
   the newest first without anyone having to know what the newest is called.

   Dated snapshots (claude-haiku-4-5-20251001) sort correctly too: the date is
   just more digits, and a later snapshot of the same version wins.
   =========================================================================== */

function versionKey(id) {
  return (String(id).match(/\d+/g) || []).map(Number);
}

function newerFirst(a, b) {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (y[i] || 0) - (x[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

// Cheap per-container memo. A model list does not change by the minute, and
// paying for that round trip on every scan would be silly.
const modelCache = new Map();   // provider id -> { at, ids }

async function modelsFor(provider, key) {
  const hit = modelCache.get(provider.id);
  if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.ids;
  try {
    const ids = await provider.listModels(key);
    modelCache.set(provider.id, { at: Date.now(), ids });
    return ids;
  } catch (err) {
    modelCache.set(provider.id, { at: Date.now(), ids: null });
    return null;   // discovery failed; the caller uses the static list
  }
}

/**
 * The models to try, best first.
 *
 * An explicit override always wins — that is the escape hatch for the day a
 * provider ships something the vision pattern does not recognise. After that
 * come the live models newest-first, then the static list for anything
 * discovery did not surface.
 */
async function candidatesFor(provider, key) {
  const override = process.env[provider.id.toUpperCase() + '_MODEL'];
  if (override) return [override];

  const live = await modelsFor(provider, key);
  const idOf = provider.idOf || (m => String(m.id || ''));

  // Discovery failed outright — no network, a bad key, a changed endpoint.
  // The static list is all there is.
  if (!live) return provider.fallback.slice(0, 4);

  const ids = live.map(idOf);
  const discovered = live.filter(provider.vision).map(idOf).sort(newerFirst);

  // Discovery worked and this provider has nothing that can see an image.
  // Groq's catalogue, for one, is audio and text today. Trying the static
  // list here would spend two round trips to be told the names are gone.
  if (!discovered.length) return [];

  // Keep any static name discovery confirms still exists, as a backstop
  // behind the newest.
  const backstop = provider.fallback.filter(id => ids.includes(id));

  // Deep enough to get past a congested top of the list — the newest flash
  // model is also the most contended, and the -lite variants below it are
  // usually idle — but not so deep that walking 503s eats the whole time
  // budget before anything is tried.
  const seen = new Set();
  return [...discovered, ...backstop]
    .filter(id => id && !seen.has(id) && seen.add(id))
    .slice(0, 5);
}

/* ---------------------------------------------------------------------------
   Rate-limit cooldowns

   A provider that has just said 429 will say it again, so skip it rather than
   spend a round trip finding out. Module scope, which on Netlify lives as long
   as the warm container — good enough for a cooldown measured in a minute.

   ponytail: in-memory, so a cold start forgets. Netlify Blobs only if the
   wasted 429s ever start costing something.
   --------------------------------------------------------------------------- */

const cooldowns = new Map();

function coolingFor(id) {
  return Math.max(0, (cooldowns.get(id) || 0) - Date.now());
}

// "You have no credits remaining" also arrives as a 429, and it will still be
// true in sixty seconds. Telling somebody to try again in a minute, forever,
// is worse than telling them the account needs topping up.
const OUT_OF_CREDIT = /insufficient_quota|credit_balance|no credits|billing|payment/i;

function startCooldown(id, retryAfter, body) {
  if (OUT_OF_CREDIT.test(String(body || ''))) {
    const ms = 60 * 60 * 1000;
    cooldowns.set(id, Date.now() + ms);
    return { ms, reason: 'out of credit' };
  }
  const seconds = Number(retryAfter);
  const ms = Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, 10 * 60 * 1000) : DEFAULT_COOLDOWN_MS;
  cooldowns.set(id, Date.now() + ms);
  return { ms, reason: 'rate limited' };
}

/* ------------------------------------------------------------------------ */

const configured = () => PROVIDERS.filter(p => !!process.env[p.env]);

/**
 * Stop waiting on one attempt once the budget is spent.
 *
 * Checking the clock between attempts is not enough: a single congested model
 * can sit there for a minute on its own, which is how a 21s budget produced a
 * 68s request in testing. The underlying fetch is left to die with the
 * container — there is nothing useful left to do with it.
 */
function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Refusal(408, 'took too long')), Math.max(0, ms));
    }),
  ]);
}

/** Whatever came back, as the rows the client expects. Throws if unusable. */
function toRows(text) {
  // Models wrap JSON in a ```json fence despite being told not to, and some
  // put a sentence in front of it.
  let cleaned = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  if (cleaned[0] !== '{' && cleaned[0] !== '[') {
    const brace = cleaned.indexOf('{');
    if (brace > -1) cleaned = cleaned.slice(brace);
  }
  const parsed = JSON.parse(cleaned);
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  if (!Array.isArray(rows)) throw new Error('no rows array');

  // Money crosses the wire as rupees and becomes paise here, so the client
  // never has to do the rounding — every amount the scanner adds up is an
  // integer, and only the final total is turned back into rupees.
  const clean = [];
  for (const r of rows) {
    const name = String((r && r.name) || '').trim().slice(0, 120);
    const price = Number(r && r.price);
    if (!name || !isFinite(price) || price <= 0 || price > 1000000) continue;
    const qty = Math.min(99, Math.max(1, Math.round(Number(r && r.qty) || 1)));
    clean.push({
      name, qty,
      totalPaise: Math.round(price * 100),
      kind: r && r.kind === 'fee' ? 'fee' : 'item',
    });
  }
  // Fees last, the same order scan.js puts them in.
  return clean.filter(r => r.kind === 'item').concat(clean.filter(r => r.kind === 'fee'));
}

export default async (request) => {
  if (request.method === 'GET') {
    const ready = configured();
    const url = new URL(request.url);
    if (!url.searchParams.has('diagnose')) {
      return json({
        ready: ready.length > 0,
        providers: ready.map(p => p.label),
        maxImages: MAX_IMAGES,
      });
    }
    // What each provider can actually see today, which is the only way to
    // answer "why did it pick that model".
    const all = [];
    for (const p of PROVIDERS) {
      const key = process.env[p.env];
      all.push({
        id: p.id, label: p.label, env: p.env,
        configured: !!key,
        free: !!p.free,
        coolingForMs: coolingFor(p.id),
        willTry: key ? await candidatesFor(p, key) : [],
      });
    }
    return json({ ready: ready.length > 0, maxImages: MAX_IMAGES, all });
  }
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  const ready = configured();
  if (!ready.length) {
    return json({
      error: 'unconfigured',
      detail: 'None of ' + PROVIDERS.map(p => p.env).join(', ') + ' is set',
    }, 501);
  }

  let images;
  try {
    const body = await request.json();
    images = Array.isArray(body.images) ? body.images : [];
  } catch (e) {
    return json({ error: 'Send { images: [{ mime, data }] }' }, 400);
  }

  if (!images.length) return json({ error: 'No images sent' }, 400);
  if (images.length > MAX_IMAGES) {
    return json({ error: 'At most ' + MAX_IMAGES + ' screenshots at a time' }, 400);
  }
  for (const img of images) {
    if (!/^image\/(png|jpe?g|webp|heic|heif)$/i.test(String(img && img.mime || ''))) {
      return json({ error: 'That file is not an image the reader accepts' }, 400);
    }
    // base64 inflates by 4/3; measure what was actually sent.
    if ((String(img.data || '').length * 3) / 4 > MAX_BYTES) {
      return json({ error: 'One of those images is too large' }, 413);
    }
  }

  const tried = [];
  const deadline = Date.now() + TIME_BUDGET_MS;
  let ranOut = false;

  for (const provider of ready) {
    if (Date.now() > deadline) { ranOut = true; break; }
    const cooling = coolingFor(provider.id);
    if (cooling > 0) {
      tried.push({ id: provider.id, label: provider.label,
                   error: 'rate limited', retryInMs: cooling });
      continue;
    }

    const key = process.env[provider.env];
    const candidates = await candidatesFor(provider, key);
    if (!candidates.length) {
      tried.push({ id: provider.id, label: provider.label,
                   error: 'no model here can read images' });
      continue;
    }

    let lastError = 'no usable model';
    let rateLimited = false;

    for (const model of candidates) {
      const left = deadline - Date.now();
      if (left <= 0) { ranOut = true; break; }
      try {
        const rows = toRows(await withDeadline(provider.send(key, model, images), left));
        // Nothing found is not an answer worth keeping: let the next reader
        // have a go before telling somebody their receipt has no items in it.
        if (!rows.length) { lastError = 'found nothing in those images'; continue; }
        return json({ rows, by: provider.label + ' · ' + model, tried });
      } catch (err) {
        lastError = err.message || String(err);
        if (err instanceof Refusal) {
          if (err.status === 408) { ranOut = true; break; }
          // A retired or misspelt name: try the next model, same provider.
          if (err.status === 404 || err.status === 400) continue;
          // 503 is one model buckling under demand, not the key running out:
          // gemini-3.8-flash being swamped says nothing about gemini-3.7.
          // Only move on from the provider once its list is exhausted.
          if (err.status === 503) continue;
          if (err.status === 429 || err.status === 529) {
            const cool = startCooldown(provider.id, err.retryAfter, err.message);
            tried.push({
              id: provider.id, label: provider.label, error: cool.reason,
              // An empty account is not something waiting fixes, so it must
              // not drive the client's countdown.
              retryInMs: cool.reason === 'out of credit' ? 0 : cool.ms,
              needsAttention: cool.reason === 'out of credit',
            });
            rateLimited = true;
            break;
          }
        }
        break;   // a bad key or a refusal; the next model will not help
      }
    }

    if (!rateLimited) {
      tried.push({ id: provider.id, label: provider.label, error: lastError });
    }
    if (ranOut) break;
  }

  const soonest = tried.map(t => t.retryInMs || 0)
    .filter(ms => ms > 0).sort((a, b) => a - b)[0] || 0;

  if (ranOut) {
    tried.push({ id: 'time', label: 'Time',
                 error: 'ran out of time before every reader answered' });
  }

  return json({
    error: ranOut ? 'The readers were too slow just now'
      : soonest ? 'Every reader is busy right now'
      : 'No reader could read that',
    tried,
    // Nothing to wait for when it was simply slow: try straight away.
    retryInMs: ranOut ? 0 : soonest,
    fallback: true,
  }, 503);
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
