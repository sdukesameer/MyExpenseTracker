# Tests

Two suites. Neither one touches the production database.

```bash
npm run validate     # static checks, no dependencies
npm install          # once, for the browser suite
npm test             # static checks + browser suite
```

## `validate.js` — static cross-file checks

Pure Node, no dependencies, runs in under a second. Catches the class of bug
that only shows up when a user clicks the one button you didn't:

- every `#id` that `script.js` looks up exists in `index.html` (including ids
  the script injects itself)
- every function named in an `onclick=` — in the HTML *and* in markup generated
  by `script.js` — is actually defined
- every `<use href="#…">` icon resolves to a symbol in the sprite
- no duplicate ids
- no regressions to known-bad patterns (`getISTDate`, `readAsBinaryString`, …)
- CSS rules exist for the classes JS toggles at runtime
- every external `<script src>` host is allowed by the CSP in `netlify.toml`

## `smoke.js` — browser suite

Drives real Chrome via `puppeteer-core` (it uses the browser you already have;
set `CHROME_PATH` if it isn't found). `mock-supabase.js` replaces the Supabase
client with an in-memory fake, so the app runs end to end against fixtures.

The clock is pinned to **31 Aug 2026, 19:00 IST** — the exact instant the old
timezone bug rolled the dashboard into September.

Covers: dashboard totals · total budget and pace · simple mode (billing off) ·
all ten modals · charts · export matrix and CSV escaping · insights · search ·
XSS injection · the same instant with the device in `America/Los_Angeles` ·
iPhone 13 Pro Max at 428×926 @3x (overflow, 16px inputs, tap targets, scroll
lock). Any console error, page error, or failed request fails the run.

Screenshots land in `tests/screenshots/`.

### Adding a case

`check(name, condition, detail)` — `detail` is printed only on failure, so put
the actual observed value there.
