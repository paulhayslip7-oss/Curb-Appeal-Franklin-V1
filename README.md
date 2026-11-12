# Curb Appeal Website v1

Website for **Curb Appeal Franklin** — year-round exterior care sold as one fixed monthly price.

A visitor types their address and, in about a minute, sees their property from above, how big the lawn is, and a **budgetary monthly range** for the plan they build. Every address becomes a lead. Clients get a private dashboard showing their plan and a photo report of every visit.

## What's in it

| Page | Who it's for | What it does |
| --- | --- | --- |
| `/` | Prospects | Address → aerial map → measured yard → pick add-ons → monthly range → create account |
| `/portal.html` | Clients & leads | Plan and price, next visit, visit reports (checklist, crew notes, before/after photos), notes to the crew |
| `/admin.html` | You | Leads pipeline, contact details, confirm price, convert to client, log visits with photos, edit all pricing |

## The annual agreement (e-signature)

After the walkthrough, set the confirmed monthly price on the property in admin and press **Send for signature**. The client sees the agreement on their dashboard, reads it, types their full legal name, ticks a consent box and signs. Signing makes them an active client.

What is recorded with each signature: the typed name, date and time, the account's email, IP address and browser, and a fingerprint (SHA-256) of the exact text that was signed. The signed text is frozen; later changes to prices or terms never alter it. Both you and the client can read it at any time, and the client can print it or save it as a PDF.

The wording of the terms is yours to edit under **Admin → Agreement**. **The default terms are a plain-English starting point, not legal advice. Have a Tennessee attorney review them before relying on them.**

Clients can also text the business number from the home page, the estimate, the agreement and their dashboard. To change that number, edit `public/js/agreement.js` and the `sms:` links in `public/index.html`.

## Over one acre, and reviews

The calculator is for homes under one acre. When the lot at an address is larger, the visitor gets a short form instead of a price. The request is saved to the admin pipeline (tagged "Over 1 acre") and also sent through Netlify Forms, which emails the owner. The destination address is set on the Netlify site (Forms → Notifications), not in this code.

The home page has a reviews section that stays hidden until you add reviews under **Admin → Reviews**. Add only real reviews from real clients.

## How the measuring works

1. **Find the house** — Tennessee's statewide address points (rooftop-accurate), with the US Census geocoder as a fallback.
2. **Outline the buildings** — FEMA's public "USA Structures" footprints.
3. **Find the lot** — the recorded parcel line from Williamson County's parcel map, as published by the City of Franklin (covers the city, its growth boundary and Grassland). Outside that coverage the lot is an educated guess: squared up to the house, from the street to a typical back-yard depth, stopping halfway to each neighbour. Either way the visitor can drag the corners.
4. **Classify the aerial photo** (TDOT 6-inch imagery; Esri as fallback) — pavement, shrubs/plantings, and house are picked out; what's left is lawn.

It is a budgetary tool, not a survey. Expect the lawn figure to be in the right ballpark and the shrub count to be rough; both can be corrected by the visitor on the page and by you after the walkthrough. Known weak spots: addresses outside the parcel coverage (lot shape is a guess), dark asphalt or gravel driveways (read as lawn), and winter imagery (bare trees aren't counted).

## Pricing

All numbers live in **Admin → Pricing** and can be changed without touching code. The defaults (in `public/js/pricing.js`) are typical 2025–26 Middle Tennessee residential rates — treat them as a starting point and tune them to your costs.

**The base plan is all-inclusive.** Every client gets year-round grounds care: lawn, bed weeding, shrub trimming, leaf clearing and mulch top-ups at every visit (about 44 visits a year — weekly March–November, every other week in winter). Those are not sold separately; the pitch is that staying on top of a yard all year means there are never big weed-pull or leaf-removal jobs.

Base plan per visit = lawn (by lawn size) + bed & shrub upkeep (by shrub count and bed size). Yearly = per visit × visits + the year's mulch, split into 12 payments. Example with the defaults: 8,000 sq ft lawn, 15 shrubs, 210 sq ft of beds ≈ $94 a visit ≈ **$350/month**; a half-acre property with a 16,000 sq ft lawn ≈ **$585/month**.

Optional extras (pet waste, pressure washing, aeration, seasonal flowers, porch and patio detailing) are priced per visit × visits per year ÷ 12; weekly pet waste removal adds about $87/month.

**Priced for a crew, not a solo operator.** The defaults aim for about $90–100 of revenue per crew hour including drive time, which keeps crew cost near a third of revenue at roughly $31/hour loaded. Admin shows a private "Does this job pay?" check on every property (estimated crew hours, crew cost, what's left, revenue per crew hour) and flags jobs below your target. The crew-cost assumptions are editable under Admin → Pricing and are never sent to customers.

> **Lawn fertilization & weed control is switched off by default.** Applying those products for hire in Tennessee requires a state pest-control charter and licensed applicator. Turn it on in Admin → Pricing once that's in place.

## Run it on your computer

Needs [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
```

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='pick-a-long-password' npm start
```

Open http://localhost:3000. Sign in at `/admin.html` with that email and password. Data is saved in the `data/` folder.

```bash
npm test
```

## Put it online (Netlify)

The repo is ready for Netlify: pages are served from `public/`, the API runs as a Netlify Function, and data is kept in Netlify Blobs (no database to set up).

1. In Netlify: **Add new site → Import an existing project** and pick this repository. The build settings are read from `netlify.toml`.
2. Under **Site configuration → Environment variables** add:
   - `ADMIN_EMAIL` — the email you'll sign in to the admin with
   - `ADMIN_PASSWORD` — a long password
   - `SESSION_SECRET` — any long random string
3. Deploy.

Live site: https://curb-appeal-franklin-v1.netlify.app

The first deploy was pushed straight from the command line, so the Netlify site is not yet connected to this repository. To have every change deploy automatically, open the site in Netlify → **Project configuration → Build & deploy → Link repository**. Until then, redeploy by hand:

```bash
npx netlify-cli deploy --prod --no-build --dir public --functions netlify/functions
```

After changing an environment variable, redeploy for it to take effect.

It also runs on any Node host with a persistent disk (`npm start`, set `DATA_DIR`).

## Good next steps

- **Email/text alerts** when a new lead signs up or a client leaves a note (today you check the admin page).
- **Real parcel lines** via a paid parcel API (e.g. Regrid) to replace the lot guess.
- **Password reset** by email.
- **Online payments** (Stripe subscriptions) for the fixed monthly charge.
- **Imagery terms** — TDOT imagery is public. Esri World Imagery (fallback only) may need an ArcGIS account for commercial use.

## Layout

```
public/            pages, styles and browser code
  js/analyze.js    aerial-image yard measurement
  js/pricing.js    pricing engine + default rates (shared with the server)
src/app.js         the API (accounts, estimates, visits, photos, admin)
src/geo.js         address lookup, building footprints, lot guess
src/store.js       storage: files locally, Netlify Blobs when deployed
server.js          local / any-host server
netlify/           Netlify entry point
test/              automated tests
```
