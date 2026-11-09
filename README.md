# Apartment Cafe Platform: Phase 1, Step 1 (Database)

This folder holds the database layer: tables, security rules, and the functions
that do all the real work (placing orders, reserving stock, claiming, cancelling, undo).
The React apps come next and will only ever call these functions.

## Setup (about 10 minutes)

1. **Create a Supabase project** (free tier is fine).
2. **Disable public signups:** Authentication > Sign In / Providers (or Settings) > turn OFF
   "Allow new users to sign up". Baristas are added by hand (step 5).
3. **Run the SQL files in order** in the SQL Editor, one at a time:
   - `supabase/001_schema.sql`
   - `supabase/002_rls.sql`
   - `supabase/003_functions.sql`
   - `supabase/004_seed_test_data.sql` (optional: creates "Test Cafe", passcode `1234`)
4. **Create each barista's login:** Authentication > Users > Add user (email + password,
   tick "Auto confirm"). Copy the user's UUID.
5. **Make them a barista** (SQL Editor), once per person:
   ```sql
   insert into public.admins (user_id, display_name)
   values ('PASTE-USER-UUID-HERE', 'Sam');
   ```
   Add a third barista later the same way. No code changes needed.

## How the app talks to the database

Guests (anonymous) can only READ the active session and its menu. Everything else
is a function call, e.g. with supabase-js: `supabase.rpc('place_order', { ... })`.

| Function | Who | What it does |
|---|---|---|
| `check_passcode(p_code)` | guest | "I'm here" check (instant feedback only) |
| `place_order(p_passcode, p_name, p_items)` | guest | Verifies code, validates, reserves stock, returns ticket number and private token |
| `get_order(p_token)` | guest | Tracker data for one order (poll every 5 to 10 s) |
| `cancel_order_as_guest(p_token)` | guest | Only while pending; returns stock |
| `admin_place_order(p_name, p_items, p_start_now)` | barista | Walk-in order, no passcode |
| `start_order(id)` / `complete_order(id)` | barista | Atomic status moves (claim fails if someone else got it) |
| `cancel_order(id, p_reason, p_restock)` | barista | Cancel from pending or in progress |
| `undo_order(id)` | barista | One step back (see below) |
| `adjust_stock(menu_item_id, p_delta)` | barista | +/- buttons; deltas only |
| `rotate_passcode(session_id)` | barista | New random 4-digit code |
| `activate_session(session_id)` | barista | Makes one session active, deactivates the rest |

Everything returns `{ "ok": true, ... }` or `{ "ok": false, "error": "CODE" }`.

`p_items` looks like:
```json
[{ "menu_item_id": "uuid", "quantity": 1, "note": "less ice",
   "modifier_option_ids": ["uuid", "uuid"] }]
```

Error codes: `NO_ACTIVE_SESSION`, `ORDERING_CLOSED`, `ORDERING_PAUSED` (plus `message`),
`WRONG_PASSCODE`, `TOO_MANY_ATTEMPTS`, `TOO_MANY_ITEMS`, `AT_CAPACITY`, `TOO_MANY_OPEN_ORDERS`,
`SOLD_OUT: <item>`, `OPTION_UNAVAILABLE: <option>`, `INVALID_ORDER: <reason>`, `NOT_FOUND`,
`NOT_PENDING` (may include `claimed_by_name`), `ALREADY_CANCELLED`, `NOT_CANCELLABLE`,
`NOT_IN_PROGRESS`, `NOTHING_TO_UNDO`, `STATE_CHANGED`, `FORBIDDEN`, `UNLIMITED_OR_NOT_FOUND`.

## Behaviors worth knowing

- **Stock is reserved when the order is placed** and restored when a pending order is cancelled.
- **Undo goes one step back.** Undoing a cancel returns the order to the status it was
  cancelled from and re-takes stock only if that cancel had returned it. An undo itself
  cannot be undone (use the normal buttons instead).
- **Throttle:** after 10 wrong codes in a minute from anyone, all code attempts wait about
  30 seconds. It is global on purpose (everyone shares your wifi's IP).
- **Adding functions later:** new functions are callable by everyone by default in Postgres.
  Copy the revoke/grant pattern at the bottom of `003_functions.sql` for any new one.
- **Before the real event:** `delete from public.sessions where title = 'Test Cafe';`

## Tests

`supabase/tests/` holds the checks I ran against a local Postgres 16 with a stand-in for
Supabase's auth layer: 20 test groups covering security, atomic stock, undo, throttle, and
a 20-guests-at-once race for 5 pastries (exactly 5 succeeded). They are for development;
you do not need to run them in Supabase.
