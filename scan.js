/* =====================================================================
   Receipt scanning — read a bill, tick what counts, prefill the form

   Every reader is a vision model. There used to be an on-device Tesseract
   fallback and it was worse than nothing: character recognition has never
   been shown a ₹, so it reads the symbol as a digit, and it drops decimal
   points, turning ₹100.00 into ₹10,000. A total that is wrong by a factor of
   a hundred, saved without anyone noticing which reader produced it, is worse
   than a scanner that says it cannot read the receipt today.

   So the providers are tried in turn and the first that answers wins. When
   every one of them fails the scanner says so and offers the keyboard.

   Loaded before script.js so MODAL_CLOSERS can name closeScanModal.
   ===================================================================== */

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
   The readers
   ===================================================================== */

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

// Set when every configured cloud reader was tried and all of them failed:
// { message, tried: [{ label, error, retryInMs }], retryInMs }. Null when the
// cloud was never configured, which is a different situation entirely.
let scanCloudFailure = null;

// Which provider and model produced the rows now on screen, e.g.
// "Gemini · gemini-3.6-flash". Shown above the list: when a scan comes out
// wrong, the first useful question is which reader produced it.
let scanReadBy = '';

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
/**
 * Shrink a screenshot for upload, capped on WIDTH rather than the longest
 * side.
 *
 * A receipt screenshot is tall and narrow — the one this was tested against
 * is 714×2576 — and scaling by the longest side to fit 1600 squeezed the
 * width down to 443px. Width is where the text is, so that threw away exactly
 * the resolution the reader needs while leaving the useless vertical
 * dimension intact. Height now runs as long as it likes; the byte cap is what
 * keeps the upload sane.
 */
async function scanPrepareImage(file, maxWidth, maxBytes) {
    if (!/^image\//.test(file.type || '')) throw new Error('Pick an image file.');

    const img = await scanLoadImage(file);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot resize images.');

    let dim = maxWidth;
    for (let attempt = 0; attempt < 4; attempt++) {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const scale = Math.min(1, dim / w);
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

// Returns rows, or null when no reader could produce any. The caller decides
// what to tell you, which depends on whether anything was configured at all.
async function scanReadInCloud(files) {
    scanCloudNote = '';
    scanCloudFailure = null;
    if (scanCloudReader === 'no') return null;

    const images = [];
    for (let i = 0; i < files.length; i++) {
        // 1100px wide keeps small print legible on a phone screenshot without
        // sending anything a vision model cannot use; 900KB is well inside
        // what a function body carries.
        const blob = await scanPrepareImage(files[i], 1100, 900 * 1024);
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
        // Every configured reader was tried and none worked.
        if (body.fallback) {
            scanCloudFailure = {
                message: body.error || 'The reader could not be used just now.',
                tried: Array.isArray(body.tried) ? body.tried : [],
                retryInMs: Number(body.retryInMs) || 0
            };
            return null;
        }
        throw new Error(body.error || 'The reader could not read that.');
    }
    scanCloudReader = 'yes';
    const got = Array.isArray(body.rows) ? body.rows : [];
    scanReadBy = String(body.by || '');
    if (!got.length) {
        scanCloudFailure = {
            message: 'No reader could find anything in those images.',
            tried: Array.isArray(body.tried) ? body.tried : [], retryInMs: 0
        };
        return null;
    }
    return got;
}

// Loaded on first use only: the OCR engine pulls several megabytes of wasm
// and language data, which nobody should pay for just to open the app.
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
            : 'No reader is configured on this deploy, so scanning is ' +
              'unavailable. You can still enter the items by hand.';
    });
}

/* ---- stage 2: read the images ---- */

// Each provider is tried in turn and the first that answers wins, so one
// being out of quota is not the end of the scan.
async function scanReadReceipt(files, append) {
    const many = files.length > 1;
    scanStage().innerHTML =
        '<div class="scan-state">' +
            '<div class="scan-art">🔍</div>' +
            '<h4>Reading ' + (many ? 'the screenshots' : 'the receipt') + '</h4>' +
            '<p id="scan-hint">Picking out item names and prices.</p>' +
            '<div class="scan-bar"><span id="scan-prog"></span></div>' +
        '</div>';

    // The bar is a reassurance, not a measurement: the server walks a chain of
    // providers and cannot report back mid-request. It creeps toward 90% and
    // waits there, which is honest enough — what it must not do is sit at zero
    // for twenty seconds while a congested free tier is worked through.
    let crept = 0.08;
    const creep = setInterval(function () {
        crept = Math.min(0.9, crept + 0.06);
        scanProgress(crept);
        if (crept > 0.5) scanSay('Still going — trying the next reader.');
    }, 1200);

    let found = null;
    try {
        scanProgress(crept);
        found = await scanReadInCloud(files);
    } catch (error) {
        clearInterval(creep);
        return renderScanFailed(error);
    }
    clearInterval(creep);

    if (found) {
        scanProgress(1);
        return scanApplyRows(found, { merged: 0, by: scanReadBy }, append);
    }

    // Every configured cloud reader was tried and all of them failed. Ask
    // rather than assume: dropping silently to the reader that cannot tell
    // ₹100.00 from ₹10,000 is how a wrong total gets saved without anyone
    // noticing it was the second-best reader that produced it.
    if (scanCloudFailure) return renderScanAllBusy(files, append);

    // Nothing configured at all. There is no second reader to fall back to.
    return renderScanUnconfigured();
}

function scanProgress(fraction) {
    const bar = $('scan-prog');
    if (bar) bar.style.width = Math.round(fraction * 100) + '%';
}

function scanSay(text) {
    const hint = $('scan-hint');
    if (hint) hint.textContent = text;
}

/* ---- no reader configured at all ---- */

function renderScanUnconfigured() {
    scanStage().innerHTML =
        '<div class="scan-state">' +
            '<div class="scan-art">🔌</div>' +
            '<h4>No reader is set up</h4>' +
            '<p>Scanning needs at least one vision model configured on the ' +
               'server. Until then you can enter the items by hand, which ' +
               'still adds them up and writes the summary for you.</p>' +
            '<button type="button" class="btn" id="scan-unconf-hand">' +
                'Enter the items by hand</button>' +
        '</div>';
    $('scan-unconf-hand').addEventListener('click', function () {
        scanRows = [];
        renderScanReview({ manual: true });
    });
}

/* ---- every cloud reader is down ---- */

let scanRetryTimer = null;

function renderScanAllBusy(files, append) {
    const failure = scanCloudFailure || { message: 'No reader could be used.', tried: [] };
    const waitFor = Math.ceil((failure.retryInMs || 0) / 1000);

    const detail = (failure.tried || [])
        .map(t => esc(t.label || t.id) + ' — ' + esc(t.error || 'failed'))
        .join('<br>');

    scanStage().innerHTML =
        '<div class="scan-state">' +
            '<div class="scan-art">⏳</div>' +
            '<h4>' + esc(failure.message) + '</h4>' +
            (detail ? '<p class="scan-tried">' + detail + '</p>' : '') +
            '<p>Wait for one of them to come back, or enter the items ' +
               'yourself.</p>' +
            '<button type="button" class="btn" id="scan-retry-cloud"' +
                (waitFor > 0 ? ' disabled' : '') + '>' +
                (waitFor > 0 ? 'Try again in ' + waitFor + 's' : 'Try again') +
            '</button>' +
            '<button type="button" class="btn btn-secondary" id="scan-busy-hand">' +
                'Enter the items by hand</button>' +
        '</div>';

    const retry = $('scan-retry-cloud');
    retry.addEventListener('click', function () {
        clearInterval(scanRetryTimer);
        scanReadReceipt(files, append);
    });
    $('scan-busy-hand').addEventListener('click', function () {
        clearInterval(scanRetryTimer);
        scanRows = [];
        renderScanReview({ manual: true });
    });

    if (waitFor > 0) {
        let left = waitFor;
        clearInterval(scanRetryTimer);
        scanRetryTimer = setInterval(function () {
            // The stage is replaced wholesale on every transition, so a button
            // that is gone means this screen is gone with it.
            if (!document.body.contains(retry)) return clearInterval(scanRetryTimer);
            left--;
            if (left > 0) { retry.textContent = 'Try again in ' + left + 's'; return; }
            clearInterval(scanRetryTimer);
            retry.disabled = false;
            retry.textContent = 'Try again';
        }, 1000);
    }
}

/** Fold whatever was read into the editable list. */
function scanApplyRows(found, meta, append) {
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
        (meta.note ? '<div class="scan-warn">' + esc(meta.note) + '</div>' : '') +
        (meta.by
            ? '<div class="scan-by">Read by <strong>' + esc(meta.by) + '</strong></div>'
            : '') +
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

/**
 * Rupees as typed into paise. Everything the scanner adds up is an integer:
 * forty rows of floating-point rupees drift, and the total is turned back
 * into rupees exactly once, on the way into the form.
 */
function scanToPaise(text) {
    const cleaned = String(text).replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
    const n = parseFloat(cleaned);
    if (!isFinite(n) || n <= 0 || n > 1000000) return null;
    return Math.round(n * 100);
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
