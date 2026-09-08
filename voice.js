/* =====================================================================
   Speaking an expense

   "four fifty swiggy" is faster than a keyboard with one hand holding a
   bag of groceries. The Web Speech API is free and runs on the device on
   iOS; where it is absent the button simply never appears rather than
   failing when pressed.

   What is heard lands in the quick-add box rather than being filed
   straight away. Speech recognition mishears amounts, and an expense
   silently logged at ₹4,500 instead of ₹450 is worse than one more tap.

   Loaded before script.js, which calls startVoiceEntry() from the mic.
   ===================================================================== */

const SpeechRecognitionCtor =
    window.SpeechRecognition || window.webkitSpeechRecognition;

const VOICE_AVAILABLE = !!SpeechRecognitionCtor;

/* ---------------------------------------------------------------------
   Spoken numbers

   Speech comes back as words at least as often as digits, and "two
   hundred fifty" has to add rather than concatenate.
   --------------------------------------------------------------------- */

const SPOKEN_NUMBERS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90
};

const SPOKEN_SCALES = {
    hundred: 100, thousand: 1000, lakh: 100000, lac: 100000, crore: 10000000
};

/** "four fifty rupees swiggy" → 450. Returns null when no number was said. */
function parseSpokenAmount(text) {
    const words = String(text || '').toLowerCase()
        .replace(/[^a-z0-9. ]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);

    let total = 0;      // completed scales
    let current = 0;    // the group being built
    let heard = false;

    for (const word of words) {
        if (/^\d+(\.\d{1,2})?$/.test(word)) {
            current += parseFloat(word);
            heard = true;
            continue;
        }
        if (SPOKEN_NUMBERS[word] !== undefined) {
            const value = SPOKEN_NUMBERS[word];
            // "four fifty" is 450, not 54. A single digit followed straight by
            // a tens word is how a price is said out loud, and plain addition
            // gets it wrong by a factor of eight. "fifty four" — tens first,
            // then units — is still ordinary addition, and so is
            // "four hundred fifty", where the scale word has already moved
            // `current` out of the single digits.
            if (current >= 1 && current <= 9 && value >= 20 && value % 10 === 0) {
                current = current * 100 + value;
            } else {
                current += value;
            }
            heard = true;
            continue;
        }
        if (SPOKEN_SCALES[word] !== undefined) {
            const scale = SPOKEN_SCALES[word];
            // "two hundred" multiplies what is pending; a bare "hundred" is 100.
            if (scale === 100) current = (current || 1) * 100;
            else { total += (current || 1) * scale; current = 0; }
            heard = true;
            continue;
        }
        // A currency word ends the number, so "forty rupees dinner for two"
        // does not quietly fold the "two" into the amount.
        if (heard && (total + current) > 0 && /^(rupees?|rs|only)$/.test(word)) break;
    }

    if (!heard) return null;
    const rupees = total + current;
    if (!(rupees > 0) || rupees > MAX_AMOUNT) return null;
    return Math.round(rupees * 100) / 100;
}

/** What is left once the amount and its filler words are taken out. */
function stripSpokenAmount(text) {
    const filler = new RegExp('\\b(' +
        Object.keys(SPOKEN_NUMBERS).join('|') + '|' +
        Object.keys(SPOKEN_SCALES).join('|') +
        '|rupees?|rs|only|for|and|spent|paid|add)\\b', 'gi');

    return String(text || '')
        .replace(/\d+(\.\d{1,2})?/g, ' ')
        .replace(filler, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/* ---------------------------------------------------------------------
   The mic
   --------------------------------------------------------------------- */

let voiceRecognition = null;

function showListeningOverlay(onStop) {
    const overlay = document.createElement('div');
    overlay.className = 'listening';
    overlay.id = 'listening-overlay';
    overlay.innerHTML =
        '<div class="listening-card">' +
            '<div class="listening-dot" aria-hidden="true"></div>' +
            '<div class="listening-text">Listening…</div>' +
            '<div class="listening-hint">Try “four fifty swiggy”</div>' +
            '<button type="button" class="btn btn-small btn-secondary"' +
                ' id="listening-stop">Stop</button>' +
        '</div>';
    document.body.appendChild(overlay);
    $('listening-stop').addEventListener('click', onStop);
    return overlay;
}

function hideListeningOverlay() {
    const overlay = $('listening-overlay');
    if (overlay) overlay.remove();
}

/**
 * Listen once, then put what was heard into the quick-add box and let its
 * preview show the interpretation. Nothing is saved here on purpose.
 */
function startVoiceEntry() {
    if (!VOICE_AVAILABLE) {
        showNotification('This browser cannot listen', 'error');
        return;
    }
    if (voiceRecognition) return;      // already listening

    const recognition = new SpeechRecognitionCtor();
    voiceRecognition = recognition;
    recognition.lang = 'en-IN';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    let settled = false;
    function finish() {
        settled = true;
        voiceRecognition = null;
        hideListeningOverlay();
        try { recognition.stop(); } catch (error) { /* already stopped */ }
    }

    showListeningOverlay(finish);

    recognition.onresult = function (event) {
        const said = (event.results && event.results[0] && event.results[0][0] &&
            event.results[0][0].transcript) || '';
        finish();
        if (!said.trim()) {
            showNotification('Did not catch that', 'warning');
            return;
        }

        const amount = parseSpokenAmount(said);
        const description = stripSpokenAmount(said);

        const input = $('quick-add-input');
        // The quick-add box already parses "450 lunch swiggy", matches a type
        // name and shows a preview, so the spoken words are fed through the
        // same path rather than a second one that could disagree with it.
        input.value = [amount !== null ? String(amount) : '', description]
            .filter(Boolean).join(' ').trim();
        updateQuickAddPreview();
        input.focus();

        if (amount === null) {
            showNotification('Heard “' + said + '” — no amount in that, add one',
                'warning', 4200);
        }
    };

    recognition.onerror = function (event) {
        if (settled) return;
        finish();
        const why = {
            'not-allowed': 'Microphone access was refused.',
            'service-not-allowed': 'Microphone access was refused.',
            'no-speech': 'Did not hear anything.',
            'audio-capture': 'No microphone available.'
        };
        showNotification(why[event.error] || 'Could not listen', 'error');
    };

    recognition.onend = function () { if (!settled) finish(); };

    try {
        recognition.start();
    } catch (error) {
        finish();
        showNotification('Could not start listening', 'error');
    }
}

/** Hides the button outright where the API is missing, rather than failing late. */
function initVoiceButton() {
    show('voice-add-btn', VOICE_AVAILABLE, 'inline-flex');
}
