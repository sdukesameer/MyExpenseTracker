// Run from the repo root:  node tests/scan.test.js
//
// The parser has to cope with real Tesseract output: prices on their own
// line, ₹ read as "Rs" or "R5", struck-through MRPs, weights that look like
// prices, and rows repeated by the screenshot. Every case below is either a
// real screenshot or a real pasted order.
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

// scan.js is a browser script with no exports. Its parsing half touches
// nothing outside itself, so it runs fine in a bare function scope — the UI
// half only reaches for the DOM once something is called.
const exported = ['parseReceipt', 'scanSummary', 'detectRupeeGlyph'];
const src = fs.readFileSync('scan.js', 'utf8') +
    '\nreturn { ' + exported.join(', ') + ' };';
const { parseReceipt, scanSummary } = new Function('window', src)({});

let fails = 0;
function check(label, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    const ok = g === w;
    if (!ok) fails++;
    console.log((ok ? '  ✓ ' : '  ✗ ') + label +
        (ok ? '' : '\n      got  ' + g + '\n      want ' + w));
}
const brief = r => r.rows.map(x => x.name + '|' + x.qty + '|' + x.totalPaise + '|' + x.kind);

console.log('\n[1] Zepto, amounts on the same line');
let r = parseReceipt([
    'Zepto',
    'Onion 1 kg ₹42',
    'Amul Butter 500 g x2 ₹530',
    'Maggi Noodles 12 pack ₹168',
    'Brown Bread ₹45',
    'Item Total ₹785',
    'Handling Fee ₹12',
    'Delivery Fee ₹25',
    'You saved ₹58',
    'To Pay ₹822'
].join('\n'));
check('4 items + 2 fees', brief(r), [
    'Onion 1 kg|1|4200|item',
    'Amul Butter 500 g|2|53000|item',
    'Maggi Noodles 12 pack|1|16800|item',
    'Brown Bread|1|4500|item',
    'Handling Fee|1|1200|fee',
    'Delivery Fee|1|2500|fee'
]);

console.log('\n[2] Blinkit, price on its own line');
r = parseReceipt([
    'Onion', '1 kg', '₹42',
    'Amul Butter', '500 g', '₹265',
    'Handling Fee', '₹12'
].join('\n'));
check('names joined with their weight line', brief(r), [
    'Onion 1 kg|1|4200|item',
    'Amul Butter 500 g|1|26500|item',
    'Handling Fee|1|1200|fee'
]);

console.log('\n[3] OCR noise: Rs / R5 for ₹, and repeated rows');
r = parseReceipt([
    'Onion 1kg Rs 42',
    'Onion 1kg Rs 42',
    'Tomato 500 g', 'Rs 38',
    'Platform Fee R5 8',
    'MRP ₹49'
].join('\n'));
check('duplicate folded away', brief(r), [
    'Onion 1kg|1|4200|item',
    'Tomato 500 g|1|3800|item',
    'Platform Fee|1|800|fee'
]);
check('one merge reported', r.merged, 1);

console.log('\n[4] struck-through MRP');
check('takes the payable, not the MRP',
    brief(parseReceipt('Amul Milk 500ml ₹32 ₹28')), ['Amul Milk 500ml|1|2800|item']);

console.log('\n[5] a weight must not be read as a price');
check('no price, no row', brief(parseReceipt('Amul Butter 500 g')), []);
check('weight then price', brief(parseReceipt('Basmati Rice 5 kg\n₹560')),
    ['Basmati Rice 5 kg|1|56000|item']);

console.log('\n[6] bare trailing amount, no currency mark');
check('trailing number is the amount',
    brief(parseReceipt('Brown Bread 45\nCurd 400 g 38')), [
        'Brown Bread|1|4500|item',
        'Curd 400 g|1|3800|item'
    ]);

console.log('\n[7] quantity forms');
check('x3 / 2 x / Qty:', parseReceipt([
    'Coke can x3 ₹120',
    '2 x Dairy Milk ₹90',
    'Eggs Qty: 2 ₹130'
].join('\n')).rows.map(x => x.qty), [3, 2, 2]);

console.log('\n[8] a pack size is not a quantity');
check('"12 x 70 g" alone is one item',
    parseReceipt('Maggi 12 x 70 g ₹336').rows.map(x => x.qty + '|' + x.name),
    ['1|Maggi 12 x 70 g']);
check('"x2" after a pack size is the count',
    parseReceipt('Maggi 12 x 70 g x2 ₹336').rows.map(x => x.qty + '|' + x.name),
    ['2|Maggi 12 x 70 g']);
check('"6 x 250 ml" is a pack, not six',
    parseReceipt('Real Juice 6 x 250 ml ₹390').rows.map(x => x.qty), [1]);

console.log('\n[9] app furniture is skipped entirely');
check('no rows survive', brief(parseReceipt([
    'Order ID 88213', 'Delivered to Home', 'GSTIN 29ABCDE',
    'Sub Total ₹500', 'You saved ₹40', 'Grand Total ₹520',
    'Paid via UPI', 'Thank you for shopping'
].join('\n'))), []);

console.log('\n[10] fees are recognised, and sorted after items');
check('items first, then fees', brief(parseReceipt([
    'Handling Fee ₹12', 'Onion ₹42', 'GST ₹6', 'Tomato ₹38', 'Tip ₹20'
].join('\n'))), [
    'Onion|1|4200|item',
    'Tomato|1|3800|item',
    'Handling Fee|1|1200|fee',
    'GST|1|600|fee',
    'Tip|1|2000|fee'
]);

console.log('\n[11] a Blinkit screenshot where OCR lost the rupee sign');
// Every ₹ came back as a "2", so ₹35 read as 235 and a ₹469 basket totalled
// ₹53,727. The thumbnails became junk in front of the names, the order number
// became an item, and the struck-out MRP under each row became a second one.
r = parseReceipt([
    '2:14 7.00 KB/S',
    'Order #HGTKKOIU49669',
    '10 items',
    'Get Help',
    '10 items in order',
    '& Bottle Gourd 235',
    '1pc + 1 unit 299',
    '© ..& Tomato Local 226',
    '500 g + 1 unit 263',
    '& Capsicum Green 226',
    '250 - 275 g + 1 unit 257',
    'Banana Raw 211',
    '2 pcs + 1 unit 228',
    'Amul Taaza Toned Fresh Milk | Pouch 230',
    '1 pack (500 ml) + 1 unit',
    't3 Baby Apple Shimla 2178',
    '500 g + 1 unit 2216',
    '&7 Spinach (Palak) 234',
    '250 g + 1 unit 267',
    '2 Organically Grown Lady Finger 224',
    '250 g + 2 units 264',
    'Ganesh Whole Wheat Chakki Pure Atta | 252',
    'No Maida 256',
    '1 pack (1 kg) + 1 unit',
    'Ovo Farms On-Day White Eggs 253',
    '1 pack (6 pcs) + 1 unit 280',
    'Rate Order Order Again'
].join('\n'));
check('the misread rupee sign is identified', r.glyph, '2');
check('prices as actually printed, not as read', brief(r), [
    'Bottle Gourd|1|3500|item',
    'Tomato Local|1|2600|item',
    'Capsicum Green|1|2600|item',
    'Banana Raw|1|1100|item',
    'Amul Taaza Toned Fresh Milk Pouch|1|3000|item',
    'Baby Apple Shimla|1|17800|item',
    'Spinach (Palak)|1|3400|item',
    'Organically Grown Lady Finger|1|2400|item',
    'Ganesh Whole Wheat Chakki Pure Atta No Maida|1|5200|item',
    'Ovo Farms On-Day White Eggs|1|5300|item'
]);

console.log('\n[12] the summary that lands in the note');
const rows = [
    { name: 'Milk Maid', qty: 2 },
    { name: 'Potato', qty: 1 },
    { name: 'Handling Fee', qty: 1 }
];
check('name ×count, joined with +', scanSummary(rows, 500),
    'Milk Maid ×2 + Potato ×1 + Handling Fee ×1');

const many = Array.from({ length: 30 }, (_, i) => ({ name: 'Item Number ' + i, qty: 1 }));
const long = scanSummary(many, 500);
check('never exceeds the note column', long.length <= 500, true);
check('the remainder is counted, not cut off', /\+ \d+ more$/.test(long), true);

const wordy = [{ name: 'A'.repeat(80), qty: 3 }];
check('one very long name is trimmed, not dropped',
    scanSummary(wordy, 500), 'A'.repeat(39) + '… ×3');

console.log(fails === 0
    ? '\n✅ All scan checks passed\n'
    : '\n❌ ' + fails + ' problem(s)\n');
process.exit(fails ? 1 : 0);
