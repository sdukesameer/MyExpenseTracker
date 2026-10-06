# 💰 My Expense Tracker

A comprehensive, feature-rich expense tracking web application built with vanilla JavaScript and Supabase backend. Track your daily expenses with advanced analytics, budget management, data visualization, and intelligent insights.

[![Live Demo](https://img.shields.io/badge/Live-Demo-blue?style=for-the-badge)](https://your-demo-url.com)
[![GitHub Stars](https://img.shields.io/github/stars/sdukesameer/myExpenseTracker?style=for-the-badge)](https://github.com/sdukesameer/myExpenseTracker)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

## 🆕 What's new in 1.2

**Removed — on-device OCR.** Tesseract is gone entirely, not kept as a
fallback. It read the ₹ symbol as a digit and lost decimal points, turning
₹100.00 into ₹10,000, and a total wrong by a hundredfold saved without anyone
noticing which reader produced it is worse than no scan. That deleted 486
lines, a test file and four CSP entries.

**New — six cloud readers, and model names that keep themselves current.**
Gemini, Groq, Mistral, OpenRouter, OpenAI and Claude. Each provider's model
list is fetched live and filtered by what the provider publishes about each
model, then sorted newest-first by the digits in the id — so a new version
gets picked up with no code change. Proven in testing: the committed list said
`gemini-3.6-flash`, discovery found and used `gemini-3.8-flash`.

**New — the scanner names its reader.** *Read by Gemini · gemini-3.8-flash*
sits above the item list, because when a scan comes out wrong the first useful
question is which model read it.

**Superseded — the scanner has three cloud readers.** Gemini, then OpenAI, then
Claude; the first that answers wins, and a provider that is out of quota is
skipped for a minute instead of costing a round trip. When *all* of them fail
the scanner asks what to do — naming which declined and why, with a countdown
on *Try again* — rather than silently dropping to on-device OCR, which reads
the ₹ sign as a digit and turns ₹100.00 into ₹10,000.

**New — step through months on the heatmap.** The daily-spend calendar in
Spending Insights has `‹` and `›` either side of the title. Back stops at your
earliest expense, forward stops at the current month, and the legend now
carries that month's total. A completed month counts all of its days rather
than stopping at today's date, so July does not read as "3 of 31" when it is
actually finished.

**New — paste from Excel.** Open *Import Expenses*, copy the cells out of
Excel, Sheets or Numbers, and press Ctrl+V. No saving to a file first. The
clipboard carries them as tab-separated text, which the spreadsheet library
already loaded for the file path parses, so there is one code path and one set
of rules.

**Changed — import takes an export.** Same column names, same order
(`Date, Type, Note, Amount, Billed`), and the importer now accepts ISO dates,
decimal amounts and `Yes`/`No` alongside the old `DD/MM/YYYY`,
whole numbers and `Billed`/`Unbilled`. Columns were always matched by name, so
any order still works.

**New — speak an expense.** A mic beside the quick-add box. Say
*"four fifty swiggy"* and it lands in the box, parsed, for you to check and
tap Add. Spoken numbers are handled properly: `"four fifty"` is ₹450, not ₹54,
and `"fifty four"` is still ₹54. Nothing is filed by voice alone — speech
recognition mishears amounts, and ₹4,500 logged instead of ₹450 is worse than
one more tap. Where the browser has no Web Speech API the button never
appears.

**New — quick add ignores word order.** `450 swiggy`, `swiggy 450` and
`office 450 lunch swiggy` all read the same: the number is the amount wherever
it sits, the words matching one of your types are the type wherever they sit,
and what is left is the summary. Multi-word type names match whole.
`45 uber` picks up whatever you filed the last Ubers under. Anything else
falls back to the smoothed guess across every word.

**Changed — the chips under Amount are your own amounts.** Once a type or note
is known they show what you have actually spent on it — tap to set, not to add.
`+50/+100/+200/+500` remain as the fallback when there is nothing to go on.

**New — `+` and `−` keys beside the amount.** The field has always accepted
`120+80+45`, but a phone's decimal keypad has neither operator, so the
calculator was desktop-only.

**New — [scan a receipt](#-receipt-scanning).** Read a Zepto/Blinkit/Instamart/
Swiggy order screenshot into an editable list, untick what you do not want, and
the kept lines are summed into the amount and written into the note as
`Milk Maid ×2 + Potato ×1`.

**New — [it works offline](#-offline).** There is a service worker now, so the
app opens with no signal, and an expense added while offline is queued on the
device and sent when the connection comes back. Queued rows show as PENDING and
count towards the month's totals, so adding something offline no longer looks
like it did nothing.

**New — duplicate warning.** Adding an expense with the same amount, type and
date as one already logged asks first. Only the three routes where you type an
expense are checked; Repeat, recurring rules and CSV import are not, because
repeating is the point of all three.

**New — [an admin panel](#-admin).** Behind a flag on a real account: see
everybody, read their expense log, block an address, close signups or make the
app invite-only, create or invite accounts, reset a password, and sign in as
somebody. Every action is written to an append-only audit log. Needs one
migration and two Netlify environment variables — nothing changes until you
run them.

**Changed — edit from Recent Expenses.** Inline editing was only in Analytics.
Both lists now use the same editor, each with its own Save button.

**Changed — filters apply themselves.** The Apply Filter button is gone;
changing a date, type or billing filter re-runs it.

**Changed — one export.** Export CSV is gone. Excel keeps every format the CSV
had, including the totals and budget rows.

**Changed — Change Password moved.** It was its own item in the user menu, next
to five other things you might actually want. It now lives inside Edit Profile,
where you were already going to change your details.

## 🆕 What's new in 1.1

**Fixed — timezone.** The dashboard used to roll over to the next day at
18:30 IST, because it added a +05:30 offset to a `Date` and then read *local*
getters off it (a double shift on an IST device). On the last evening of a
month the whole dashboard jumped to the next month: the budget vanished and
the monthly totals reset to zero. All date maths now runs on `YYYY-MM-DD`
strings anchored to Asia/Kolkata — see [How dates are handled](#️-how-dates-are-handled).

**New — total budget.** Billed + unbilled now roll up into a single headline
budget with its own progress bar, remaining balance, and a daily pace figure
("₹1,240/day for 9 days").

**New — simple mode.** Settings → *Track billed / unbilled separately*. Turn
it off and the billing concept disappears from the entire UI: one total budget,
no billing toggle, no badges, no billing filter. New expenses save as unbilled.
Existing data is untouched, and turning it back on restores the split view.

**New — quick add.** Three things that remove typing, all derived from data
you already have:

- **One-tap presets.** Any (note, amount, type) you've repeated becomes a chip
  — `Chai ₹20`, `Team lunch ₹250`. One tap files it, with an undo.
- **Natural language.** Type `450 lunch swiggy` or `1.2k flight blr`. The
  amount is parsed, and the category is inferred by a small Naive Bayes model
  trained on **your own notes** — no server, no download, better the more you
  log. If it can't recognise a word it leaves the type blank and asks rather
  than guessing wrong on a money record.
- **Maths in the amount box.** `120+80+45` → `245`.

**New — recurring expenses.** Rent, EMIs, subscriptions. Due items are offered
on the dashboard each month; you add or skip. Never inserted behind your back.

**New — budget alert levels.** Budget → *Alerts*. Add as many thresholds as you
like, each scoped to **total**, **billed** or **unbilled** — 50% of total, 100%
of billed, whatever you want. Each fires one toast per month, and only the
highest level crossed per scope fires, so one big expense doesn't set off four
toasts at once.

**New — month heatmap.** A calendar of the current month in Spending Insights,
shaded by daily spend on a square-root scale so one rent payment doesn't flatten
every other day. Blank squares are days you logged nothing.

**New — full JSON backup.** Settings → *Download backup*. Everything, unfiltered.

Also: Indian digit grouping (₹1,23,456), undo for deletes, one-tap repeat of a
past expense, quick amount and date chips, Excel export, per-category colours,
search highlighting, keyboard shortcuts (`/`, `n`, `Esc`), a rebuilt light/dark
theme, and a set of iOS Safari fixes. See the full list at the end of this file.

## ✨ Key Highlights

- **🔐 Complete User Authentication System** with secure password reset & email change
- **💰 Advanced Budget Management** with separate billed/unbilled tracking
- **📊 Rich Data Visualization** with 4 different chart types
- **🔍 Powerful Search & Filtering** with real-time expense search
- **📈 Spending Insights & Analytics** with trend analysis
- **🎨 Modern Responsive UI** with dark/light theme toggle
- **📱 Mobile-First Design** optimized for all devices
- **📤 Smart Data Export** to Excel, with budget summaries
- **⚡ Real-Time Updates** with instant notifications

## 🚀 Feature Overview

### 🔐 **Authentication & Security**
- **Complete Auth Flow** - Sign up, sign in, email verification, password reset
- **Secure Email Change** - Verification sent to both old and new email addresses
- **Password Management** - Change password with validation and forced reset support
- **Profile Management** - Edit display name and email with real-time validation
- **Session Management** - Auto-login, secure logout from all devices
- **Security Features** - Row Level Security, input sanitization, CSRF protection

### 📴 **Offline**
- **Opens without a network** - a service worker caches the app shell
- **Queued writes** - expenses added offline are held in IndexedDB and sent on reconnect
- **Nothing is hidden** - queued rows show as PENDING and count towards totals and the budget

### 🛡️ **Admin**
- **See everybody** - accounts, spend, expense counts, and any one person's full log
- **Control who may sign up** - close registration entirely, or go invite-only with an allow list
- **Block an address** - signs them out everywhere and stops them registering again
- **Act as somebody** - a single-use sign-in link for support, recorded in the audit log
- **Append-only audit** - every admin action, with who did it and when

### ⚡ **Quick Entry**
- **Speak it** - "four fifty swiggy" via the Web Speech API, on-device, no key needed
- **Type it short** - `450 swiggy`, `45 uber`, `120+80 dinner`
- **Type resolution** - an exact type name, then your own history, then a smoothed guess
- **Amount suggestions** - the amounts you have actually spent on this type or note
- **A calculator that works on a phone** - `+` and `−` keys for a keypad that has neither

### 💳 **Expense Management** 
- **Quick Entry Form** - Add expenses with amount, type, date, notes, and billing status
- **Inline Editing** - Edit expense details directly in the list with real-time validation
- **Bulk Operations** - Save multiple expense edits simultaneously
- **Billed/Unbilled Toggle** - Track reimbursable vs personal expenses
- **Smart Validation** - Amount limits (₹1 to ₹10,00,000), required fields, character limits
- **Scan a receipt** - Read a Zepto/Blinkit/Instamart/Swiggy order screenshot, tick what counts, and prefill the form (see [Receipt scanning](#-receipt-scanning))
- **Auto-prefill** - SMS integration support for automatic amount entry
- **Delete Protection** - Confirmation dialogs for destructive actions
- **Duplicate warning** - the same amount, type and date twice in one day asks first

### 🏷️ **Category Management**
- **Custom Expense Types** - Add, edit, delete, and manage expense categories
- **Default Categories** - Pre-populated with common expense types for new users
- **Usage Validation** - Prevents deletion of categories in use
- **Type Statistics** - Track spending by category with visual breakdowns

### 📊 **Advanced Analytics & Visualization**
- **Multiple Chart Types**:
  - **Pie Charts** - Category distribution
  - **Doughnut Charts** - Enhanced category visualization
  - **Line Charts** - Cumulative expense trends over time
  - **Bar Charts** - Category comparisons (vertical)
  - **Horizontal Bar Charts** - Alternative category view
  - **Bubble Charts** - Amount vs frequency analysis
- **Interactive Filtering**:
  - Date range selection with calendar picker
  - Billing status filter (All/Billed/Unbilled)
  - Category-specific filtering
  - Real-time chart updates
- **Chart Interactivity** - Hover effects, tooltips, and responsive design

### 💰 **Comprehensive Budget Management**
- **Separate Budgets** - Independent tracking for billed and unbilled expenses
- **Monthly Budget Setting** - Set different budgets for each month
- **Visual Progress Bars** - Color-coded progress indicators (green/orange/red)
- **Smart Alerts** - Notifications at 90% and 100% budget usage
- **Budget Analytics** - Remaining balance calculations with percentages
- **Historical Budgets** - Month-by-month budget tracking
- **Export Integration** - Budget information included in the Excel export

### 🔍 **Search & Discovery**
- **Real-Time Search** - Instant search across all expense fields
- **Multi-field Search** - Search by note, category, amount, or date
- **Search Results** - Highlighted matches with total calculations
- **Quick Access** - Searchable expense history with no date limitations

### 📈 **Spending Insights**
- **Monthly Comparisons** - Current vs previous month analysis
- **Trend Analysis** - Percentage change calculations
- **Category Rankings** - Top spending categories identification
- **Daily Averages** - Average daily spending with monthly projections
- **Transaction Analytics** - Average per transaction, highest/lowest expenses
- **Spending Patterns** - Expense frequency and amount correlation

### 🎨 **Modern User Interface**
- **Responsive Design** - Optimized for desktop, tablet, and mobile
- **Dark/Light Themes** - Toggle with persistent user preference
- **Smooth Animations** - Micro-interactions and hover effects
- **Loading States** - Spinner and progressive loading indicators
- **Modern Typography** - Inter font for enhanced readability
- **Gradient Designs** - Beautiful color gradients throughout the interface
- **Notification System** - Toast notifications for user feedback

### 📤 **Data Export & Backup**
- **Comprehensive Excel Export** - All expense data with filtering support
- **Smart Filename Generation** - Date range and filter-based naming
- **Budget Integration** - Budget information included in monthly exports
- **Flexible Exports** - Custom date ranges, billing status, and category filtering
- **Data Totals** - Automatic calculation summaries in exports

### 🏗️ **Technical Features**
- **Progressive Web App** - Installable with offline capabilities
- **Real-time Updates** - Instant data synchronization
- **Error Handling** - Comprehensive error management with user feedback
- **Input Validation** - Client and server-side validation
- **Data Sanitization** - XSS protection and input cleaning
- **Performance Optimization** - Efficient queries and caching strategies

## 🛠️ Technology Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript (ES6+)
- **Backend**: Supabase (PostgreSQL + Auth + Real-time subscriptions)
- **Charts**: Chart.js v3 for interactive data visualization
- **Styling**: Custom CSS with CSS Grid, Flexbox, and CSS Variables
- **Authentication**: Supabase Auth with email verification
- **Database**: PostgreSQL with Row Level Security (RLS)
- **PWA**: Web App Manifest plus a service worker — installable, and it opens offline
- **Offline writes**: IndexedDB outbox, flushed on reconnect
- **Serverless**: Netlify Functions for the receipt reader and the admin auth actions

## 📱 Installation & Setup

### Prerequisites
- Modern web browser with JavaScript enabled
- Supabase account for backend services

### Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/sdukesameer/myExpenseTracker.git
   cd myExpenseTracker
   ```

2. **Set up Supabase Backend**
   - Create a new project at [Supabase](https://supabase.com)
   - Run the SQL setup script (see Database Schema below)
   - Get your project URL and anon key from Settings > API

3. **Point it at your project** — edit [`config.js`](config.js), or set
   `SUPABASE_URL` and `SUPABASE_ANON_KEY` in Netlify and let the build
   rewrite it. See [Configuration](#-configuration).

   ```js
   window.APP_CONFIG = {
       SUPABASE_URL: 'https://your-project.supabase.co',
       SUPABASE_PROXY_URL: '',
       SUPABASE_ANON_KEY: 'your-publishable-key'
   };
   ```

4. **Deploy**
   - Upload to your web server
   - Or use GitHub Pages, Netlify, Vercel for instant deployment

## 🗄️ Database Schema

### Complete Supabase Setup

```sql
-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Expenses table
CREATE TABLE expenses (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL CHECK (amount > 0 AND amount <= 1000000),
    type TEXT NOT NULL,
    note TEXT,
    date DATE NOT NULL,
    billed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Expense Types table
CREATE TABLE expense_types (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, name)
);

-- User Budgets table (Updated schema)
CREATE TABLE user_budgets (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    monthly_billed_budget DECIMAL(10,2) NOT NULL DEFAULT 0,
    monthly_unbilled_budget DECIMAL(10,2) NOT NULL DEFAULT 0,
    budget_month INTEGER NOT NULL CHECK (budget_month >= 1 AND budget_month <= 12),
    budget_year INTEGER NOT NULL CHECK (budget_year >= 2020),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, budget_month, budget_year)
);

-- User Profiles table
CREATE TABLE user_profiles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    requires_password_reset BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for better performance
CREATE INDEX idx_expenses_user_id_date ON expenses(user_id, date DESC);
CREATE INDEX idx_expenses_user_id_type ON expenses(user_id, type);
CREATE INDEX idx_expenses_user_id_billed ON expenses(user_id, billed);
CREATE INDEX idx_expense_types_user_id ON expense_types(user_id);
CREATE INDEX idx_user_budgets_user_month_year ON user_budgets(user_id, budget_year, budget_month);
```

### Row Level Security (RLS) Policies

```sql
-- Enable RLS on all tables
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Expenses policies
CREATE POLICY "Users can manage own expenses" ON expenses 
    FOR ALL USING (auth.uid() = user_id);

-- Expense types policies
CREATE POLICY "Users can manage own expense types" ON expense_types 
    FOR ALL USING (auth.uid() = user_id);

-- User budgets policies
CREATE POLICY "Users can manage own budgets" ON user_budgets 
    FOR ALL USING (auth.uid() = user_id);

-- User profiles policies
CREATE POLICY "Users can manage own profile" ON user_profiles 
    FOR ALL USING (auth.uid() = user_id);
```

### Default Data Insertion

```sql
-- Function to create default expense types for new users
CREATE OR REPLACE FUNCTION create_default_expense_types()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO expense_types (user_id, name)
    VALUES 
        (NEW.id, 'Food'),
        (NEW.id, 'Transportation'),
        (NEW.id, 'Entertainment'),
        (NEW.id, 'Utilities'),
        (NEW.id, 'Shopping'),
        (NEW.id, 'Healthcare'),
        (NEW.id, 'Education'),
        (NEW.id, 'Other');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically create default types for new users
CREATE TRIGGER create_default_types_trigger
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION create_default_expense_types();
```

### Optional migration — recurring expenses

Rent, EMIs and subscriptions. Until you run this, the feature hides itself and
the *Recurring Expenses* window shows you the same SQL with a copy button.
Nothing is ever inserted automatically — due items are *offered* on the
dashboard and you add or skip each one.

```sql
CREATE TABLE IF NOT EXISTS recurring_expenses (
    id               BIGSERIAL PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    amount           DECIMAL(10,2) NOT NULL CHECK (amount > 0 AND amount <= 1000000),
    type             TEXT NOT NULL,
    note             TEXT NOT NULL,
    billed           BOOLEAN NOT NULL DEFAULT FALSE,
    day_of_month     SMALLINT NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    last_added_year  INTEGER,
    last_added_month SMALLINT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE recurring_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own recurring expenses"
    ON recurring_expenses FOR ALL USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_recurring_user
    ON recurring_expenses(user_id, active);
```

A day-31 rule lands on the 28th/30th in shorter months, and each rule is
stamped with the year/month it was last handled so it never double-books.

### Optional migration — the admin panel

[`supabase/admin.sql`](supabase/admin.sql), applied once. Until you run it the
Admin item never appears and nothing else changes. See [Admin](#-admin).

### Optional migration — cross-device settings

The app works without this. Per-user preferences (billed tracking on/off,
default billing status, budget alerts) are stored in `localStorage` and will
also sync to your account if this column exists:

```sql
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
```

Without the column the app silently falls back to device-local storage, so
settings simply won't follow you to a second device.

## ⏱️ How dates are handled

Expense dates are plain `DATE` values (`YYYY-MM-DD`) representing **calendar
days in India (Asia/Kolkata)**, independent of the device's clock.

All date maths in `script.js` operates on those date *strings* via the helpers
at the top of the file (`todayISO`, `monthBounds`, `addDaysISO`, `splitISO`,
`withinRange`). Do not build a `Date` from a stored date and read local getters
off it — that shifts the day for anyone outside IST, and the "add an offset then
read local getters" trick double-shifts for anyone inside it.

```js
todayISO();                  // '2026-08-31' in Asia/Kolkata, on any device
monthBounds(2026, 8);        // { first: '2026-08-01', last: '2026-08-31' }
withinRange(e.date, f, l);   // plain string comparison — no timezone involved
```

## 🧾 Receipt scanning

*Add New Expense → **Scan receipt***. Pick one or more screenshots of a
grocery or food order, and the reader turns them into an editable list of
lines. Untick anything you did not want, correct any count or amount, and
press **Use these items** — the kept lines are summed into the amount field
and written into the note as

```
Milk Maid ×2 + Potato ×1 + Handling Fee ×1
```

Nothing is saved by the scanner. It fills the form; you still review it and
press *Add Expense*. There is no image storage on either path.

### The readers

There is **no on-device fallback any more**. Tesseract was removed outright,
not demoted: it reads the ₹ symbol as a digit and loses decimal points, so
₹100.00 becomes ₹10,000. A total wrong by a factor of a hundred, saved without
anyone noticing which reader produced it, is worse than a scanner that admits
it cannot read the receipt today. Removing it deleted 486 lines, a test file
and four CSP entries.

Providers are tried in order, first answer wins:

| | Free tier | Tested |
|---|---|---|
| **Gemini** | yes | ✅ 14/14 exact, 6/6 scans, no rate limit hit |
| **Groq** | yes | ⚠️ no vision model in its catalogue today — correctly skipped |
| **Mistral** | yes | ⚠️ instant 429 on this account's free tier |
| **OpenRouter** | `:free` models | ⚠️ 429, shared upstream pool is saturated |
| **OpenAI** | no | paid |
| **Claude** | no | paid |

### Model names keep themselves current

This is the part that used to need hand-editing every few months. Nothing here
names a model as gospel:

1. Each provider's model list is **fetched live** and filtered by what the
   provider itself publishes about each model — Mistral's `capabilities.vision`,
   OpenRouter's `architecture.input_modalities` plus `pricing.prompt == 0`,
   Gemini's `supportedGenerationMethods`. Name-matching is the last resort, for
   the providers that publish nothing (OpenAI, Groq).
2. Survivors are sorted by **the digits in the id**, newest first — so
   `gemini-3.8-flash` beats `gemini-3.6-flash`, and `claude-haiku-4-5-20251001`
   beats the same model's older snapshot, with nobody editing a list.
3. If discovery works and finds **nothing** that can see an image, the provider
   is skipped rather than wasting round trips on stale names. That is exactly
   what happens to Groq today.
4. `GEMINI_MODEL`, `GROQ_MODEL`, … pin one model and skip discovery entirely.

Live proof: the committed fallback list said `gemini-3.6-flash`; discovery
found and used `gemini-3.8-flash` without a code change.

### Picking a model: smallest that can do the job, not newest

Measured against a real 14-item Blinkit screenshot:

| | Time | Score |
|---|---|---|
| `gemini-3.5-flash-lite` | **3s** | 14/14 exact |
| `gemini-3.8-flash` | — | `503` every time |

The newest flagship is also the one everyone else is queuing for. Reading a
receipt is not frontier work, so candidates are ordered **small first, newest
among equals** — and whatever actually returned rows last time is tried ahead
of everything, so a warm function goes straight to the model it knows works.

That alone took a scan from 13–21 seconds (occasionally 68) to **under three**.

### What testing found

- **Accuracy.** 14/14 exact across every run — the paid price rather than the
  struck MRP, `Lady Finger ×2` as a quantity rather than a pack size, both
  FREE fees correctly left out. ₹792 to the rupee.
- **Multiple images work.** 2, 3 and 5 screenshots in one scan all succeed,
  and the model deduplicates: the same image sent five times still returned 14
  rows, not 70.
- **Rate limits are generous; contention is the problem.** Four scans back to
  back, 1.9–3.2s each, no limit hit. What used to cost twenty seconds was
  queuing behind the flagship model, not quota.
- **Racing the candidates is worse than ordering them.** Firing four models at
  once to see which answers first burned the per-minute quota in one scan and
  got everything rate-limited. Serial, well ordered, wins.
- **503 is per-model, 429 is per-key.** An overloaded model says nothing about
  its siblings, so a 503 advances the model while a 429 cools the provider.
- **"No credits" is not a rate limit.** OpenAI returns both as 429. Waiting
  sixty seconds does not add money to an account, so the two are told apart —
  one cools for a minute, the other for an hour and says what is wrong.
- **Netlify kills a synchronous function at 10s**, and that is *not*
  configurable from `netlify.toml` — a `timeout` key there is a parse error
  that fails the build. The chain keeps a 9s budget instead, enforced per
  attempt rather than only between them.
- **Scale screenshots by width, not longest side.** A 714×2576 receipt fitted
  to 1600 on its longest side comes out 443px wide, throwing away the
  dimension the text lives in and keeping the one that does not matter.

`GET /.netlify/functions/scan?diagnose=1` lists every provider, whether it is
configured, the models it will actually try today in order, and any cooldown
still running. That is the one call to make when a scan picks a model you did
not expect.

### What the parser has to survive

`scan.js` is deliberately forgiving, because real screenshots are not clean.
It handles prices on their own line (Blinkit/Zepto layout), struck-through
MRPs (the payable amount is the smaller of the two), pack sizes that look like
quantities (`12 x 70 g` is one item, `x2` is two), weights that look like
prices (`500 g`), product thumbnails read as junk before the name, wrapped
product names, rows duplicated by overlapping screenshots, and app furniture
(order ids, totals, "you saved", delivery times).

The one worth knowing about: **Tesseract has never been shown a ₹**, so it
substitutes the nearest glyph it knows — consistently, within one screenshot.
On a Blinkit order every ₹ comes back as a `2`, which turns ₹35 into 235 and a
₹469 basket into ₹53,727. `detectRupeeGlyph()` spots this across the whole
document (no real currency mark anywhere, every amount in the column carrying
the same stray leading character) and undoes it, then says so in a banner
above the list.

`node tests/scan.test.js` covers all of the above against real receipts.

## ⚡ Quick entry

Three ways into the same parser, so they cannot disagree with each other.

### Word order carries no meaning

Each part is identified by what it **is**, not by where it sits:

| | |
|---|---|
| **amount** | the first token that reads as a number or a sum, anywhere in the line |
| **type** | the run of words matching one of your types, anywhere in the line |
| **summary** | everything left over, in the order you typed it |

```
450 swiggy               ₹450 · Swiggy · "Swiggy"        addable as it stands
swiggy 450               ₹450 · Swiggy · "Swiggy"        same thing, backwards
office 450 lunch swiggy  ₹450 · Swiggy · "office lunch"  the type is plucked out
dinner 120+80            ₹200 · …      · "dinner"        sums work mid-line too
45 uber                  ₹45  · Travel · "uber"          however you filed the last Ubers
300 personal care soap   ₹300 · Personal Care · "soap"   multi-word types match whole
450 food travel          ₹450 · Food   · "travel"        see below
```

**One word** that names a type becomes the type, and its proper spelling
becomes the summary too — otherwise the entry would fail validation on a blank
description. A word that names no type is just the summary.

**Two words where both name types** — `450 food travel` — is genuinely
ambiguous. The **first** is taken as the type and the rest becomes the
summary, on the grounds that you named the category before describing the
thing. Longer type names win over shorter ones inside them, so a type called
*Personal Care* beats a type called *Care*.

The type is resolved in order of how sure the app can be:

1. **Words that ARE one of your types**, case-insensitive, contiguous, up to
   four of them. No guessing. They are dropped from the note, since
   *"Swiggy · Swiggy"* describes nothing — unless they are all you typed, in
   which case they become the note so the entry passes validation.
2. **A word you have used in a note before**, filed the way you filed it last
   time. This is what makes `45 uber` work.
3. **`inferType()`**, a smoothed guess across every token.

### Speaking it

The mic beside *Add* uses the Web Speech API — free, on-device on iOS, and
absent from some browsers, in which case the button is not rendered at all.

Spoken numbers are their own small problem. `"four fifty"` is how a price is
said out loud and means ₹450; plain word-by-word addition gives 54, which is
wrong by a factor of eight. So a single digit followed straight by a tens word
is read as hundreds, while `"fifty four"` and `"twenty five"` stay ordinary
addition. A currency word ends the number, so *"forty rupees dinner for two"*
does not fold the "two" into the amount.

What is heard goes **into the quick-add box**, not into the database. You see
the parse before it is filed. `node tests/voice.test.js` covers the number
parsing.

### The amount field

The chips underneath are drawn from what you have actually spent, weighted so
the note counts for three times the type — *"office lunch"* tells you more
than *"Food"* does. Tap one to **set** the amount. With no history to draw on
they fall back to `+50/+100/+200/+500`.

`120+80+45` has always worked in that field, but `inputmode="decimal"` gives a
keypad with no `+` or `−`, so the calculator was desktop-only. The two keys
beside the field supply them; pressing the second swaps the operator rather
than stacking it.

## 📴 Offline

`sw.js` caches the app shell, so the app opens with no signal. `offline.js`
holds writes that cannot reach Supabase in an IndexedDB outbox and sends them
when it can.

Only the *write* path is queued — reads still need a connection. What happens
with no signal:

| | Offline |
|---|---|
| Opening the app | Works, from the cached shell |
| Adding an expense | Queued, shown as PENDING, counted in the month's totals and budget |
| The queued row | Editable only by discarding it; there is no database row to edit yet |
| Everything else | Needs a connection, and says so rather than showing zeroes |

The queue drains on `online`, when a backgrounded tab becomes visible again,
on the next sign-in, and when you tap the chip in the header. A row the server
*refuses* — rather than one that could not be sent — is dropped and reported,
because retrying it forever would block everything behind it.

**On every deploy, bump `CACHE` in [`sw.js`](sw.js).** The old shell is deleted
on activate, so a stale `script.js` can never outlive the `index.html` that
points at it.

## 🛡️ Admin

Hidden entirely until an account has the flag, and off by default. Three steps,
in this order:

**1. Run the migration.** Apply [`supabase/admin.sql`](supabase/admin.sql) in
the Supabase SQL editor. It is safe to re-run. It adds `email`, `full_name` and
`is_admin` to `user_profiles`, creates `app_settings`, `banned_emails`,
`allowed_emails` and `admin_audit`, and replaces the signup trigger with one
that also enforces the block list and the signup switches.

**2. Make yourself an admin.**

```sql
select public.grant_admin('you@example.com');
```

Not a plain `UPDATE`. `is_admin` cannot be self-granted: a trigger refuses any
change to that column that does not come from an admin function, and the SQL
editor is not `service_role` either — so

```sql
update public.user_profiles set is_admin = true where email = '...';   -- refused
```

fails with *`is_admin can only be changed by an administrator`*, which is the
guard doing its job. RLS is row-level, not column-level, so the "manage your
own profile" policy would otherwise have let anyone promote themselves from
the browser console.

`grant_admin()` is `REVOKE`d from `anon` and `authenticated`, so it exists only
for whoever can already open the SQL editor — who owns the database and could
drop the trigger anyway. Use it once, for yourself; everybody after that is
promoted from the panel, where it is audited. Pass `false` as a second
argument to take the flag away again.

If it answers *"No profile with that address"*, that account has no
`user_profiles` row yet — section 1 of the migration backfills existing
accounts, so check `select email from public.user_profiles;`.

**3. Set two Netlify environment variables** (see [Configuration](#-configuration)).
Without them the panel still reads and edits profiles, but blocking, creating,
deleting, password links and *sign in as* all report that they are not
configured — those touch Supabase's own auth tables, which no SQL policy can
reach.

⚠️ `SUPABASE_URL` must be the **direct** project URL
(`https://<ref>.supabase.co`), not the Cloudflare Worker proxy the browser
uses. The function calls Supabase's admin auth endpoints with the service-role
key, and those have no business going through a proxy.

Then *Admin* appears in the user menu, just above Logout.

### What each tab does

**People** — everyone, searchable, with their spend and expense count. Open
one to see their totals, their categories, and their expense log. It is
read-only: an admin can look at somebody's spending without being able to
quietly rewrite it. The actions are make/remove admin, sign in as them,
password reset link, sign out everywhere, block, and delete.

**Access** — two switches. *Allow new accounts* off closes registration
entirely. *Invite only* limits it to the allow list. Below them: create an
account outright with a password you choose, email an invite, or just add an
address to the allow list. Then the blocked list and the allow list.

**Audit** — every admin action, newest first, append-only.

### Signing in as somebody

The honest form of "log in as anyone" is a single-use magic link for their
account. Opening it **replaces your own session in that browser** with theirs —
you are them until you sign out. The panel says so before it hands the link
over, and the attempt is recorded whether or not the link is ever opened.

There is no impersonation mode that keeps you signed in as yourself, because
that would need the app to carry two identities at once and every RLS policy
to understand which one it is answering.

### Blocking

Two halves, and both matter: a row in `banned_emails` stops a *new* account
being created with that address, and `banned_until` on the auth user stops the
*existing* account signing in. Their sessions are ended too, or the block would
wait out the hour an already-issued token stays valid.

## 🎯 Usage Guide

### Getting Started
1. **Sign Up** - Create account with email verification
2. **Add First Expense** - Use the quick entry form
3. **Set Monthly Budget** - Configure billed/unbilled budgets
4. **Explore Analytics** - View charts and insights

### Adding Expenses
1. Enter amount (₹1 - ₹10,00,000)
2. Select or add expense category
3. Add descriptive note (required, max 500 chars)
4. Set date (defaults to today in IST)
5. Toggle billed/unbilled status
6. Click "Add Expense"

### Managing Categories
- **Add New**: Click "+" next to type dropdown
- **Delete Unused**: Click "Manage Types" → Delete
- **Edit Existing**: Click "Manage Types" → Edit
- **Auto-complete**: Type-ahead suggestions

### Budget Tracking
1. Click "Set Budget" in budget section
2. Set separate amounts for billed/unbilled
3. Monitor with visual progress bars
4. Receive alerts at 90% and 100%
5. View monthly budget history

### Analytics & Insights
1. Click "Analytics" button
2. Set date range and filters
3. Switch between chart types
4. Export data for external analysis
5. View spending insights and trends

### Advanced Features
- **Scan a receipt**: *Add New Expense → Scan receipt*, tick what counts, prefill the form
- **Speak an expense**: the mic beside the quick-add box
- **Search**: Use global search for quick expense lookup
- **Bulk Edit**: Edit several expenses in either list and save them together
- **Offline**: add expenses with no signal; they sync when you reconnect
- **Theme Toggle**: Switch between light/dark modes
- **Profile**: Update name, email, and password — all three in Edit Profile
- **Export**: Download filtered data with budget info
- **Admin**: for accounts with the flag, above Logout

## 🚀 Deployment Options

### GitHub Pages
1. Enable Pages in repository settings
2. Select source branch (main/gh-pages)
3. Access via username.github.io/repository-name

### Netlify
1. Connect GitHub repository
2. Build command: (none - static site)
3. Publish directory: `/` (root)
4. Configure environment variables

### Vercel
1. Import project from GitHub
2. Configure build settings
3. Add environment variables
4. Deploy automatically on push

### Custom Server
1. Upload files to web server
2. Ensure HTTPS for PWA features
3. Configure proper MIME types
4. Enable gzip compression

## 🔧 Configuration

Start from the documented list:

```bash
cp .env.example .env      # .env is gitignored; .env.example never holds a value
```

`.env` is read by `netlify dev` — the only way to exercise `netlify/functions/`
locally. It is **not** read by the deployed site or by `npm run dev`. What the
deployed site reads is Netlify → Site configuration → Environment variables.

### There is no `VITE_` prefix, deliberately

That prefix is not decoration. It means *"safe to inline into the client
bundle"* — Vite only exposes variables carrying it to browser code. Half the
variables here are secrets, so being uniform about the prefix means either
marking secrets as public or marking public values as secret. Both are worse
than having no prefix at all, and the first is how a `service_role` key ends
up in a bundle.

The line that matters is **public vs secret**, and it is drawn by the two
tables below. The old `VITE_SUPABASE_*` names are still read as a fallback so
a deploy keeps working mid-rename; the build log nags until you delete them.

### Public settings — [`config.js`](config.js)

There is no bundler here: `index.html` loads plain files, so there is nothing
to inline a variable into. [`config.js`](config.js) is the substitute. It is
committed with working defaults, and
[`scripts/build-config.mjs`](scripts/build-config.mjs) rewrites it at deploy
time from whichever of these are set.

| Variable | Sets | Also read by |
|---|---|---|
| `SUPABASE_URL` | The Supabase project | `netlify/functions/` — so it must be the **direct** `https://<ref>.supabase.co`, never the proxy. The build refuses anything else. |
| `SUPABASE_PROXY_URL` | Cloudflare Worker in front of Supabase, for ISPs that will not route to `*.supabase.co`. Blank talks to Supabase directly | browser only |
| `SUPABASE_ANON_KEY` | The publishable key | `netlify/functions/`, as the apikey header |

Each is independent, and setting none is a no-op — a build that silently
blanked them would deploy an app that cannot reach its database.

**These are not secrets, and moving them to environment variables does not
make them secret.** Whatever ends up in `config.js` is downloaded by every
visitor. The publishable key is *designed* for that: it grants only what Row
Level Security allows, and every table has RLS enabled. The reason to use the
variables is to point a deploy at a different project without editing code —
not security. The build script refuses to write a `service_role` key.

### Secrets — Netlify only

Read server-side by `netlify/functions/`, never written into `config.js`,
never delivered to a browser.

| Variable | Needed for | Effect if unset |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | The admin panel's auth actions | Block, create, delete, password links and *sign in as* report that they are not configured. Bypasses every RLS policy — Netlify's environment and nowhere else. |
| `GEMINI_API_KEY` | The receipt scanner | Skipped. With none of the six set, scanning is unavailable — there is no on-device fallback. |
| `GROQ_API_KEY` | The same | Skipped. |
| `MISTRAL_API_KEY` | The same | Skipped. |
| `OPENROUTER_API_KEY` | The same | Skipped. |
| `OPENAI_API_KEY` | The same | Skipped. |
| `ANTHROPIC_API_KEY` | The same | Skipped. |
| `GEMINI_MODEL`, `GROQ_MODEL`, … | Pinning a model | Each provider discovers its own, newest first. Set one only to override that. |
| `SCAN_MAX_IMAGES` | Screenshots per scan | Defaults to 5. |
| `SCAN_TIME_BUDGET_MS` | How long the chain may take | Defaults to 24000, just under Netlify's 26s ceiling. |

Providers are tried **in that order** and the first that answers wins. A 429
puts that provider on a cooldown; "no credits remaining" is told apart from a
rate limit and cooled for an hour, because waiting a minute will not add money
to an account.

`SECRETS_SCAN_ENABLED` is left **on** in `netlify.toml`: it fails the build if
either secret turns up in a deployed file. The three public names are listed in
`SECRETS_SCAN_OMIT_KEYS`, because they are written into `config.js` on purpose
and the scanner would otherwise fail every build for finding exactly what it
was told to put there. `SUPABASE_SERVICE_ROLE_KEY` and `GEMINI_API_KEY` are
deliberately *not* omitted — catching those is the entire point.

### Why the defaults stay committed

`config.js` ships with real values rather than blanks. They are public
information either way, so emptying them buys no secrecy, and it costs:
`npm run dev` would serve an app that cannot reach any database, and a
mis-set Netlify variable would produce a white screen instead of a working
site. "Replace it later without touching code" is already what the variables
above are for.

One thing worth knowing if this repo is public: a fork points at *your*
project by default. RLS means a stranger only ever sees their own rows, but
they can still create an account and use your quota. The control for that is
*Admin → Access → Allow new accounts*, not hiding a key that is public by
design.

### PWA Configuration
Update `manifest.json` with your app details:
```json
{
  "name": "My Expense Tracker",
  "short_name": "ExpenseTracker",
  "description": "Track your expenses efficiently",
  "start_url": "/",
  "display": "standalone",
  "theme_color": "#667eea",
  "background_color": "#ffffff"
}
```

## 📊 Features in Detail

### Chart Types & Analytics
- **Pie Chart**: Category distribution overview
- **Doughnut Chart**: Enhanced category visualization with center text
- **Line Chart**: Cumulative expense trends with gradient fill
- **Bar Chart**: Vertical category comparison
- **Horizontal Bar**: Alternative category layout
- **Bubble Chart**: Amount vs frequency correlation analysis

### Budget Management
- **Independent Tracking**: Separate budgets for billed/unbilled expenses
- **Visual Feedback**: Color-coded progress bars (green → orange → red)
- **Smart Notifications**: Alerts at 90% usage and budget exceeded
- **Historical Data**: Month-by-month budget tracking
- **Export Integration**: Budget summaries in the Excel export

### Search Capabilities
- **Real-time Search**: Instant results as you type
- **Multi-field**: Search notes, categories, amounts, dates
- **Flexible Matching**: Partial matches and case-insensitive
- **Result Summaries**: Total count and amount calculations

### Data Export Features
- **Smart Naming**: Automatic filename based on filters
- **Comprehensive Data**: All expense fields with proper formatting
- **Budget Integration**: Monthly budget information included
- **Flexible Filtering**: Date range, billing status, category filters
- **Summary Calculations**: Totals and remaining budgets

## 🤝 Contributing

### Getting Started
1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Make changes following code style
4. Test thoroughly on multiple devices
5. Submit pull request with detailed description

### Development Guidelines
- **Code Style**: Follow existing patterns and naming conventions
- **Comments**: Add meaningful comments for complex logic
- **Testing**: Test on different browsers and screen sizes
- **Documentation**: Update README for new features
- **Performance**: Consider impact on load times and responsiveness

### Code Structure
```
├── index.html          # Main HTML file
├── styles.css          # CSS styles and themes
├── script.js           # Core JavaScript functionality
├── manifest.json       # PWA configuration
├── icons/             # App icons for PWA
└── README.md          # Documentation
```

## 🐛 Troubleshooting

### Common Issues
1. **Login problems** — check `SUPABASE_URL` and the publishable key in [`config.js`](config.js). If the Worker proxy is set, check it is reachable too.
2. **Chart not loading** — verify the Chart.js CDN link, and that the host is in the CSP `script-src`.
3. **Date issues** — all date maths runs on `YYYY-MM-DD` strings anchored to IST; see [How dates are handled](#️-how-dates-are-handled).
4. **Export problems** — check browser compatibility for downloads.
5. **PWA not installing** — requires HTTPS and `manifest.json`.

### After a deploy

6. **Old version still loading** — bump `CACHE` in [`sw.js`](sw.js) *and* the
   `?v=` on the assets in `index.html`, and keep both matching
   `package.json`. `npm run audit` fails if they drift.
7. **Config changes not taking** — `config.js` is in the service worker's
   cached shell, so it only refreshes once `CACHE` changes.

### The scanner

8. **Always reads on the device** — `GEMINI_API_KEY` is not set, or the free
   quota is spent. `GET /.netlify/functions/scan?diagnose=1` says which, and
   which model the key can actually reach.
9. **Tesseract never loads** — the CSP needs `'wasm-unsafe-eval'`, `blob:`,
   and `cdn.jsdelivr.net` plus `tessdata.projectnaptha.com` in `connect-src`.

### The admin panel

10. **"is_admin can only be changed by an administrator"** — you ran a plain
    `UPDATE`. Use `select public.grant_admin('you@example.com');`. See
    [Admin](#-admin).
11. **Admin never appears** — the migration has not been applied, or that
    account has no flag. Check `select email, is_admin from public.user_profiles;`
12. **"Not configured"** on block/create/delete — `SUPABASE_URL` and
    `SUPABASE_SERVICE_ROLE_KEY` are missing from Netlify, and `SUPABASE_URL`
    must be the direct project URL rather than the Worker proxy.
13. **People tab empty with a network error** — if the browser reaches
    Supabase through a proxy, it must forward `/rest/v1/rpc/`; every admin
    read goes through RPC.

### Browser Compatibility
- **Chrome**: Full support (recommended)
- **Firefox**: Full support
- **Safari**: Full support (iOS 12+)
- **Edge**: Full support
- **Mobile**: Optimized for all modern mobile browsers

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Supabase](https://supabase.com) - Backend as a Service
- [Chart.js](https://www.chartjs.org) - Beautiful charts
- [Inter Font](https://rsms.me/inter) - Modern typography
- JavaScript community for inspiration and best practices

## 📋 Full 1.1 change list

### Bug fixes

| Area | Problem | Fix |
| --- | --- | --- |
| Dates | `getISTDate()` added +05:30 then read local getters — one day early after 18:30 IST, one **month** early on the last evening of a month | Rewritten around `YYYY-MM-DD` strings anchored to Asia/Kolkata |
| Dates | `formatDate()` parsed `'2026-08-05'` as UTC midnight, so devices west of UTC showed the previous day | Parses the string into a local-midnight date |
| Dates | Insights grouped months via `new Date(expense.date).getMonth()` — wrong month at boundaries outside IST | Groups on the stored date string |
| Change password | `showChangePassword()` focused `#current-password`, an element that does not exist — threw and left the user menu stuck open | Focuses `#new-password` |
| Delete type | `closeDeleteTypeModal()` called `hideLandingIcons()` instead of `showLandingIcons()`, leaving the theme and docs buttons invisible | Modals now sit above those buttons by z-index; the hide/show hack is gone |
| Security | Notes were interpolated into `data-original="…"` and `value="…"` unescaped, and rendered raw in search results | Separate `esc()` / `attr()` escaping on every path; covered by a test that feeds a hostile note through the list and edit mode |
| Insights | `Math.max(...[])` returned `-Infinity` for a new account, producing `NaN` chart bounds | `safeMax()` |
| Insights | Stray `</div>` in the generated markup | Rebuilt |
| CSV export | Fields wrapped in quotes but inner quotes never doubled — a note containing `"` broke the file | RFC 4180 escaping + UTF-8 BOM so ₹ survives in Excel |
| Import | 40 ms sleep per row (a 500-row file idled for 20 s) | Yields ~60 times total, and inserts in chunks of 200 |
| Import | `readAsBinaryString` is deprecated and unreliable in Safari | `readAsArrayBuffer` |
| Stats | Card labelled "Total Transactions" showed the current month's count | Relabelled "Transactions" |
| Charts | Chart handle stored at `window.velocityChart` collided with `<canvas id="velocityChart">`, so the first `.destroy()` hit a DOM node and threw | Handles moved to module scope |
| Tooling | `npm run dev` ran `python`, absent on current macOS | `python3` |
| Amount field | Was `<input type="number">`, which silently rejects `120+80+45` — the calculator could never have worked | `type="text"` + `inputmode="decimal"`, so the numeric keypad still appears on iOS |

### iPhone / Safari

- `viewport-fit=cover` plus `env(safe-area-inset-*)` padding for the notch and home indicator
- Every focusable input is ≥16px, so iOS no longer zooms the viewport on focus
- `-webkit-backdrop-filter` alongside `backdrop-filter` (blur previously did nothing in Safari)
- Hover styles behind `@media (hover: hover)` — tapped buttons no longer stay stuck in their hover state
- Background scroll locked while a modal is open, with scroll position restored on close
- `100dvh` with a `100vh` fallback; momentum scrolling and `overscroll-behavior: contain` on scroll areas
- Tap targets ≥38px on coarse pointers; `:has()` used only with a class-based fallback
- Verified at 428×926 @3x: no horizontal overflow, modals fit the viewport, charts render

### New features

- **Quick add** — mined one-tap presets, natural-language parsing with type inference from your own history, and arithmetic in the amount box
- **Recurring expenses** — offered monthly, never auto-inserted; day-of-month clamps for short months
- **Budget alert levels** — any number of thresholds, each scoped to total / billed / unbilled; one toast per scope per month
- **Month heatmap** — daily spend calendar with blank-day tracking, square-root shading
- **Full JSON backup** — every table plus settings in one restorable file
- **Total budget** — billed + unbilled as one headline number with progress, remaining, and daily pace
- **Simple mode** — hides billed/unbilled everywhere; one total budget; new expenses save unbilled
- **Settings modal** — billing mode, default billing status, budget alerts; synced to the account when the `settings` column exists, otherwise device-local
- **Undo delete** — deletions surface an Undo action for 6.5 s
- **Repeat expense** — one tap to re-add a past expense dated today
- **Delete from the dashboard** — no longer requires opening the analytics modal
- **Quick chips** — +50/+100/+200/+500 amounts, Today/Yesterday dates
- **Excel export** alongside CSV (CSV was removed in 1.2); both included the budget summary for single-month ranges
- **Date range presets** — this month, last month, last 30 days, this year, all time
- **Indian digit grouping** — ₹1,23,456.00 via `Intl.NumberFormat('en-IN')`
- **Per-category colours** — a type keeps its colour in badges and in every chart
- **Search** — debounced, with match highlighting
- **Keyboard shortcuts** — `/` search, `n` new expense, `Esc` close
- **Recent list size** — 5 / 10 / 25
- **Month-over-month delta** on the "This Month" card
- Theme follows the OS until you pick one; empty states and skeleton loaders; reduced-motion and print styles

## 📞 Support & Contact

- 🐛 [Report Issues](https://github.com/sdukesameer/myExpenseTracker/issues)
- 💡 [Feature Requests](https://github.com/sdukesameer/myExpenseTracker/issues/new)
- 📧 [Email Developer](mailto:sdukesameer@gmail.com)
- 💼 [LinkedIn Profile](https://www.linkedin.com/in/sdukesameer)

## 🌟 Show Your Support

Give a ⭐ if this project helped you manage your expenses better!

**Share with friends and colleagues who need better expense tracking!**

---

**Made with ❤️ by [MD SAMEER](https://www.linkedin.com/in/sdukesameer)**

*"Take control of your finances with intelligent expense tracking"*
