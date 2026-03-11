# Incisio Web v2.0

Surgical Procedure Logbook — cloud-synced, offline-first, private accounts.

**Stack:** Vanilla JS · Supabase (auth + database) · Vercel (hosting) · GitHub (source)

---

## Setup Instructions

### Step 1 — Supabase

1. Go to [supabase.com](https://supabase.com) and open your project
2. Go to **SQL Editor → New query**
3. Paste the entire contents of `supabase_setup.sql` and click **Run**
4. Go to **Project Settings → API**
5. Copy your **Project URL** and **anon/public key**

### Step 2 — Add your Supabase keys

Open `public/app.js` and replace the placeholders at the top:

```js
const SUPABASE_URL = 'YOUR_SUPABASE_URL';       // e.g. https://xxxx.supabase.co
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';  // long string starting with eyJ...
```

### Step 3 — Push to GitHub

1. Create a new **public** repository on GitHub (e.g. `incisio-web`)
2. Push this project folder:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/incisio-web.git
git push -u origin main
```

Or use GitHub Desktop — drag the folder in and commit.

### Step 4 — Deploy to Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import your GitHub repository
3. Leave all settings as default — Vercel will detect the config
4. Click **Deploy**
5. Your app is live at `https://incisio-web.vercel.app` (or similar)

### Step 5 — Configure Supabase Auth redirect

1. In Supabase → **Authentication → URL Configuration**
2. Set **Site URL** to your Vercel URL (e.g. `https://incisio-web.vercel.app`)
3. Add the same URL to **Redirect URLs**

---

## Email confirmation

By default Supabase requires email confirmation on signup. To turn this off for internal use:

Supabase → **Authentication → Providers → Email** → disable **Confirm email**

---

## Updating the app

Any push to the `main` branch on GitHub will auto-deploy to Vercel within ~30 seconds.

---

## File structure

```
incisio-v2/
├── public/
│   ├── index.html      ← App shell + HTML
│   ├── style.css       ← All styles
│   └── app.js          ← All logic (auth, sync, UI)
├── supabase_setup.sql  ← Run once in Supabase SQL editor
├── vercel.json         ← Vercel routing config
├── package.json
└── README.md
```

---

## How offline sync works

- Every save writes to **localStorage** first — always instant, always works
- A **pending queue** tracks entries that haven't synced yet
- When online, pending entries are pushed to Supabase in the background
- On login, all cloud entries are pulled down to the device
- The **sync dot** in the top-right shows: 🟢 synced · 🟡 pending · ⚫ offline
