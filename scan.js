/* =====================================================================
   Receipt scanning — read a bill, tick what counts, prefill the form

   Two readers. Where GEMINI_API_KEY is configured the screenshots go to a
   vision model, which understands that the right-hand column is money and
   that a crossed-out number is the old price. Where one is not, Tesseract
   reads them on the device and the parser below picks the result apart.

   Tesseract is honest-to-goodness character recognition, not a layout model
   — it does not even know the ₹ glyph — so the parser is deliberately
   forgiving and everything either reader produces is editable before it is
   used. No image is stored by either path: what comes out is an amount and
   a one-line summary, which land in the Add Expense form for you to check.

   Loaded BEFORE script.js so MODAL_CLOSERS can name closeScanModal without
   a forward reference.
   ===================================================================== */

/* =====================================================================
   Line classification
   ===================================================================== */

// Rows that are never items: order metadata, totals, savings banners.
const SCAN_NOISE = new RegExp([
    '^(sub\\s*)?total', '^grand\\s*total', '^to\\s*pay', '^amount\\s*payable',
    '^payable', '^bill\\s*(total|details)', '^item\\s*total', '^order\\s*(id|no|summary)',
    '^invoice', '^gst\\s*(no|in)', '^address', '^deliver(ed|y)\\s*(to|in|by)',
    '^arriv', '^eta\\b', '^paid\\s*(via|using)', '^payment', '^thank',
    '^you\\s*sav', '^sav(ed|ings)', '^discount', '^coupon', '^promo',
    '^mrp\\b', '^cart\\s*total', '^grand\\b', '^\\W*$',
    // Screenshot chrome. A phone screenshot of an order carries the app's
    // header and footer and the phone's own status bar, and every one of
    // those lines ends in a number that is not an amount.
    '^order\\s*[#:]', '^order\\s*(again|details|placed)', '^\\d+\\s*items?\\b',
    '^items?\\s*in\\s*order', '^(get|need)\\s*help', '^rate\\s*(order|us)',
    '^repeat\\s*order', '^track\\s*order', '^view\\s*(invoice|bill|details)',
    '^download\\s*invoice', '^\\d{1,2}:\\d{2}\\s*(am|pm)?\\b',
    '^\\d+(\\.\\d+)?\\s*(kb|mb)/s\\b', '^delivered\\b', '^refund'
].join('|'), 'i');

// Rows that are a charge rather than a thing you bought. Nothing is
// distributed here, so a fee is just a row you can untick — but it is worth
// labelling, because it is the row most often untypical of the expense.
const SCAN_FEE = new RegExp([
    'handling', 'delivery\\s*(fee|charge|partner)', 'platform\\s*fee',
    'small\\s*cart', 'surge', 'rain\\s*fee', 'packaging', 'packing',
    'convenience', '\\btip\\b', '\\bgst\\b', '\\btax(es)?\\b',
    'service\\s*(charge|fee)', 'cgst', 'sgst', 'round\\s*off'
].join('|'), 'i');

// Units that follow a number, so "500 g" is a weight and not ₹500.
const SCAN_UNIT_AFTER = /^(g|gm|gms|kg|kgs|ml|l|ltr|litre|pc|pcs|piece|pieces|pack|packs|nos?|units?|dozen|combo|sachet|bottle|can|box|bag)\b/i;

// The same words, plus the filler around them, for deciding whether a line
// is *only* a size — "1 pc • 1 unit", "250 - 275 g • 2 units".
const SCAN_SIZE_WORD = /^(g|gm|gms|kg|kgs|ml|l|ltr|litre|lit|pc|pcs|piece|pieces|packet|pack|packs|no|nos|unit|units|dozen|combo|sachet|bottle|can|box|bag|approx|each|of|per|x|gram|grams|kilo|kilos|litres|liters)$/i;

// Zepto, Blinkit and Instamart all print the size on its own row beneath the
// item, with the struck-out MRP beside it. That row is not an item and its
// amount is not what anybody paid.
function scanIsDescriptor(name) {
    const words = String(name).split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    let sawSize = false;
    for (let i = 0; i < words.length; i++) {
        const w = words[i].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
        if (!w) continue;
        if (/^\d+(\.\d+)?$/.test(w)) continue;
        if (SCAN_SIZE_WORD.test(w)) { sawSize = true; continue; }
        const glued = w.match(/^(\d+(?:\.\d+)?)([A-Za-z]+)$/);   // "275g"
        if (glued && SCAN_SIZE_WORD.test(glued[2])) { sawSize = true; continue; }
        return false;
    }
    return sawSize;
}

/* =====================================================================
   The missing rupee

   Tesseract's English model has never been shown a ₹, so it substitutes
   whatever glyph it thinks is closest — and it is perfectly consistent about
   it within one screenshot. On a Blinkit order it reads every ₹ as a "2",
   which silently turns ₹35 into 235 and a ₹469 basket into ₹53,727.

   Nothing in the line itself can tell 235 from ₹35. The whole document can:
   if not one real currency mark survived anywhere, and every amount in the
   right-hand column carries the same leading character, and that character
   is one a ₹ plausibly collapses into — then that character IS the ₹.
   ===================================================================== */

const SCAN_MISREAD = /^[2356789zZsS$%?!|*&€¥£RrFfTtEe\]\}"']$/;
const SCAN_REAL_MARK = /₹|₨|\brs\.?\s*\d|\binr\b/i;

// Only the amount column counts as evidence: one stray character, then at
// least two digits, at the end of a line. A genuine bare "45" is one digit
// after its first, so it never votes.
const SCAN_COLUMN = /(?:^|\s)(\S)(\d\d[\d,]*(?:\.\d{1,2})?)\s*$/;

function scanEscapeRe(ch) { return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function detectRupeeGlyph(lines) {
    if (lines.some(l => SCAN_REAL_MARK.test(l))) return null;
    let glyph = null;
    let votes = 0;
    for (let i = 0; i < lines.length; i++) {
        if (SCAN_NOISE.test(lines[i])) continue;
        const m = lines[i].match(SCAN_COLUMN);
        if (!m) continue;
        if (!SCAN_MISREAD.test(m[1])) return null;         // one dissenter is enough
        if (glyph === null) glyph = m[1];
        else if (glyph !== m[1]) return null;
        votes++;
    }
    return votes >= 4 ? glyph : null;
}

// Rewrite only the run of amounts at the end of a line, so a "200 g" in the
// middle of a name is left alone while a struck MRP sitting beside the
// payable amount is not.
function scanRestoreRupees(lines, glyph) {
    const g = scanEscapeRe(glyph);
    const tail = new RegExp('((?:(?:^|\\s)' + g + '\\d\\d[\\d,]*(?:\\.\\d{1,2})?)+)\\s*$');
    const one = new RegExp('(^|\\s)' + g + '(\\d)', 'g');
    return lines.map(l => l.replace(tail, run => run.replace(one, '$1₹$2')));
}

/* =====================================================================
   Prices and quantities

   Everything is carried in paise. Forty rows of floating-point rupees drift;
   integers do not, and the total is turned back into rupees exactly once, on
   the way into the form.
   ===================================================================== */

function scanToPaise(text) {
    const cleaned = String(text).replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
    const n = parseFloat(cleaned);
    // Guard against OCR turning a barcode into a price.
    if (!isFinite(n) || n <= 0 || n > 1000000) return null;
    return Math.round(n * 100);
}

function scanPricesIn(line) {
    const found = [];

    // Anchored to a currency mark — the most reliable signal. OCR renders ₹
    // variously as ₹, ₨, Rs, INR, or a stray R.
    const anchored = /(?:₹|₨|rs\.?|inr|r5)\s*([\d,]+(?:\.\d{1,2})?)/gi;
    let m;
    while ((m = anchored.exec(line)) !== null) {
        const v = scanToPaise(m[1]);
        if (v !== null) found.push(v);
    }
    if (found.length) return found;

    // Otherwise a bare number at the very end of the line is the amount
    // column — unless it is welded to letters, which makes it a reference
    // rather than an amount. "Order #HGTKKOIU49669" is not ₹49,669. A single
    // letter in front is fine: that is a ₹ the reader did not recognise.
    const trailing = line.match(/(\S*?)([\d,]+(?:\.\d{1,2})?)\s*$/);
    if (trailing && !/[A-Za-z]{2}|#/.test(trailing[1]) && !/^[xX×]$/.test(trailing[1])) {
        const v = scanToPaise(trailing[2]);
        if (v !== null) found.push(v);
    }
    return found;
}

// A discounted row carries two amounts: what it cost, and the struck-out
// MRP. Which comes first depends on the app — Blinkit puts the payable above
// the MRP, Swiggy after it — but the payable is always the smaller of the
// two. A line doing arithmetic ("2 x 50 = 100") is left alone.
function scanPickPrice(prices, line) {
    if (prices.length === 2 && !/\d\s*[x×@=]\s*[\d₹]/i.test(line)) {
        return Math.min(prices[0], prices[1]);
    }
    return prices[prices.length - 1];
}

// "12 x 70 g" is a pack size; "x2" is how many were bought. Telling them
// apart is the whole difficulty: a count is never followed by a unit, and an
// "N x" count is never followed by another number.
function scanQuantityCandidates(line) {
    const found = [];

    // "x2" — the near-universal marker, so it wins.
    const after = /(?:^|\s)x\s*(\d{1,2})(?=\s|$)/gi;
    let m;
    while ((m = after.exec(line)) !== null) {
        const rest = line.slice(m.index + m[0].length).trim();
        if (SCAN_UNIT_AFTER.test(rest)) continue;          // "x 70 g" is a pack size
        found.push({ n: parseInt(m[1], 10), at: m.index, form: 'after' });
    }
    if (found.length) return found;

    // "2 x Dairy Milk" — only when what follows is neither a unit nor
    // another number, which is what "12 x 70 g" looks like.
    const before = /(?:^|\s)(\d{1,2})\s*x(?=\s|$)/gi;
    while ((m = before.exec(line)) !== null) {
        const rest = line.slice(m.index + m[0].length).trim();
        if (SCAN_UNIT_AFTER.test(rest) || /^\d/.test(rest)) continue;
        found.push({ n: parseInt(m[1], 10), at: m.index, form: 'before' });
    }
    return found;
}

function scanQuantityIn(line) {
    const candidates = scanQuantityCandidates(line);
    if (candidates.length) {
        const q = candidates[candidates.length - 1].n;
        if (q >= 1 && q <= 99) return q;
    }

    const m = line.match(/\bqty\.?\s*[:\-]?\s*(\d{1,2})\b/i) ||
              line.match(/(?:^|\s)(\d{1,2})\s*units?\b/i) ||
              line.match(/\((\d{1,2})\)\s*$/);
    if (!m) return 1;
    const q = parseInt(m[1], 10);
    return q >= 1 && q <= 99 ? q : 1;
}

// The item thumbnail in a Zepto or Blinkit screenshot is read as a short run
// of nonsense to the left of the name: "& Bottle Gourd", "t3 Baby Apple
// Shimla", "© ..& Tomato Local". Everything before the first real word goes,
// as long as a real name is left behind.
function scanStripLeadingJunk(name) {
    const words = name.split(' ');
    let i = 0;
    while (i < words.length - 1 && !/^[A-Za-z]{3,}/.test(words[i])) i++;
    const rest = words.slice(i).join(' ');
    return /[A-Za-z]{3}/.test(rest) ? rest : name;
}

function scanBareName(text) {
    return text
        // Currency-marked amounts first.
        .replace(/(?:₹|₨|rs\.?|inr|r5)\s*[\d,]+(?:\.\d{1,2})?/gi, ' ')
        // Then the quantity — BEFORE the trailing-number pass, which would
        // otherwise eat the digits of "x2" and leave a stray "x" behind. Only
        // a real count is removed, so "12 x 70 g" stays in the name.
        .replace(/(?:^|\s)x\s*\d{1,2}(?=\s|$)/gi, function (match, offset, whole) {
            const rest = whole.slice(offset + match.length).trim();
            return SCAN_UNIT_AFTER.test(rest) ? match : ' ';
        })
        .replace(/(?:^|\s)\d{1,2}\s*x(?=\s|$)/gi, function (match, offset, whole) {
            const rest = whole.slice(offset + match.length).trim();
            return (SCAN_UNIT_AFTER.test(rest) || /^\d/.test(rest)) ? match : ' ';
        })
        .replace(/\bqty\.?\s*[:\-]?\s*\d{1,2}\b/gi, ' ')
        .replace(/\(\d{1,2}\)\s*$/, ' ')
        // Finally a bare amount sitting in the last column.
        .replace(/([\d,]+(?:\.\d{1,2})?)\s*$/, ' ')
        .replace(/[|•·>«»]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s\-–—.,:]+|[\s\-–—.,:]+$/g, '')
        .trim();
}

function scanCleanName(text) {
    return scanStripLeadingJunk(scanBareName(text));
}

/* =====================================================================
   The parser

   Returns { rows, merged, skipped, glyph } where each row is
   { name, qty, totalPaise, kind: 'item' | 'fee' }.
   ===================================================================== */

function parseReceipt(text) {
    const lines = String(text || '')
        .split(/\r?\n/)
        .map(l => l.replace(/\s+/g, ' ').trim())
        .filter(l => l.length > 0);

    // Put the rupee sign back before anything is read, if the reader lost it.
    const glyph = detectRupeeGlyph(lines);
    const readable = glyph ? scanRestoreRupees(lines, glyph) : lines;

    const rows = [];
    let pending = [];      // name fragments awaiting a price on a later line
    let skipped = 0;

    function flushPending(totalPaise, qtyHint) {
        const name = scanCleanName(pending.join(' '));
        pending = [];
        if (!name) return false;
        push(name, qtyHint || scanQuantityIn(name), totalPaise);
        return true;
    }

    function push(name, qty, totalPaise) {
        const nice = scanCleanName(name);
        if (!nice || totalPaise == null) return -1;
        rows.push({
            name: nice,
            qty: qty,
            totalPaise: totalPaise,
            kind: SCAN_FEE.test(nice) ? 'fee' : 'item'
        });
        return rows.length - 1;
    }

    // A long product name wraps, and the half that spills onto the next line
    // lands beside the struck-out MRP: "Ganesh Whole Wheat Chakki Pure Atta |"
    // then "No Maida  ₹56". Without this that ₹56 becomes a "Maida" nobody
    // bought. The separator left hanging at the wrap is what gives it away.
    const WRAP_END = /[|/&]\s*$/;
    let continueInto = -1;

    function looksLikeContinuation(name) {
        const words = name.split(' ').filter(Boolean);
        return words.length > 0 && words.length <= 4 && !/\d/.test(name);
    }

    readable.forEach(function (line) {
        if (SCAN_NOISE.test(line)) {
            // A noise line also breaks any half-built item.
            if (pending.length) { pending = []; skipped++; }
            skipped++;
            return;
        }

        const prices = scanPricesIn(line);
        const base = scanBareName(line);

        if (continueInto > -1) {
            const carry = continueInto;
            continueInto = -1;
            if (!pending.length && looksLikeContinuation(base)) {
                rows[carry].name = scanCleanName(rows[carry].name + ' ' + base);
                rows[carry].kind = SCAN_FEE.test(rows[carry].name) ? 'fee' : 'item';
                skipped++;                 // its amount was the MRP, not a price
                return;
            }
        }

        // Whether anything survives once currency markers and amounts are
        // stripped. "Rs 38" and "₹42" leave nothing, so they are price-only
        // lines; "500 g" leaves a weight, so it belongs to the name above it.
        const named = base.length > 0;

        if (prices.length && named) {
            const amount = scanPickPrice(prices, line);

            // A size row carrying an amount — "1 pc • 1 unit  ₹99". If a name
            // is still waiting then this is its size and its price. If not,
            // the item above already took its price and this is the struck-out
            // MRP printed underneath it, which nobody paid.
            if (scanIsDescriptor(base)) {
                if (pending.length) { pending.push(base); flushPending(amount); }
                else skipped++;
                return;
            }

            // Name and amount on the same line — the common case.
            if (pending.length) flushPending(null);
            const at = push(line, scanQuantityIn(line), amount);
            if (at > -1 && WRAP_END.test(line.replace(/(?:₹|₨|rs\.?|inr|r5)?\s*[\d,]+(?:\.\d{1,2})?\s*$/i, ''))) {
                continueInto = at;
            }
            return;
        }

        if (prices.length && !named) {
            // A price on its own line, belonging to the name above it — which
            // is how Zepto and Blinkit lay their rows out.
            if (!flushPending(scanPickPrice(prices, line))) skipped++;
            return;
        }

        if (named) {
            // A name, or a weight line under one. Hold it.
            pending.push(line);
            // Never let a runaway block of prose become one giant item name.
            if (pending.length > 3) { pending.shift(); skipped++; }
            return;
        }

        skipped++;
    });

    if (pending.length) skipped++;

    // Fold away exact repeats: the same thing at the same price twice is
    // almost always the screenshot showing a row twice, not a double buy.
    const seen = {};
    const deduped = [];
    let merged = 0;
    rows.forEach(function (r) {
        const key = r.name.toLowerCase() + '|' + r.qty + '|' + r.totalPaise;
        if (seen[key]) { merged++; return; }
        seen[key] = true;
        deduped.push(r);
    });

    // Fees last, in the order they were found.
    const items = deduped.filter(r => r.kind === 'item');
    const fees = deduped.filter(r => r.kind === 'fee');

    return { rows: items.concat(fees), merged: merged, skipped: skipped, glyph: glyph };
}

/* =====================================================================
   The summary line

   What lands in the note: "Milk Maid ×2 + Potato ×1 + Delivery Fee ×1".
   The note column is capped at MAX_NOTE_LENGTH, so once the line would run
   past it the remainder collapses into "+ N more" rather than being cut off
   mid-word.
   ===================================================================== */

const SCAN_NAME_CAP = 40;

function scanSummary(rows, limit) {
    const cap = limit || 500;
    const parts = rows.map(function (r) {
        const name = r.name.trim().length > SCAN_NAME_CAP
            ? r.name.trim().slice(0, SCAN_NAME_CAP - 1).trim() + '…'
            : r.name.trim();
        return name + ' ×' + r.qty;
    });

    let line = parts.join(' + ');
    if (line.length <= cap) return line;

    // Drop from the end until the line plus its "+ N more" tail fits.
    for (let keep = parts.length - 1; keep >= 1; keep--) {
        const tail = ' + ' + (parts.length - keep) + ' more';
        line = parts.slice(0, keep).join(' + ');
        if (line.length + tail.length <= cap) return line + tail;
    }
    return parts[0].slice(0, cap);
}

/* =====================================================================
   Readers — the cloud one, then the one on this device
   ===================================================================== */

const SCAN_TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const SCAN_CLOUD_URL = '/.netlify/functions/scan';
const SCAN_MAX_SHOTS = 5;

// Rows currently on the review screen. Each is
// { name, qty, totalPaise, kind, on } — `on` is the tick.
let scanRows = [];

// Remembered for the session so a deploy with no key asks once, not every
// time somebody scans.
let scanCloudReader = 'unknown';       // 'unknown' | 'yes' | 'no'

// Why the good reader was not the one used, when it was configured. A silent
// fallback is what makes "the key is set but nothing uses it" so hard to see.
let scanCloudNote = '';

// A detached input, so the picker can be opened from anywhere without a
// hidden element having to already exist on the screen.
function scanPickFiles(onPicked) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', function () {
        const files = Array.prototype.slice.call(input.files || []);
        document.body.removeChild(input);
        if (files.length) onPicked(files.slice(0, SCAN_MAX_SHOTS));
    });
    input.click();
}

function scanLoadImage(file) {
    return new Promise(function (resolve, reject) {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = function () {
            URL.revokeObjectURL(url);
            reject(new Error('That file is not an image the browser can read.'));
        };
        img.src = url;
    });
}

// Full-page screenshots are tall. 1600px keeps small print legible while
// staying well inside what a function body can carry; quality is traded away
// before dimensions, because it costs far less to legibility.
async function scanPrepareImage(file, maxDim, maxBytes) {
    if (!/^image\//.test(file.type || '')) throw new Error('Pick an image file.');

    const img = await scanLoadImage(file);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot resize images.');

    let dim = maxDim;
    for (let attempt = 0; attempt < 4; attempt++) {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const scale = Math.min(1, dim / Math.max(w, h));
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const qualities = [0.82, 0.7, 0.58, 0.45, 0.34];
        for (let i = 0; i < qualities.length; i++) {
            const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', qualities[i]));
            if (!blob) throw new Error('This browser cannot encode images.');
            if (blob.size <= maxBytes) return blob;
        }
        dim = Math.round(dim * 0.7);   // still too big: shrink and go again
    }
    throw new Error('Could not get that picture under ' +
        Math.round(maxBytes / 1024) + ' KB. Try a simpler image.');
}

function scanToBase64(blob) {
    return new Promise(function (resolve, reject) {
        const fr = new FileReader();
        fr.onerror = function () { reject(new Error('Could not read that image.')); };
        fr.onload = function () {
            // "data:image/jpeg;base64,AAAA" — only the payload goes over the wire.
            const s = String(fr.result || '');
            resolve(s.slice(s.indexOf(',') + 1));
        };
        fr.readAsDataURL(blob);
    });
}

// Asked once, before the picker is drawn, so the screen can say where the
// picture actually goes rather than promising one thing and doing another.
function scanProbeCloud() {
    if (scanCloudReader !== 'unknown') return Promise.resolve(scanCloudReader);
    return fetch(SCAN_CLOUD_URL, { method: 'GET' })
        .then(r => (r.ok ? r.json() : { ready: false }))
        .then(function (b) { scanCloudReader = b.ready ? 'yes' : 'no'; return scanCloudReader; })
        .catch(() => 'unknown');
}

// Returns rows, or null if this deploy has no reader configured — in which
// case the caller falls back to on-device OCR rather than failing.
async function scanReadInCloud(files) {
    scanCloudNote = '';
    if (scanCloudReader === 'no') return null;

    const images = [];
    for (let i = 0; i < files.length; i++) {
        const blob = await scanPrepareImage(files[i], 1600, 900 * 1024);
        images.push({ mime: 'image/jpeg', data: await scanToBase64(blob) });
    }

    const res = await fetch(SCAN_CLOUD_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ images: images })
    });

    if (res.status === 501 || res.status === 404) { scanCloudReader = 'no'; return null; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        // Recoverable — no quota, a refusal, a model that has been retired.
        // Fall back, but say that is what happened.
        if (body.fallback) {
            scanCloudNote = body.error || 'The reader could not be used just now.';
            return null;
        }
        throw new Error(body.error || 'The reader could not read that.');
    }
    scanCloudReader = 'yes';
    const got = Array.isArray(body.rows) ? body.rows : [];
    // Nothing found is not an answer worth keeping: let the on-device reader
    // have a go before telling somebody their receipt has no items in it.
    if (!got.length) {
        scanCloudNote = 'Nothing was found in those, so they were read here instead.';
        return null;
    }
    return got;
}

// Loaded on first use only: the OCR engine pulls several megabytes of wasm
// and language data, which nobody should pay for just to open the app.
function scanLoadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise(function (resolve, reject) {
        const tag = document.createElement('script');
        tag.src = SCAN_TESSERACT_SRC;
        tag.onload = resolve;
        tag.onerror = function () {
            reject(new Error('Could not load the scanner. Check your connection.'));
        };
        document.head.appendChild(tag);
    });
}

// One worker for all of the images: loading it is the slow part, and the
// pages are read into a single block of text so an item split across two
// screenshots still has its name and its price together.
async function scanReadOnDevice(files, progress, say) {
    let worker;
    try {
        await scanLoadTesseract();
        progress(0.18);

        worker = await window.Tesseract.createWorker('eng', 1, {
            logger: function (m) {
                if (m.status === 'recognizing text') progress(0.25 + m.progress * 0.7);
            }
        });

        const pages = [];
        for (let i = 0; i < files.length; i++) {
            if (files.length > 1) say('Reading screenshot ' + (i + 1) + ' of ' + files.length + '.');
            const result = await worker.recognize(files[i]);
            pages.push(result.data.text);
        }
        progress(1);
        return parseReceipt(pages.join('\n'));
    } finally {
        // Free the wasm worker either way; the image itself is never kept.
        if (worker) { try { await worker.terminate(); } catch (e) { /* ignore */ } }
    }
}

/* =====================================================================
   The scanner modal
   ===================================================================== */

function openScanModal() {
    scanRows = [];
    scanCloudNote = '';
    openModal('scan-modal');
    renderScanPick();
}

function closeScanModal() {
    closeModal('scan-modal');
    const stage = $('scan-stage');
    if (stage) stage.innerHTML = '';
    scanRows = [];
}

function scanStage() { return $('scan-stage'); }

/* ---- stage 1: choose an image ---- */

function renderScanPick() {
    scanStage().innerHTML =
        '<div class="scan-state">' +
            '<div class="scan-art">🧾</div>' +
            '<h4>Pick your screenshots</h4>' +
            '<p>A Zepto, Blinkit, Instamart, BigBasket or Swiggy order screen ' +
               'works. Pick more than one if the bill does not fit on a single ' +
               'screen — they are read together as one order.</p>' +
            '<button type="button" class="btn" id="scan-pick">Read screenshots</button>' +
            '<p class="scan-where" id="scan-where">Whatever is read comes back ' +
              'as an editable list before anything reaches the form.</p>' +
            '<button type="button" class="scan-link" id="scan-manual">' +
              'Or enter the items by hand</button>' +
        '</div>';

    $('scan-pick').addEventListener('click', function () {
        scanPickFiles(files => scanReadReceipt(files, false));
    });
    $('scan-manual').addEventListener('click', function () {
        scanRows = [];
        renderScanReview({ manual: true });
    });

    // Say where the picture goes, once we know. Until then the line above
    // claims nothing either way.
    scanProbeCloud().then(function (state) {
        const where = $('scan-where');
        if (!where || state === 'unknown') return;
        where.textContent = state === 'yes'
            ? 'Screenshots are sent to be read and are not stored anywhere. ' +
              'Nothing reaches the form until you have checked the list.'
            : 'Screenshots are read on this device and never uploaded. Nothing ' +
              'reaches the form until you have checked the list.';
    });
}

/* ---- stage 2: read the images ---- */

// Two readers. The cloud one understands that the right-hand column is money
// and that a crossed-out number is the old price; Tesseract only knows
// shapes. So try the first, and quietly use the second when this deploy has
// no key, the free quota is spent, or the network is not there — because a
// scanner that refuses to scan is worse than one that needs a row corrected.
async function scanReadReceipt(files, append) {
    const many = files.length > 1;
    scanStage().innerHTML =
        '<div class="scan-state">' +
            '<div class="scan-art">🔍</div>' +
            '<h4>Reading ' + (many ? 'the screenshots' : 'the receipt') + '</h4>' +
            '<p id="scan-hint">Picking out item names and prices.</p>' +
            '<div class="scan-bar"><span id="scan-prog"></span></div>' +
        '</div>';

    const bar = $('scan-prog');
    function progress(pct) { if (bar) bar.style.width = Math.round(pct * 100) + '%'; }
    function say(text) {
        const hint = $('scan-hint');
        if (hint) hint.textContent = text;
    }

    let found = null;
    const meta = { merged: 0 };

    try {
        progress(0.12);
        found = await scanReadInCloud(files);
        if (found) progress(1);
    } catch (error) {
        return renderScanFailed(error);
    }

    if (!found) {
        try {
            say('Reading it on this device. The first scan downloads the reader.');
            const parsed = await scanReadOnDevice(files, progress, say);
            found = parsed.rows;
            meta.merged = parsed.merged;
            meta.glyph = parsed.glyph;
            meta.note = scanCloudNote;
        } catch (error) {
            return renderScanFailed(error);
        }
    }

    const fresh = found.map(r => ({
        name: r.name, qty: r.qty, totalPaise: r.totalPaise, kind: r.kind, on: true
    }));

    if (append) {
        // A second batch of screenshots of the same order: anything already on
        // the list at the same price is the overlap between them.
        const have = {};
        scanRows.forEach(r => { have[r.name.toLowerCase() + '|' + r.totalPaise] = true; });
        let added = 0;
        fresh.forEach(function (r) {
            const key = r.name.toLowerCase() + '|' + r.totalPaise;
            if (have[key]) return;
            have[key] = true;
            scanRows.push(r);
            added++;
        });
        meta.added = added;
    } else {
        scanRows = fresh;
    }

    renderScanReview(meta);
}

function renderScanFailed(error) {
    scanStage().innerHTML =
        '<div class="scan-state">' +
            '<div class="scan-art">😕</div>' +
            '<h4>Could not read that</h4>' +
            '<p>' + esc(error.message || String(error)) + '</p>' +
            '<button type="button" class="btn btn-secondary" id="scan-retry">' +
              'Try other screenshots</button>' +
            '<button type="button" class="scan-link" id="scan-manual2">' +
              'Enter the items by hand instead</button>' +
        '</div>';
    $('scan-retry').addEventListener('click', renderScanPick);
    $('scan-manual2').addEventListener('click', function () {
        scanRows = [];
        renderScanReview({ manual: true });
    });
}

/* ---- stage 3: check it over, drop what you do not want ---- */

function renderScanReview(meta) {
    meta = meta || {};

    if (!scanRows.length && !meta.manual) {
        scanStage().innerHTML =
            '<div class="scan-state">' +
                '<div class="scan-art">🤔</div>' +
                '<h4>No items found</h4>' +
                '<p>The reader could not pick out any priced rows. You can add ' +
                   'them by hand, or try a clearer screenshot.</p>' +
                '<button type="button" class="btn" id="scan-hand">Add items by hand</button>' +
                '<button type="button" class="scan-link" id="scan-again">' +
                  'Try other screenshots</button>' +
            '</div>';
        $('scan-hand').addEventListener('click', function () {
            scanRows = [scanBlankRow()];
            renderScanReview({ manual: true });
        });
        $('scan-again').addEventListener('click', renderScanPick);
        return;
    }

    if (meta.manual && !scanRows.length) scanRows = [scanBlankRow()];

    scanStage().innerHTML =
        (meta.merged
            ? '<div class="scan-warn">Folded away ' + meta.merged +
              (meta.merged === 1 ? ' repeated row' : ' repeated rows') +
              '. Add it back below if it was a genuine second buy.</div>'
            : '') +
        // Tesseract does not know the ₹ glyph and puts something else in its
        // place. That is undone before the amounts are read, but it is worth
        // saying so, because it is the one failure that looks like a price.
        (meta.glyph
            ? '<div class="scan-warn">The reader saw every ₹ as "' + esc(meta.glyph) +
              '", which has been undone. Worth a glance down the amounts.</div>'
            : '') +
        (meta.note ? '<div class="scan-warn">' + esc(meta.note) + '</div>' : '') +
        (meta.added === 0
            ? '<div class="scan-warn">Nothing new in those — every line was ' +
              'already on the list.</div>'
            : meta.added
                ? '<div class="scan-warn">Added ' + meta.added +
                  (meta.added === 1 ? ' more line' : ' more lines') + '.</div>'
                : '') +
        '<div class="scan-head">Untick anything you do not want, and correct ' +
          'the counts and amounts.</div>' +
        '<div class="scan-list" id="scan-rows"></div>' +
        '<div class="scan-row-actions">' +
            '<button type="button" class="btn btn-small btn-secondary" id="scan-add">' +
              'Add a line</button>' +
            '<button type="button" class="btn btn-small btn-secondary" id="scan-more">' +
              'Add more screenshots</button>' +
        '</div>' +
        '<div class="scan-foot" id="scan-foot"></div>' +
        '<button type="button" class="btn" id="scan-apply">Use these items</button>';

    $('scan-add').addEventListener('click', function () {
        scanRows.push(scanBlankRow());
        renderScanRows();
        const last = document.querySelector('#scan-rows .scan-row:last-child .scan-name');
        if (last) last.focus();
    });
    $('scan-more').addEventListener('click', function () {
        scanPickFiles(files => scanReadReceipt(files, true));
    });
    $('scan-apply').addEventListener('click', applyScan);

    renderScanRows();
}

function scanBlankRow() {
    return { name: '', qty: 1, totalPaise: 0, kind: 'item', on: true };
}

function scanRupees(paise) {
    return (paise / 100).toFixed(2);
}

// The amount field accepts anything; only digits and one decimal point mean
// something, and paise are rounded rather than dropped.
function scanParseAmount(text) {
    const cleaned = String(text || '').replace(/[^0-9.]/g, '');
    if (!cleaned || cleaned === '.') return 0;
    const parts = cleaned.split('.');
    const normalised = parts.length > 1
        ? parts[0] + '.' + parts.slice(1).join('').slice(0, 2)
        : parts[0];
    return scanToPaise(normalised) || 0;
}

function renderScanRows() {
    const host = $('scan-rows');
    host.innerHTML = scanRows.map(function (r, i) {
        return '<div class="scan-row' + (r.on ? '' : ' is-off') +
                 (r.kind === 'fee' ? ' is-fee' : '') + '" data-i="' + i + '">' +
            '<input type="checkbox" class="scan-tick"' + (r.on ? ' checked' : '') +
                   ' aria-label="Include this line">' +
            '<div class="scan-cell">' +
                '<input class="scan-name" value="' + attr(r.name) + '" ' +
                       'placeholder="What is it?" aria-label="Item name" maxlength="120">' +
                (r.kind === 'fee' ? '<span class="scan-fee-tag">fee</span>' : '') +
            '</div>' +
            '<div class="scan-qty-wrap"><span aria-hidden="true">×</span>' +
                '<input class="scan-qty" type="text" inputmode="numeric" ' +
                       'value="' + r.qty + '" aria-label="Quantity"></div>' +
            '<input class="scan-price" type="text" inputmode="decimal" ' +
                   'value="' + (r.totalPaise ? scanRupees(r.totalPaise) : '') + '" ' +
                   'placeholder="0.00" aria-label="Amount in rupees">' +
            '<button type="button" class="scan-del" aria-label="Remove this line">×</button>' +
        '</div>';
    }).join('');

    host.querySelectorAll('.scan-row').forEach(function (el) {
        const i = parseInt(el.getAttribute('data-i'), 10);

        // Typing only updates the model and the footer, so focus is never
        // yanked away mid-edit by a re-render.
        el.querySelector('.scan-name').addEventListener('input', function () {
            scanRows[i].name = this.value;
            updateScanFoot();
        });
        el.querySelector('.scan-price').addEventListener('input', function () {
            scanRows[i].totalPaise = scanParseAmount(this.value);
            updateScanFoot();
        });
        el.querySelector('.scan-qty').addEventListener('input', function () {
            const q = parseInt(String(this.value).replace(/[^0-9]/g, ''), 10);
            scanRows[i].qty = q >= 1 && q <= 99 ? q : 1;
            updateScanFoot();
        });
        el.querySelector('.scan-qty').addEventListener('blur', function () {
            this.value = scanRows[i].qty;
        });
        el.querySelector('.scan-tick').addEventListener('change', function () {
            scanRows[i].on = this.checked;
            el.classList.toggle('is-off', !this.checked);
            updateScanFoot();
        });
        el.querySelector('.scan-del').addEventListener('click', function () {
            scanRows.splice(i, 1);
            if (!scanRows.length) scanRows.push(scanBlankRow());
            renderScanRows();
        });
    });

    updateScanFoot();
}

function scanKeptRows() {
    return scanRows.filter(r => r.on && r.totalPaise > 0 && r.name.trim());
}

function updateScanFoot() {
    const foot = $('scan-foot');
    if (!foot) return;

    const kept = scanKeptRows();
    const keptTotal = kept.reduce((sum, r) => sum + r.totalPaise, 0);
    const dropped = scanRows.filter(r => !r.on && r.totalPaise > 0);
    const droppedTotal = dropped.reduce((sum, r) => sum + r.totalPaise, 0);
    const note = kept.length ? scanSummary(kept, MAX_NOTE_LENGTH) : '';

    foot.innerHTML =
        '<div class="scan-foot-line"><span>' + kept.length +
            (kept.length === 1 ? ' line kept' : ' lines kept') + '</span>' +
            '<span class="v">' + esc(money(keptTotal / 100)) + '</span></div>' +
        (dropped.length
            ? '<div class="scan-foot-line is-dropped"><span>' + dropped.length +
              (dropped.length === 1 ? ' line dropped' : ' lines dropped') + '</span>' +
              '<span class="v">−' + esc(money(droppedTotal / 100)) + '</span></div>'
            : '') +
        '<div class="scan-foot-line is-total"><span>Goes in as</span>' +
            '<span class="v">' + esc(money(keptTotal / 100)) + '</span></div>' +
        (keptTotal / 100 > MAX_AMOUNT
            ? '<div class="scan-foot-line is-dropped"><span>Over the ₹10,00,000 ' +
              'limit — drop some lines</span><span class="v"></span></div>'
            : '') +
        '<div class="scan-note-preview">' +
            '<span class="lbl">Note</span>' +
            '<span class="val">' + (note ? esc(note) : 'Nothing ticked yet') + '</span>' +
        '</div>';
}

/* ---- and out into the form ---- */

function applyScan() {
    const kept = scanKeptRows();
    if (!kept.length) {
        showNotification('Tick at least one line with a name and an amount', 'error');
        return;
    }

    const totalPaise = kept.reduce((sum, r) => sum + r.totalPaise, 0);
    const note = scanSummary(kept, MAX_NOTE_LENGTH);

    $('note').value = note;
    $('amount').value = scanRupees(totalPaise);

    // Only guess at the type when nothing is chosen, and only guess at one
    // the account actually has — inferType learns from past notes, so a
    // freshly scanned "Milk Maid ×2" often lands on Groceries by itself.
    const typeSelect = $('type');
    if (typeSelect && !typeSelect.value && typeof inferType === 'function') {
        const guess = inferType(note);
        if (guess && Array.prototype.some.call(typeSelect.options, o => o.value === guess)) {
            typeSelect.value = guess;
        }
    }

    closeScanModal();
    focusAddExpense();
    showNotification(kept.length + (kept.length === 1 ? ' line' : ' lines') +
        ' brought in — check it over, then press Add Expense', 'success', 5000);
}
