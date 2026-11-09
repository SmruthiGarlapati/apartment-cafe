# Apartment Cafe Platform: Design Document (v2)

*Revised after design review. Supersedes v1.*

## 1. Overview

A pop-up apartment cafe platform with two surfaces:

- **Guest site (mobile-first):** guests browse the menu freely, then enter a code at the cafe to place an order, track it, and cancel it while it is still pending.
- **Barista dashboard (laptop-first):** a large-screen kanban of orders, inventory controls, walk-in order entry, and session controls.

Everything hangs off a **Session** (one weekend or event) that carries its own title, theme, menu, modifiers, passcode, and payment/tip settings. Future pop-ups are created by duplicating a session and editing it.

**Scope for now:** a fun event for friends. Payments are a tip jar or donation, not a checkout. The schema leaves room to add prices later without a rewrite.

## 2. Tech Stack

- **Frontend:** React, two route groups in one app: `/` (guest, mobile-first) and `/admin` (laptop-first, login required).
- **Styling:** Tailwind CSS with theming through CSS variables (see 9.1).
- **Backend:** Supabase (Postgres, Auth, Realtime, Edge Functions if needed).
- **Hosting:** Vercel or Netlify.
- **Key principle:** guests never write to tables directly. Every guest action goes through a small set of Postgres functions (RPCs) that validate everything in one transaction.

## 3. Key Decisions (what changed from v1)

| Topic | v1 | v2 |
| --- | --- | --- |
| Passcode | Stored on `sessions`, readable by anyone, checked only in the UI | Stored in an admin-only table, checked server-side on every order |
| Menu before arrival | Behind the gate | Public. Only *ordering* is gated |
| Stock | Undefined | Decremented atomically when an order is placed, restored on cancel, adjusted by baristas with deltas |
| Order creation | Direct anonymous insert | Single `place_order` function |
| Guest order visibility | None | Private tracking page via secret token, plus ticket number |
| Statuses | pending, in\_progress, completed | pending, in\_progress, completed, cancelled, with undo |
| Payments | Venmo/Zelle modal | Optional tip jar, no amounts, no payment tracking |
| Admin access | Any authenticated user | Public signups disabled, `admins` table checked by RLS |
| Modifiers | None | Reusable modifier groups per session, attached to items |
| Walk-in orders | None | Baristas can enter orders manually |

## 4. User Flows

### 4.1 Guest flow

1. **Landing:** shows the active session's title, status (upcoming / open / closed), and vibe and venue details. If ordering is paused or closed, a banner says so.
2. **Browse the menu:** open to everyone, no code needed. Items show description, ingredients, allergens, and a light stock signal ("Running low", "Sold out"). Allergen disclaimer is visible.
3. **Build a ticket:** pick items, choose modifiers (required groups must be answered), add an optional note per item, set quantity.
4. **"I'm here!" gate:** at checkout the guest enters the 4-digit code posted at the cafe, plus their name. The code is verified on the server when the order is submitted, so skipping the UI does nothing.
5. **Confirmation:** an order page appears with a large **ticket number**, the first name for a personal touch, the items, and a live status (Received, Being made, Ready for pickup). A Cancel button is available while the order is still pending.
6. **Returning:** the order token is saved in localStorage. If the guest reloads or comes back, the landing page shows an "Your order #14" banner that reopens the tracker. The tracker URL (`/order/<token>`) can also be bookmarked.
7. **After completion:** the tracker shows a thank-you, the tip jar (if enabled), and the guestbook link.

**Guest cancellation rules:**

- While **pending**: the guest can cancel in one tap (with a confirm). Stock is returned automatically.
- Once **in progress**: the button is replaced with "We've started your order. Please find a barista to cancel." The barista decides whether the item goes back to stock.

### 4.2 Barista flow (laptop dashboard)

**Layout:** a top bar, three main columns, and a right-hand inventory panel.

**Top bar**

- Session name and a connection indicator (green / reconnecting / offline).
- **Pause ordering** toggle (with an optional message shown to guests).
- Today's passcode, with a button to rotate it.
- **+ New order** (walk-in entry).
- Sound on/off for the new-order chime.

**Columns**

1. **Pending:** every new order arrives here showing the full ticket: the ticket number first (the main identifier), then the first name, then items with modifiers and notes, allergen flags, and a running wait timer that turns amber and then red.
2. **In Progress:** shows who claimed it and when it started.
3. **Complete:** recently completed orders (last hour or last N), scrollable.

- A **Cancelled** drawer holds cancelled orders.

**Card actions**

- Pending card: **Start** (claims it for you and moves it to In Progress) and **Cancel**.
- In Progress card: **Complete** and **Cancel**.
- Complete / Cancelled cards: **Undo** (moves back one step, see 6.4).
- After any status change, an **Undo** toast stays visible for about 10 seconds.

**Claiming rule:** Start is an atomic update that only succeeds if the order is still pending. If two baristas tap at once, the second sees "Already claimed by Sam" and the card updates.

**Cancel dialog (barista):** optional reason, and a **Return items to stock** checkbox. It defaults to on for pending orders and off for in-progress orders, since ingredients may already be used.

**Inventory panel (right side)**

- Each item shows name, stock, and **+ / −** buttons. These send *delta* updates, never absolute overwrites.
- Low-stock highlighting at 5 or fewer, and an "86 it" toggle to hide an item without changing its count.
- Modifier options appear below with availability toggles (for example, "Oat milk: out").

**Walk-in orders:** the **+ New order** modal mirrors the guest builder (items, modifiers, notes, name or "Walk-in"). It skips the passcode, uses the same stock logic and ticket numbering, and is marked `source = barista`. This is the fallback if a guest's phone or the guest site fails. The barista can send it to Pending or straight to In Progress.

**Resilience:** the dashboard does a full refetch on every reconnect and when the tab regains focus. It plays a chime on new orders, requests a screen wake lock so the laptop does not sleep, and shows a prominent banner if the connection drops.

### 4.3 Session setup flow (admin)

1. Create a session, or **Duplicate** an old one (copies menu items, modifier groups, and attachments with stock reset).
2. Fill in title, theme, description, venue notes, start and end times, tip handles, and guestbook URL.
3. Create **modifier groups** once (for example, Milk: 2%, Oat) and **attach** them to every item that uses them.
4. Set stock counts, passcode, and limits.
5. Do a test order the day before (see 9.2), then flip the session to **open** and **active**.

## 5. Order Status State Machine

```
pending ──Start──▶ in_progress ──Complete──▶ completed
   │                    │
   └────── Cancel ──────┘──▶ cancelled
```

| From | To | Who | Stock effect |
| --- | --- | --- | --- |
| (new) | pending | guest or barista | Decremented at creation |
| pending | in\_progress | barista | None |
| in\_progress | completed | barista | None |
| pending | cancelled | guest or barista | Returned |
| in\_progress | cancelled | barista only | Returned only if the barista ticks the box |
| completed | in\_progress | barista (undo) | None |
| cancelled | pending | barista (undo) | Re-decremented only if that cancel had returned stock (order\_events.restocked); fails with a clear message if stock is gone |

Use one vocabulary everywhere: the stored values are `pending`, `in_progress`, `completed`, `cancelled`. The UI labels are Pending, In Progress, Complete, Cancelled. Every transition is written to `order_events`, which powers undo and the timing stats. Undoing a cancellation returns the order to the status it was cancelled from (pending or in progress), and re-takes stock only if that cancel had returned it.

## 6. Database Schema

### 6.1 Tables

**`sessions`**

- `id` uuid PK
- `title` text
- `theme_slug` text (maps to a `data-theme` value)
- `description` text (vibe)
- `venue_note` text (what guests should know; keep the exact address out of public fields if you want it private)
- `starts_at`, `ends_at` timestamptz
- `status` text: `upcoming` | `open` | `closed`
- `is_active` boolean (the one session shown on the site)
- `ordering_paused` boolean default false
- `pause_message` text
- `max_open_orders` int, nullable (cap on pending + in progress; null means no cap, and it is off by default)
- `max_items_per_order` int default 10 (a typo and bug guard, not a business rule)
- `max_open_orders_per_name` int, nullable (off by default)
- `tips_enabled` boolean default true
- `zelle_contact` text, `venmo_handle` text, `tip_note` text
- `guestbook_url` text
- `next_ticket_number` int default 1
- `created_at` timestamptz

**`session_secrets`** (admin-only, never exposed to guests)

- `session_id` uuid PK, FK to `sessions`
- `passcode` text
- `updated_at` timestamptz

**`menu_items`**

- `id`, `session_id` (FK), `name`, `description`
- `ingredients` text\[\], `allergens` text\[\]
- `stock_count` int, **nullable** (null means unlimited; check constraint `stock_count >= 0`)
- `is_available` boolean default true (manual "86" switch; see derived availability below)
- `price_cents` int, nullable (unused for now, reserved for later)
- `sort_order` int, `image_url` text

Derived availability, never stored: an item is orderable when `is_available AND (stock_count IS NULL OR stock_count > 0)`. Expose this through a view so the guest and admin apps agree.

Stock labels are derived too. Guests see **Running low** when `stock_count` is at or below a `low_stock_threshold` (add this int column to `sessions`, default 5) and **Sold out** at 0. Baristas always see the exact count.

**`modifier_groups`** (defined once per session)

- `id`, `session_id`, `name` ("Milk"), `is_required` boolean, `min_select` int, `max_select` int, `sort_order`

**`modifier_options`**

- `id`, `group_id`, `name` ("Oat"), `is_available` boolean default true, `price_delta_cents` int nullable (reserved), `sort_order`

**Modifier availability:** modifier options use an on/off availability toggle only (for example, Oat milk: out). The server rejects an unavailable option on every order, so a toggle takes effect on the very next submission and the guest menu shows that option as out. If you later want counts, add a nullable `stock_count` to `modifier_options` and decrement it in `place_order` like menu items.

**`menu_item_modifier_groups`** (join table)

- `menu_item_id`, `group_id`, composite PK

This lets you define "Milk: 2%, Oat" once and attach it to every latte. A pastry simply has no groups attached.

**`orders`**

- `id` uuid PK, `session_id` FK
- `ticket_number` int, with a unique constraint on (`session_id`, `ticket_number`)
- `customer_name` text
- `status` text (see section 5)
- `source` text: `web` | `barista`
- `public_token` uuid, unique, random (the guest's private key)
- `claimed_by` uuid, FK to `admins`
- `cancelled_by` text: `customer` | `barista`, `cancel_reason` text
- `created_at`, `started_at`, `completed_at`, `cancelled_at`, `updated_at` timestamptz

**`order_items`**

- `id`, `order_id` FK, `menu_item_id` FK
- `item_name` text (snapshot, so later menu edits do not rewrite history)
- `quantity` int (1 to 10, check constraint)
- `note` text (free-text, length-limited)

**`order_item_modifiers`**

- `id`, `order_item_id` FK, `option_id` FK
- `group_name`, `option_name` text (snapshots)

If a guest wants one latte with oat and one with 2%, those are two `order_items` lines. Quantity only groups identical configurations.

**`order_events`** (audit log)

- `id`, `order_id`, `from_status`, `to_status`, `actor` (admin uuid, or `customer` / `system`), `note`, `created_at`

Cancel events also store `restocked` (boolean): whether the items went back to stock at that moment. Undo reads this flag, so undoing a cancellation never double-decrements stock or leaves ghost inventory.

**`admins`**

- `user_id` uuid PK (references `auth.users`), `display_name` text

### 6.2 Constraints and indexes

```sql
-- Only one active session, enforced by the database
CREATE UNIQUE INDEX one_active_session ON sessions (is_active) WHERE is_active;

-- Never let stock go negative
ALTER TABLE menu_items ADD CONSTRAINT stock_nonneg CHECK (stock_count IS NULL OR stock_count >= 0);

-- Fast queue queries
CREATE INDEX orders_queue_idx ON orders (session_id, status, created_at);
```

## 7. Server Logic (RPCs)

Guests get EXECUTE on only these functions, and no direct table writes.

### 7.1 `place_order(passcode, name, items[])`

Runs as one transaction. Steps:

1. Load the active session. Reject if `status <> 'open'` or `ordering_paused`.
2. Compare the passcode to `session_secrets` (see 8.2 for throttling). Reject if wrong.
3. Validate input: name length 1 to 40; total quantity (the sum of all line quantities, not the number of lines) at most `max_items_per_order`; every `menu_item_id` belongs to this session; every modifier option belongs to a group attached to that item; required groups satisfied; min/max select respected; modifier options are available.
4. If set, enforce `max_open_orders` and `max_open_orders_per_name`.
5. Decrement stock atomically, per item:

   ```sql
   UPDATE menu_items
   SET stock_count = stock_count - :qty
   WHERE id = :id AND is_available
     AND (stock_count IS NULL OR stock_count >= :qty)
   RETURNING id;
   ```

   Zero rows updated means that item sold out. The whole transaction rolls back and the error names the item so the UI can say "Sorry, the last cookie just went."
6. Increment `sessions.next_ticket_number` (row-locked) to assign the ticket number, which is the order's main identifier on every screen and is unique within the session.
7. Insert `orders`, `order_items`, `order_item_modifiers` (with name snapshots) and the first `order_events` row.
8. Return `{ticket_number, public_token}`.

### 7.2 Guest tracking and cancel

- `get_order(token)`: returns only that order (status, ticket, items, timestamps) plus the session's tip and guestbook info. The guest tracker polls this every 5 to 10 seconds. Guests do not subscribe to the `orders` table. Realtime follows RLS, and an anonymous guest has no identity that RLS can match to one order unless you mint a signed per-order token (a custom JWT), which is more machinery than this event needs. Polling is simple and recovers by itself on flaky wifi. Per-order Realtime is a possible later upgrade.
- `cancel_order_as_guest(token)`: succeeds only if status is `pending`. Returns stock, logs the event.

### 7.3 Barista functions (require `is_admin()`)

- `admin_place_order(...)`: same validation and stock logic as 7.1, without the passcode and open/paused checks, `source = 'barista'`.
- `start_order(order_id)`: `UPDATE ... SET status='in_progress', claimed_by=auth.uid(), started_at=now() WHERE id=:id AND status='pending'`. Returns zero rows if someone else got there first.
- `complete_order(order_id)`, `cancel_order(order_id, reason, restock boolean)`.
- `undo_order(order_id)`: reverses the most recent transition per the table in section 5, re-taking and re-checking stock only when the cancel had returned it (per the restocked flag on the cancel event).
- `adjust_stock(menu_item_id, delta)`: `SET stock_count = GREATEST(0, stock_count + :delta)`. Deltas only, so barista taps and incoming orders never overwrite each other.
- `rotate_passcode(session_id)`.

### 7.4 Stock summary

- Placing an order **reserves** stock immediately.
- Cancelling a pending order always returns it.
- Cancelling an in-progress order returns it only if the barista chooses.
- Manual +/- adjustments are separate and always deltas.
- `stock_count = NULL` is supported for unlimited items, even though you do not plan to use it right now.

## 8. Security and Access

### 8.1 Row Level Security

**Guests (anonymous)**

- SELECT `sessions` where `is_active` (no secrets live here, so this is safe).
- SELECT `menu_items`, `modifier_groups`, `modifier_options`, `menu_item_modifier_groups` for the active session only.
- No access to `orders`, `order_items`, `order_item_modifiers`, `order_events`, `session_secrets`, or `admins`.
- EXECUTE on `place_order`, `get_order`, `cancel_order_as_guest`, `check_passcode`.
- Optional: anonymous Realtime on `menu_items` for live stock. Realtime respects RLS, and this data is public anyway. A 15-second poll is an acceptable fallback.

**Baristas**

- Supabase Auth with **public signups disabled**. Accounts are created manually, one per barista (two to start, and more can be added at any time with no code change): create the user in the Supabase dashboard, then add a row in `admins`.
- A helper `is_admin()` checks that `auth.uid()` exists in `admins`. Every admin policy uses it, so a random authenticated user gets nothing.
- Full read/write on all tables through `is_admin()`. Realtime on `orders` and `order_items` is for baristas only.
- The `/admin` route is hidden *and* protected: obscurity is not the security layer.

### 8.2 Passcode gate

Purpose: guests can see the menu from anywhere, but can only place orders once physically at the cafe.

- The code lives in `session_secrets`, readable only by admins.
- `check_passcode(code)` gives instant feedback in the UI ("I'm here"), but the real enforcement is inside `place_order`, which re-verifies the code every time.
- **Throttle guesses:** four digits is 10,000 possibilities. Log failed attempts in a small table and enforce a global budget: after about 10 wrong codes in a minute from anyone, every code attempt waits 30 seconds. Do not key limits on IP address, because every guest on your wifi shares one public IP and one fat-fingered guest would lock the whole cafe out. A per-device counter in localStorage only drives a friendly "try again in 30 seconds" message; it is not security, since clearing storage resets it. For a friends-only event this is generous, but it is cheap to build.
- **Rotate the code** from the dashboard whenever you like, for example if it spreads mid-event. There is one 4-digit code per session. Show it in the top bar so baristas can tell guests.
- A code gate cannot stop a friend texting the code to someone who is not there. Rotating the code and your ability to cancel pending orders cover that case.
- **No-shows:** if a ready order sits for a long time, baristas can cancel it from the dashboard. Show "Ready for pickup" on the guest tracker once the order is complete, so people know to come grab it. Handover is simple: baristas call out the name and ticket number and set the drink on the counter, so the ready message repeats both and says to pick up at the counter.

## 9. Smaller Technical Traps, Addressed

### 9.1 Tailwind dynamic themes

Do **not** build class names like `` `theme-${slug}` `` at runtime, because Tailwind removes classes it cannot see in the source. Instead:

- Set `<html data-theme="fall-cozy">` from `sessions.theme_slug`.
- Define each theme as CSS variables: `[data-theme="fall-cozy"] { --bg: ...; --accent: ...; }`.
- Map Tailwind colors to those variables in the config (for example `bg-surface`, `text-accent`).
- Adding a new theme is then just a new CSS block.

### 9.2 Supabase free tier pausing

You asked whether editing before each session is enough to wake it up. Mostly yes, with one catch.

Per Supabase's docs, Free Plan projects with low activity over a 7-day period are paused. Opening the project in the dashboard generates activity and a paused project can be restored from the dashboard. The catch is timing: the clock is inactivity, not "last time you edited." If you set up the menu two weeks early and leave it alone, it can pause before the event. And a project that is paused on event day is a bad surprise.

Recommended routine:

- **Do a full test order the day before** each event. It wakes the project and also proves the whole flow works.
- Optionally add a free scheduled ping (a GitHub Actions cron or a Vercel cron that makes one cheap database query every few days). Note that the request needs to actually hit the database.
- If you later hold events more often, or want zero risk, the Pro plan cannot be paused. Also double-check Supabase's current free-plan terms before relying on any of this.

### 9.3 Realtime reliability on apartment wifi

- Admin dashboard: refetch the full queue on reconnect and tab focus rather than trusting the event stream; show a clear offline banner; chime on new orders; screen wake lock.
- Guest tracker: uses polling, which fails gracefully. Show "Reconnecting..." if a poll fails.
- Two different failures need two fallbacks. If the guest site or a guest's phone fails while the internet is up, baristas use the walk-in order form. If the internet itself goes down, the dashboard goes down too, so keep numbered paper tickets (P1, P2, and so on) and a phone hotspot ready for the laptop; Supabase is a cloud service, so a hotspot restores everything. Enter any paper tickets into the walk-in form afterward so stock stays accurate.

### 9.4 Refresh safety

- Persist the cart, the entered name, the "I'm here" confirmation, and the order token in localStorage.
- Do not store the passcode longer than needed. If it is rotated, the guest is simply asked again.
- A reload should never lose a half-built order or a placed order.

### 9.5 Reusability

Instead of a separate item catalog, use **Duplicate session**: it copies menu items, modifier groups, options, and attachments, then resets stock. Simpler to build, and covers repeat pop-ups well. A shared catalog can come later if the menu varies wildly.

## 10. Additional Features Worth Having

- **Pause ordering** toggle is the main control. A cap of 10 items per order guards against typos and bugs; optional caps on open orders and open orders per name are off by default (all in `sessions`).
- **Close session** action: sets `status = 'closed'`, locks ordering, and keeps the data for the summary.
- **Post-event summary** page for admins: total orders, cancelled count, most popular items and modifiers, busiest times, and average and longest time to start and to complete (from the timestamps and `order_events`).
- **Allergen handling:** allergens show on menu cards and on the barista order card. A short guest disclaimer ("made in a home kitchen") is visible at checkout.
- **Tip jar:** shown on the order tracker and after completion. Zelle is the primary option, with the contact stored in `sessions`. Because Zelle has no reliable web link, show the contact with a copy button and optionally a QR image. Venmo is a secondary option, shown as a profile link built from the optional handle. Test both on real phones before the event. No amounts are prefilled and nothing is tracked.
- **Privacy housekeeping:** you store only first names. Decide on a retention rule, such as an admin "anonymize names" action after the event (replace names with ticket numbers and keep the stats).
- **Later options:** prices and payment status (the nullable `price_cents` columns are already there), push or SMS "order ready" notifications, and a QR code that points to the site for the venue door.

## 11. Build Phases

**Phase 1: MVP for the first event (no fixed date: the cafe opens when the site feels seamless)**

- Schema, RLS, `admins`, `is_admin()`, and disabled signups (two barista accounts to start)
- `place_order`, `get_order`, `cancel_order_as_guest`, stock RPCs
- Guest site: landing, menu with "Running low" and "Sold out" labels, modifiers, gate at checkout, tracker, cancel
- Admin: three-column queue, start / complete / cancel / undo, inventory +/-, pause toggle, passcode display
- **Walk-in order entry** (`admin_place_order`), the fallback if the guest site fails
- Reconnect resync, offline banner, and new-order chime on the dashboard
- Session and menu setup (Supabase table editor is acceptable for the first event if you are comfortable with it, since the modifier join table is the awkward part)

**Phase 2: before the second event**

- Admin menu and modifier editor, duplicate session
- Passcode throttling and screen wake lock

**Phase 3: nice to have**

- Post-event summary, anonymize names, item photos (the image\_url column is already reserved), a QR code, and ready notifications

## 12. Testing Checklist (day before the event)

- Place an order as a guest on a real phone. Confirm it appears on the laptop with a chime.
- Try a wrong passcode. Try ordering without one (it should fail).
- Order the last item twice at the same time from two devices. Exactly one should succeed.
- Cancel as guest while pending. Try again while in progress (should be blocked).
- Cancel as barista with and without restock. Undo each transition.
- Two baristas tap Start on the same order.
- Pause ordering, then confirm guests see the banner and cannot submit.
- Turn wifi off on the laptop and back on. Confirm resync.
- Reload the guest page mid-order and after ordering.
- Test Venmo and Zelle links on iPhone and Android.

## 13. Open Questions

These decisions are settled and built into the sections above: stock is reserved at order time; guests cancel only while an order is pending; there is one 4-digit passcode per session; Zelle is the primary tip method with Venmo optional; limits are cut down to a 10-item bug guard; the ticket number is the main identifier, with the first name kept for a personal touch; guests see "Running low" at 5 or fewer and "Sold out" at 0; the walk-in order form is in Phase 1; barista accounts are added manually, two to start; drinks are called out by name and ticket number and placed on the counter; there are no item photos for the first event; and there is no fixed date, so the cafe opens when the site feels seamless.

Next step:

No open questions remain. Modifiers use the availability toggle for now. Start Phase 1 with the schema, RLS policies, and the `place_order` function, then build the guest site, then the barista dashboard, and test the full flow on real phones and a laptop before picking a date.
