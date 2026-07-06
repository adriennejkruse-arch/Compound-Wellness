# The Compound Wellness — Setup Guide

## What's In This Folder

```
compound-wellness/
├── index.html          ← Main website (all pages)
├── booking.html        ← Booking flow (Stripe integrated)
├── server.js           ← Backend (Stripe, Airtable, Klaviyo, SendGrid)
├── package.json        ← Node dependencies
├── .env.example        ← Copy to .env and fill in your keys
├── *.jpg               ← All site images
└── SETUP.md            ← This file
```

---

## Step 1 — Copy Environment File

```bash
cp .env.example .env
```

Then open `.env` and fill in each key. Instructions for each service are below.

---

## Step 2 — Stripe

1. Go to **dashboard.stripe.com** → Developers → API Keys
2. Copy your **Publishable key** (starts with `pk_live_`) and **Secret key** (starts with `sk_live_`)
3. Add to `.env`:
   ```
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_PUBLISHABLE_KEY=pk_live_...
   ```
4. Open `booking.html`, find this line near the bottom:
   ```js
   const STRIPE_PUBLISHABLE_KEY = 'pk_live_YOUR_KEY_HERE';
   ```
   Replace `pk_live_YOUR_KEY_HERE` with your actual publishable key.

5. **Webhook** (receives payment confirmations from Stripe):
   - In Stripe Dashboard → Developers → Webhooks → Add endpoint
   - URL: `https://yourdomain.com/api/stripe-webhook`
   - Events to listen for: `payment_intent.succeeded`
   - Copy the **Signing secret** → add to `.env` as `STRIPE_WEBHOOK_SECRET`

> **Test mode:** Use `pk_test_...` and `sk_test_...` keys while testing. Stripe test card: `4242 4242 4242 4242`, any future date, any CVC.

---

## Step 3 — Airtable

1. Go to **airtable.com** → create a free account
2. Create a new Base called **"Compound Wellness"**
3. Create two tables inside it:

   **Table 1: "Contacts"** — columns:
   - Name (Single line text)
   - Email (Email)
   - Phone (Phone number)
   - City (Single line text)
   - Practitioner (Single line text)
   - Role (Single line text)
   - Notes (Long text)
   - Availability (Single line text)
   - Consult Time (Single line text)
   - Source (Single line text)
   - Status (Single select: New Lead, Contacted, Booked, Inactive)
   - Created (Date)

   **Table 2: "Bookings"** — columns:
   - Name (Single line text)
   - Email (Email)
   - Practitioner (Single line text)
   - Service (Single line text)
   - Date (Single line text)
   - Time (Single line text)
   - Amount Paid (Currency)
   - Status (Single select: Confirmed, Cancelled, Refunded)
   - Stripe ID (Single line text)
   - Source (Single line text)
   - Created (Date)

4. Get your **API Key**:
   - Go to airtable.com/account → Developer hub → Personal access tokens
   - Create a token with `data.records:read` and `data.records:write` scopes
   - Add to `.env` as `AIRTABLE_API_KEY`

5. Get your **Base ID**:
   - Open your base → click the ? Help icon → API Documentation
   - The Base ID is the string starting with `app...` in the URL
   - Add to `.env` as `AIRTABLE_BASE_ID`

---

## Step 4 — Klaviyo (Email Marketing)

1. Go to **klaviyo.com** → create a free account (free up to 500 contacts)
2. Go to Account → Settings → API Keys → Create Private API Key
3. Add to `.env` as `KLAVIYO_API_KEY`
4. Create 3 lists in Klaviyo (Audience → Lists):
   - "All Contacts" → copy the List ID → `KLAVIYO_LIST_ID`
   - "Bookings" → copy → `KLAVIYO_BOOKINGS_LIST_ID`
   - "Inquiries" → copy → `KLAVIYO_INQUIRIES_LIST_ID`
   
   (List IDs are 6-character strings in the URL when you click a list)

5. **Set up drip sequences** in Klaviyo:
   - Create a Flow triggered by "Added to List → Inquiries"
   - Add a 24-hour delay, then a follow-up email
   - Create a separate Flow for "Added to List → Bookings" (post-session check-in, etc.)

---

## Step 5 — SendGrid (Transactional Email)

1. Go to **sendgrid.com** → create a free account (100 emails/day free)
2. Settings → API Keys → Create API Key (Full Access)
3. Add to `.env` as `SENDGRID_API_KEY`
4. Verify your sender email in SendGrid → Sender Authentication
5. Add to `.env`:
   ```
   FROM_EMAIL=hello@thecompoundwellness.com
   INTERNAL_NOTIFY_EMAIL=adrienne@thecompoundwellness.com
   ```

---

## Step 6 — Deploy to Railway

```bash
# Install dependencies
npm install

# Test locally first
npm run dev
# Visit http://localhost:3000

# Deploy
npm install -g @railway/cli
railway login
railway init
railway up
```

In Railway dashboard → your project → Variables, add all the variables from your `.env` file.

Then: Settings → Networking → add your custom domain.

---

## How Data Flows

```
User fills booking form (Coco)
  → Stripe Payment Intent created via POST /api/create-payment-intent
  → Stripe confirms payment
  → Stripe fires webhook to POST /api/stripe-webhook
  → server.js saves to Airtable "Bookings" table
  → server.js adds contact to Klaviyo "Bookings" list
  → server.js sends confirmation email via SendGrid
  → server.js sends internal notification to your email

User fills inquiry form (everyone else)
  → POST /api/submit-inquiry
  → server.js saves to Airtable "Contacts" table
  → server.js adds contact to Klaviyo "Inquiries" list
  → server.js sends auto-reply email via SendGrid
  → server.js sends internal notification to your email
```

---

## Costs

| Service | Free Tier | Paid |
|---------|-----------|------|
| Stripe | No monthly fee | 2.9% + 30¢ per transaction |
| Airtable | 1,000 records free | $20/mo for 50,000 records |
| Klaviyo | 500 contacts free | $45/mo for 5,000 contacts |
| SendGrid | 100 emails/day free | $20/mo for 50,000 emails |
| Railway | $5/mo hobby plan | $20/mo pro |

**Total to start: ~$5/month** (Railway only, everything else on free tiers)

---

## Questions?

Contact your developer or reply to the Claude conversation where this was built.
