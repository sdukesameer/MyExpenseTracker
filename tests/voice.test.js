// Run from the repo root:  node tests/voice.test.js
//
// Speech comes back as words at least as often as digits, and the two get
// mixed inside one utterance. Every case here is something a phone actually
// returns for an Indian English speaker saying an amount out loud.
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

// voice.js is a browser script with no exports. Its parsing half touches
// nothing but its own tables; the recording half only reaches for the DOM
// once something is called.
const src = fs.readFileSync('voice.js', 'utf8') +
    '\nreturn { parseSpokenAmount, stripSpokenAmount, VOICE_AVAILABLE };';
const { parseSpokenAmount, stripSpokenAmount } =
    new Function('window', 'MAX_AMOUNT', src)({}, 1000000);

let fails = 0;
function check(label, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    const ok = g === w;
    if (!ok) fails++;
    console.log((ok ? '  ✓ ' : '  ✗ ') + label +
        (ok ? '' : '\n      got  ' + g + '\n      want ' + w));
}

console.log('\n[1] digits, however they arrive');
check('plain digits', parseSpokenAmount('450 swiggy'), 450);
check('with a currency word', parseSpokenAmount('450 rupees swiggy'), 450);
check('decimals survive', parseSpokenAmount('45.50 chai'), 45.5);

console.log('\n[2] spoken words');
check('"forty"', parseSpokenAmount('chai forty rupees'), 40);
// The one that plain addition gets wrong by a factor of eight.
check('"four fifty" is 450, not 54', parseSpokenAmount('four fifty swiggy'), 450);
check('"two thirty" is 230', parseSpokenAmount('two thirty auto'), 230);
check('"fifty four" is still 54', parseSpokenAmount('fifty four rupees'), 54);
check('"twenty five" is still 25', parseSpokenAmount('twenty five chai'), 25);
check('"four hundred fifty" is unaffected', parseSpokenAmount('four hundred fifty'), 450);
check('"two hundred fifty"', parseSpokenAmount('two hundred fifty dinner'), 250);
check('a bare "hundred" is 100', parseSpokenAmount('hundred rupees petrol'), 100);
check('"two thousand"', parseSpokenAmount('two thousand rent'), 2000);
check('"one lakh"', parseSpokenAmount('one lakh deposit'), 100000);
check('"fourty" spelled the common wrong way', parseSpokenAmount('fourty rupees'), 40);

console.log('\n[3] a currency word ends the number');
// Without this, "for two" folds a 2 into the amount that nobody said.
check('"forty rupees dinner for two" is 40',
    parseSpokenAmount('forty rupees dinner for two'), 40);

console.log('\n[4] nothing to find');
check('no number at all', parseSpokenAmount('lunch at the office'), null);
check('empty', parseSpokenAmount(''), null);
check('over the cap is refused', parseSpokenAmount('nine crore'), null);

console.log('\n[5] what is left is the description');
check('digits and filler stripped',
    stripSpokenAmount('450 rupees for swiggy'), 'swiggy');
check('spoken numbers stripped',
    stripSpokenAmount('chai forty rupees'), 'chai');
check('scale words stripped',
    stripSpokenAmount('two hundred fifty dinner'), 'dinner');
check('nothing but an amount leaves nothing',
    stripSpokenAmount('four fifty rupees'), '');
check('the description is left alone otherwise',
    stripSpokenAmount('300 office lunch with the team'), 'office lunch with the team');

console.log('\n[6] the pair, on one utterance');
const said = 'spent four hundred fifty rupees on swiggy';
check('amount', parseSpokenAmount(said), 450);
check('description', stripSpokenAmount(said), 'on swiggy');

console.log(fails === 0
    ? '\n✅ All voice checks passed\n'
    : '\n❌ ' + fails + ' problem(s)\n');
process.exit(fails ? 1 : 0);
