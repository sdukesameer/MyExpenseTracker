// ---------------------------------------------------------------------------
//  Read a receipt with a vision model instead of guessing at pixels
//
//  Tesseract is character recognition with no idea what a receipt is. Its
//  English model has never been shown a ₹, so it substitutes the nearest
//  glyph it knows — on a Blinkit order, "2" — and ₹35 silently becomes 235.
//  It also drops decimal points, turning ₹100.00 into ₹10,000. scan.js
//  repairs what it can, but a repair is not a cure: character recognition
//  cannot tell a struck-out MRP from the price paid, or a thumbnail from a
//  word.
//
//  A vision model reads the layout. So this tries each configured provider
//  in turn and uses the first that answers — one being out of quota or
//  having a bad afternoon should not drop you back to the worst reader.
//
//  With no provider configured at all this returns 501 and the app quietly
//  uses on-device OCR. With providers configured but all of them failing it
//  returns 503 and the app ASKS, because "every reader is busy, try again in
//  a minute" and "this deploy has no key" deserve different answers.
//
//  Note the trade: the picture leaves the phone. The scanner says so before
//  it is used, and the on-device reader stays one tap away.
// ---------------------------------------------------------------------------

const MAX_IMAGES = 5;
const MAX_BYTES = 5 * 1024 * 1024;       // per image, after the client shrinks it
const DEFAULT_COOLDOWN_MS = 60 * 1000;

const PROMPT = [
  'These images are screenshots of ONE receipt or order — typically an Indian',
  'quick-commerce or food app (Zepto, Blinkit, Swiggy Instamart, BigBasket,',
  'Zomato, Dunzo), but a shop bill works the same way. Several images are',
  'consecutive parts of the same scrolling list, so an item visible in two of',
  'them is ONE item — never list it twice.',
  '',
  'List every line the customer actually bought.',
  '',
  'price: the rupee amount CHARGED for that line, as a number. Quick-commerce',
  'apps show a discount by printing the old MRP struck through, usually smaller',
  'or greyed, next to or under the amount paid — use the amount PAID, which is',
  'the smaller one. The price shown against a row is the total for that row.',
  'Read decimals exactly: 100.00 is one hundred, not ten thousand. The ₹ or Rs',
  'symbol is never part of the number.',
  '',
  'qty: how many of it were bought. "1 unit", "2 units", "x2". A pack size',
  '("500 g", "12 x 70 g", "1 pack (6 pcs)") is NOT a quantity — that is 1.',
  '',
  'kind: "fee" for handling, delivery, platform, packaging, surge, rain, tip,',
  'GST and other taxes. "item" for anything anyone ate or unpacked.',
  '',
  'Leave out order totals, subtotals, "you saved", order ids, addresses,',
  'delivery times, and anything that is app furniture rather than the order.',
  'Give the product name as printed, without the size line beneath it.',
  'If an image is not a receipt at all, return an empty list.',
  '',
  'Reply with JSON only, shaped exactly like:',
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

/* ===========================================================================
   The readers

   Each send() returns the model's reply as text, or throws a Refusal. Model
   names get retired from under you — Gemini in particular renames things and
   the failure looks like a broken scanner — so each provider carries a list
   and the first that answers wins.
   =========================================================================== */

class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const PROVIDERS = [
  {
    id: 'gemini',
    label: 'Gemini',
    env: 'GEMINI_API_KEY',
    models: () => [process.env.GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-2.5-flash',
                   'gemini-flash-latest'].filter(Boolean),
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
  {
    id: 'openai',
    label: 'OpenAI',
    env: 'OPENAI_API_KEY',
    models: () => [process.env.OPENAI_MODEL, 'gpt-4o-mini', 'gpt-4o'].filter(Boolean),
    async send(key, model, images) {
      const content = [{ type: 'text', text: PROMPT }].concat(images.map(img => ({
        type: 'image_url',
        image_url: { url: 'data:' + img.mime + ';base64,' + img.data },
      })));
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content }],
        }),
      });
      const raw = await res.text();
      if (!res.ok) throw new Refusal(res.status, raw.slice(0, 200));
      return JSON.parse(raw)?.choices?.[0]?.message?.content || '{}';
    },
  },
  {
    id: 'anthropic',
    label: 'Claude',
    env: 'ANTHROPIC_API_KEY',
    models: () => [process.env.ANTHROPIC_MODEL, 'claude-haiku-4-5-20251001',
                   'claude-sonnet-5'].filter(Boolean),
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
          model,
          max_tokens: 4096,
          temperature: 0,
          messages: [{ role: 'user', content }],
        }),
      });
      const raw = await res.text();
      if (!res.ok) throw new Refusal(res.status, raw.slice(0, 200));
      return JSON.parse(raw)?.content?.find(b => b.type === 'text')?.text || '{}';
    },
  },
];

/* ---------------------------------------------------------------------------
   Rate-limit cooldowns

   A provider that has just said 429 will say it again, so skip it rather than
   spend a round trip finding out. Kept in module scope, which on Netlify means
   it lives as long as the warm container — good enough for a cooldown measured
   in a minute, and it costs nothing.

   ponytail: in-memory, so a cold start forgets. Move to Netlify Blobs only if
   the providers start charging for the wasted 429.
   --------------------------------------------------------------------------- */

const cooldowns = new Map();   // provider id -> epoch ms when it may be used again

function coolingFor(id) {
  const until = cooldowns.get(id) || 0;
  return Math.max(0, until - Date.now());
}

function startCooldown(id, retryAfterHeader) {
  const seconds = Number(retryAfterHeader);
  const ms = Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000 : DEFAULT_COOLDOWN_MS;
  cooldowns.set(id, Date.now() + ms);
  return ms;
}

/* ------------------------------------------------------------------------ */

function configured() {
  return PROVIDERS.filter(p => !!process.env[p.env]);
}

/** Whatever came back, as the rows the client expects. Throws if unusable. */
function toRows(text) {
  // Models sometimes wrap JSON in a ```json fence despite being told not to.
  const cleaned = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed.rows)) throw new Error('no rows array');

  // Money crosses the wire as rupees and becomes paise here, so the client
  // never has to do the rounding — every amount the scanner adds up is an
  // integer, and only the final total is turned back into rupees.
  const clean = [];
  for (const r of parsed.rows) {
    const name = String((r && r.name) || '').trim().slice(0, 120);
    const price = Number(r && r.price);
    if (!name || !isFinite(price) || price <= 0 || price > 1000000) continue;
    const qty = Math.min(99, Math.max(1, Math.round(Number(r && r.qty) || 1)));
    clean.push({
      name,
      qty,
      totalPaise: Math.round(price * 100),
      kind: r && r.kind === 'fee' ? 'fee' : 'item',
    });
  }
  // Fees last, the same order scan.js puts them in.
  return clean.filter(r => r.kind === 'item').concat(clean.filter(r => r.kind === 'fee'));
}

export default async (request) => {
  // A GET is the scanner asking, before it shows anything, whether this deploy
  // has a reader — so that it can say truthfully where the picture goes
  // instead of promising one thing and doing another.
  if (request.method === 'GET') {
    const ready = configured();
    const diagnose = new URL(request.url).searchParams.has('diagnose');
    return json({
      ready: ready.length > 0,
      providers: ready.map(p => p.label),
      ...(diagnose ? {
        all: PROVIDERS.map(p => ({
          id: p.id, label: p.label, env: p.env,
          configured: !!process.env[p.env],
          models: p.models(),
          coolingForMs: coolingFor(p.id),
        })),
      } : {}),
    });
  }
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  const ready = configured();
  if (!ready.length) {
    // Not an error the person needs to see: the app quietly reads on-device.
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

  for (const provider of ready) {
    const cooling = coolingFor(provider.id);
    if (cooling > 0) {
      tried.push({ id: provider.id, label: provider.label,
                   error: 'rate limited', retryInMs: cooling });
      continue;
    }

    const key = process.env[provider.env];
    let lastError = 'no models configured';

    for (const model of provider.models()) {
      try {
        const rows = toRows(await provider.send(key, model, images));
        // Nothing found is not an answer worth keeping: let the next reader
        // have a go before telling somebody their receipt has no items in it.
        if (!rows.length) { lastError = 'found nothing in those images'; continue; }
        return json({ rows, by: provider.label + ' · ' + model });
      } catch (err) {
        lastError = err.message || String(err);
        // A retired or misspelt name: try the next model, same provider.
        if (err instanceof Refusal && err.status === 404) continue;
        if (err instanceof Refusal && (err.status === 429 || err.status === 529)) {
          const ms = startCooldown(provider.id, null);
          tried.push({ id: provider.id, label: provider.label,
                       error: 'out of quota', retryInMs: ms });
          lastError = null;
          break;
        }
        // Anything else is about this request, not this model name.
        break;
      }
    }

    if (lastError !== null) {
      tried.push({ id: provider.id, label: provider.label, error: lastError });
    }
  }

  // Everything configured has been tried and none of it worked. The client
  // offers the on-device reader rather than silently dropping to it.
  const soonest = tried
    .map(t => t.retryInMs || 0)
    .filter(ms => ms > 0)
    .sort((a, b) => a - b)[0] || 0;

  return json({
    error: soonest
      ? 'Every reader is busy right now'
      : 'No reader could read that',
    tried,
    retryInMs: soonest,
    fallback: true,
  }, 503);
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
