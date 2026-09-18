# Returns Portal — Deploy Guide
Complete step by step. Do in order.

---

## Step 1 — Supabase: run the schema

1. supabase.com → your account → New project → name it `returns-portal`
2. SQL Editor → paste all of `schema.sql` → Run
3. Should return: "Success. No rows returned"

---

## Step 2 — Set user roles (how admin vs client works)

Roles live on the Supabase Auth user object in `user_metadata`.
The dashboard reads `user.user_metadata.role` on login.

**Creating an admin user (your ops team):**
1. Supabase dashboard → Authentication → Users → Add user
2. Fill in email + password
3. After creating, click the user → Edit → under "User Metadata" paste:
   ```json
   { "role": "admin" }
   ```
4. Save

**Creating a client user (Nation.LA):**
1. Same as above but paste:
   ```json
   { "role": "client" }
   ```

What each role sees:
- **admin** → full dashboard, flag form, discrepancy tools, 943 request, notifications panel, notify client button
- **client** → same table and filters, read-only, no flag form, no notifications panel

---

## Step 3 — Deploy the Edge Function

Requires Supabase CLI:

```bash
# Install CLI
npm install -g supabase

# Login
supabase login

# Link to your project (Project Ref = Settings → General in Supabase dashboard)
supabase link --project-ref YOUR_PROJECT_REF

# Set Extensiv secrets — stored server-side, never in browser
supabase secrets set EXTENSIV_CLIENT_ID=your_client_id
supabase secrets set EXTENSIV_CLIENT_SECRET=your_client_secret
supabase secrets set EXTENSIV_USER_LOGIN=your_user_login

# Deploy
supabase functions deploy extensiv-proxy
```

Confirm: Supabase dashboard → Edge Functions → `extensiv-proxy` should be listed.

---

## Step 4 — Configure the dashboard

Open `index.html`, find these two lines and fill them in:

```js
const SUPA_URL  = 'https://YOUR_PROJECT_REF.supabase.co'  // Settings → API → Project URL
const SUPA_ANON = 'YOUR_ANON_KEY'                          // Settings → API → anon public key
```

---

## Step 5 — Deploy to Vercel

1. vercel.com → New Project
2. Create a folder called `returns-portal` on your computer
3. Put `index.html` inside it
4. Drag the folder into Vercel's deploy dropzone (no build config needed)
5. Vercel gives you: `returns-portal.vercel.app`
6. Share that URL — ops team and Nation.LA use it with their own logins

---

## Step 6 — Test checklist

- [ ] Admin login → sees notifications panel, flag form, notify button
- [ ] Client login → sees table only, no admin panel, no flag controls
- [ ] Open a receipt → View → flag as Damaged → Save flag → badge updates
- [ ] Flag Extra item → SKU / qty fields appear → check 943 box → Save & notify
- [ ] Notification log updates in Supabase → notification_log table
- [ ] Close a receipt in Extensiv → wait 5 min → drops off dashboard
- [ ] Export CSV → check all columns present

---

## How flags + notes persist

Every time ops saves a flag on a receipt, it writes to `receipts_flags` in Supabase.
Both admin and client see the current flag state because it's pulled from the DB on every load.
Closing in Extensiv removes the receipt from the live list — the flag row stays in Supabase
for historical reference (useful later if you want an audit trail).

---

## Adding another client later

1. New Supabase project (or add `customer_id` column + new Edge Function secret)
2. New Vercel deploy pointing to the new project
3. Takes ~1 hour once you've done it once

