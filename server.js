/**
 * The Compound Wellness — Backend Server
 * ─────────────────────────────────────────────────────────
 * Handles:
 *   POST /api/create-payment-intent   — Stripe payment flow
 *   POST /api/confirm-booking         — Save booking to Airtable + send confirmation email
 *   POST /api/submit-inquiry          — Save inquiry to Airtable + add to Klaviyo
 *   GET  /api/health                  — Health check
 *
 * Required environment variables (see .env.example):
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET
 *   AIRTABLE_API_KEY
 *   AIRTABLE_BASE_ID
 *   KLAVIYO_API_KEY
 *   SENDGRID_API_KEY (optional — for confirmation emails)
 *   FROM_EMAIL
 * ─────────────────────────────────────────────────────────
 */

require('dotenv').config({ path: '.env' });
require('dotenv').config({ path: '.env.local' });
const express    = require('express');
const path       = require('path');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Airtable   = require('airtable');
const axios      = require('axios');
const { google } = require('googleapis');
const { clerkClient, requireAuth } = require('@clerk/express');

// A failed background task (an email, a Klaviyo call) must never crash the whole site.
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err && err.message));

const app  = express();
const PORT = process.env.PORT || 3000;
// Railway sits in front of this app as a proxy — trust its X-Forwarded-For
// header so req.ip reflects the real client, not Railway's edge IP
// (needed for the admin-login rate limiter below to work per-client).
app.set('trust proxy', 1);

// ── Google OAuth2 client ─────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:3000/oauth/callback'
);
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}
const gmail      = google.gmail({ version: 'v1', auth: oauth2Client });
const calendar   = google.calendar({ version: 'v3', auth: oauth2Client });
const analyticsdata = google.analyticsdata({ version: 'v1beta', auth: oauth2Client });

// ── Airtable setup ───────────────────────────────────────
const base = process.env.AIRTABLE_API_KEY
  ? new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID)
  : null;

// ── Middleware ───────────────────────────────────────────
// Raw body needed for Stripe webhook signature verification
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
// JSON body for all other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Security headers ─────────────────────────────────────
// CSP starts in Report-Only mode — it logs violations to the browser console
// instead of blocking anything. Flip CSP_ENFORCE=1 in Railway once a full
// manual pass (booking payment, portal login, admin dashboard) shows no
// console violations, then remove the Report-Only fallback below.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://connect.facebook.net https://www.googletagmanager.com https://js.stripe.com https://cdnjs.cloudflare.com https://smart-gannet-54.clerk.accounts.dev",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://www.facebook.com https://connect.facebook.net https://api.bufferapp.com https://api.stripe.com https://m.stripe.com https://m.stripe.network https://smart-gannet-54.clerk.accounts.dev https://www.google-analytics.com https://region1.google-analytics.com https://analytics.google.com https://cdnjs.cloudflare.com",
  "frame-src https://js.stripe.com https://hooks.stripe.com https://smart-gannet-54.clerk.accounts.dev https://www.google.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  const cspHeader = process.env.CSP_ENFORCE === '1'
    ? 'Content-Security-Policy'
    : 'Content-Security-Policy-Report-Only';
  res.setHeader(cspHeader, CSP_DIRECTIVES);
  next();
});

// Serve static files (HTML, images, etc.) — only from public/, never the project root,
// so package.json/package-lock.json/node_modules/.env are never web-accessible.
app.use(express.static(path.join(__dirname, 'public')));


// ════════════════════════════════════════════════════════
// STRIPE — Create Payment Intent
// Called when user reaches payment step in booking.html
// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
// STRIPE — Webhook (payment confirmed by Stripe)
// Stripe calls this automatically after payment succeeds
// ════════════════════════════════════════════════════════
app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const m  = pi.metadata;

    // Wednesday Meditation donations are not bookings — handle them separately.
    if (m && m.type === 'donation') {
      try { await wednesday.handleDonationPaid(pi); }
      catch (err) { alertSlack('donation-webhook', 'A donation was paid but follow-up failed', err.message); }
      return res.json({ received: true });
    }

    // Portal payments and anything else without booking details are acknowledged and skipped.
    if (!m || !m.clientName) return res.json({ received: true });

    // Save confirmed booking to Airtable
    await saveToAirtable('Bookings', {
      'Booking Reference': `${m.clientName} — ${m.date}`,
      'Practitioner':      m.practitioner,
      'Service':           m.service,
      'Date':              m.date,
      'Time':              m.time,
      'Price':             parseFloat((pi.amount / 100).toFixed(2)),
      'Status':            'Confirmed',
    });

    // Add to Klaviyo marketing list
    await addToKlaviyo({
      email:       m.clientEmail,
      firstName:   m.clientName.split(' ')[0] || m.clientName,
      lastName:    m.clientName.split(' ').slice(1).join(' ') || '',
      source:      'Website booking',
      listId:      process.env.KLAVIYO_BOOKINGS_LIST_ID || process.env.KLAVIYO_LIST_ID,
    });

    // Create Google Calendar event with Meet link
    const meetLink = await createCalendarEvent({
      clientName:   m.clientName,
      clientEmail:  m.clientEmail,
      practitioner: m.practitioner,
      service:      m.service,
      date:         m.date,
      time:         m.time,
    });

    // Send confirmation email to client
    await sendConfirmationEmail({
      to:           m.clientEmail,
      clientName:   m.clientName,
      practitioner: m.practitioner,
      service:      m.service,
      date:         m.date,
      time:         m.time,
      amount:       (pi.amount / 100).toFixed(2),
      meetLink,
    });

    // Send internal notification
    await sendInternalNotification({
      type:         'New Booking',
      clientName:   m.clientName,
      clientEmail:  m.clientEmail,
      practitioner: m.practitioner,
      service:      m.service,
      date:         m.date,
      time:         m.time,
      amount:       (pi.amount / 100).toFixed(2),
    });

    console.log('✓ Booking confirmed');
  }

  res.json({ received: true });
});


// ════════════════════════════════════════════════════════
// PRIVACY HELPERS — medical practitioners get "super generic" treatment
// ════════════════════════════════════════════════════════
// Dr. Colombo, Dr. Adams and Christine Winnen provide medical care, so nothing about who they saw, or
// when, is sent to Slack or Klaviyo. The other practitioners are not medical and keep normal detail.
function isMedicalPractitioner(practitioner, pracRole) {
  return /colombo|adams|winnen/i.test(String(practitioner || '')) || ['angela', 'andrew', 'christine'].includes(String(pracRole || '').toLowerCase());
}

// ── Meta Conversions API (server side). Does nothing unless META_PIXEL_ID and META_CAPI_TOKEN are set,
// the visitor accepted cookies, and the request came from a Meta ad. Sends hashed contact details and a
// generic "Lead" event only: no practitioner, service, notes or health information.
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const sha256 = v => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
function cleanAd(ad) {
  if (!ad || typeof ad !== 'object') return null;
  const t = (v, n = 80) => (typeof v === 'string' ? v.replace(/[^\w .:@+\-]/g, '').slice(0, n) : '');
  const fb = v => (typeof v === 'string' && /^fb\.\d\.\d+\.[\w-]+$/.test(v) ? v : null);
  return {
    source: t(ad.source), medium: t(ad.medium), campaign: t(ad.campaign), content: t(ad.content), term: t(ad.term),
    landed: typeof ad.landed === 'string' && /^\/[\w\-\/]*$/.test(ad.landed) ? ad.landed : '/start',
    consent: ad.consent === true, eventId: typeof ad.eventId === 'string' && /^[\w-]{8,64}$/.test(ad.eventId) ? ad.eventId : null,
    fbp: fb(ad.fbp), fbc: fb(ad.fbc),
  };
}
async function sendMetaLead({ ad, email, phone, firstName, lastName, req }) {
  const pixelId = process.env.META_PIXEL_ID, token = process.env.META_CAPI_TOKEN;
  if (process.env.META_PIXEL_APPROVED !== '1' || !pixelId || !token || !ad || !ad.consent || !ad.eventId) return;
  const d = String(phone || '').replace(/\D/g, '');
  const ph = d.length === 10 ? '1' + d : (d.length === 11 && d[0] === '1' ? d : null);
  const user_data = { em: [sha256(email)], fn: [sha256(firstName || '')], client_ip_address: req.ip, client_user_agent: req.get('user-agent') || '' };
  if (lastName) user_data.ln = [sha256(lastName)];
  if (ph) user_data.ph = [sha256(ph)];
  if (ad.fbp) user_data.fbp = ad.fbp;
  if (ad.fbc) user_data.fbc = ad.fbc;
  const body = {
    data: [{ event_name: 'Lead', event_time: Math.floor(Date.now() / 1000), event_id: ad.eventId, action_source: 'website',
             event_source_url: 'https://www.compoundoc.com' + ad.landed, user_data }],
  };
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;
  try {
    await axios.post(`https://graph.facebook.com/${META_GRAPH_VERSION}/${pixelId}/events`, body, { params: { access_token: token }, timeout: 5000 });
    console.log('✓ Meta CAPI: Lead sent');
  } catch (err) {
    const status = err.response && err.response.status;
    const msg = (err.response && err.response.data && err.response.data.error && err.response.data.error.message) || err.message;
    alertSlack('meta-capi', 'Meta Conversions API is failing', `${status || ''} ${msg}`.slice(0, 250));
  }
}

app.get('/api/meta-config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  // Off unless the owner has approved it (META_PIXEL_APPROVED=1), e.g. after legal review.
  res.json({ pixelId: process.env.META_PIXEL_APPROVED === '1' ? (process.env.META_PIXEL_ID || null) : null });
});

// ════════════════════════════════════════════════════════
// INQUIRY SUBMISSION
// For Adrienne, Andrew, Christine, Branden (inquiry-only)
// ════════════════════════════════════════════════════════
const inquiryHits = new Map();
function inquiryTooMany(ip, max = 20, windowMs = 60 * 60 * 1000) {
  const now = Date.now();
  const hits = (inquiryHits.get(ip) || []).filter(t => now - t < windowMs);
  hits.push(now); inquiryHits.set(ip, hits);
  return hits.length > max;
}

app.post('/api/submit-inquiry', async (req, res) => {
  try {
    let {
      firstName, lastName, email, phone,
      city, notes, availability,
      practitioner, pracRole,
      consultTime,  // for Angela/Adrienne consult slot
      service, price, date, time,
      source = 'Website',
    } = req.body;
    const cap = (v, n) => String(v == null ? '' : v).slice(0, n);
    firstName = cap(firstName, 80); lastName = cap(lastName, 80); email = cap(email, 120).trim(); phone = cap(phone, 30);
    city = cap(city, 80); notes = cap(notes, 3000); practitioner = cap(practitioner, 80);
    const ad = cleanAd(req.body.ad);
    const medical = isMedicalPractitioner(practitioner, pracRole) || !practitioner;   // no practitioner = could be medical

    // Map incoming source values to allowed Airtable single-select options
    const sourceMap = {
      'Website Inquiry':          'Website',
      'Online Booking':           'Booking Request',
      'Booking Request — Online': 'Booking Request',
      'Booking — Angela Consult': 'Angela Consult',
      'Angela Consult':           'Angela Consult',
      'Booking — Adrienne Free Zoom': 'Adrienne Zoom',
      'Adrienne Zoom':            'Adrienne Zoom',
      'Booking — Inquiry':        'Inquiry',
      'Referral':                 'Referral',
      'Event':                    'Event',
    };
    const airtableSource = sourceMap[source] || 'Inquiry';

    if (!firstName || !email) {
      return res.status(400).json({ error: 'Name and email are required.' });
    }
    if (inquiryTooMany(req.ip)) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    if (!/^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]{2,}$/.test(String(email)) || String(email).length > 120) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const fullName = `${firstName} ${lastName}`.trim();
    // Which ad brought them here (campaign names only). Stored with the request, never sent to Slack or Klaviyo.
    const adNote = ad && ad.consent && (ad.source || ad.campaign) ? 'Ad attribution: ' + [ad.source, ad.medium, ad.campaign, ad.content].filter(Boolean).join(' / ') : '';
    const notesWithAd = [notes, adNote].filter(Boolean).join('\n');
    const ref = String(crypto.randomInt(1000, 10000));   // short reference shown in Slack and searchable in Airtable

    // Resolve the date/time string — some flows use `date`+`time`, others pack it into `consultTime`
    const requestedDate = date || consultTime || '';
    const requestedTime = time || '';

    // Save contact info only to Contacts table
    const contactRecord = await saveToAirtable('Contacts', {
      'Name':            fullName,
      'Email':           email,
      'Phone':           phone  || '',
      'City':            city   || '',
      'Notes':           notesWithAd,
      'Source Form':     airtableSource,
      'Submission Date': nowPST(),
    });

    // Save booking details to Booking Requests table, linked back to the contact
    const bookingFields = {
      'Request Name':           `${fullName} — ${practitioner || 'General'} (#${ref})`,
      'Client Name':            fullName,
      'Requested Practitioner': practitioner || '',
      'Requested Time':         requestedTime,
      'Inquiry Details':        [service, availability ? `Availability: ${availability}` : '', notesWithAd].filter(Boolean).join('\n') || '',
      'Submission Date (PST)':  nowPST(),
      'Status':                 'Pending',
    };
    if (requestedDate) {
      const d = new Date(requestedDate);
      if (!isNaN(d)) bookingFields['Requested Date'] = d.toISOString().split('T')[0];
    }
    if (contactRecord) bookingFields['Related Contact'] = [contactRecord.id];
    await saveToAirtable('Booking Requests', bookingFields);

    // Add to Klaviyo inquiries list
    await addToKlaviyo({
      email,
      firstName,
      lastName:    lastName || '',
      phone,
      // Medical practitioners: nothing but name, contact details and time. Others may include who it was for.
      source:      medical ? 'Website inquiry' : 'Inquiry — ' + practitioner,
      listId:      process.env.KLAVIYO_INQUIRIES_LIST_ID || process.env.KLAVIYO_LIST_ID,
    });

    // Auto-reply to client
    await sendAutoReply({ to: email, firstName, practitioner: medical ? '' : practitioner, consultTime: medical ? '' : consultTime });

    // Internal notification
    await sendInternalNotification({
      type:        'New Inquiry',
      ref:         '#' + ref,
      clientName:  fullName,
      clientEmail: email,
      practitioner,
      notes: notesWithAd,
      consultTime,
    });

    const isContactForm = source === 'Website Inquiry';
    if (medical) {
      // Super generic: just a reference to look up in the secure system.
      notifySlack({
        title: `${isContactForm ? 'NEW INQUIRY' : 'NEW BOOKING'} — #${ref}`,
        lines: [isContactForm ? 'New inquiry received.' : 'New appointment received.'],
        link: 'Open secure booking system.',
      });
    } else {
      notifySlack({
        title: `NEW BOOKING — #${ref}`,
        lines: [
          `*From:* ${fullName}`,
          `*Practitioner:* ${practitioner}`,
          (requestedDate || requestedTime) ? `*Requested:* ${[requestedDate, requestedTime].filter(Boolean).join(' · ')}` : '',
        ],
        link: 'Open secure booking system.',
      });
    }

    // Ad conversion (only with consent, from a Meta ad, and once the Meta keys are set)
    if (!medical) sendMetaLead({ ad, email, phone, firstName, lastName, req }).catch(() => {});   // never for medical practitioners

    res.json({ success: true });
  } catch (err) {
    console.error('Inquiry submission error:', err.message);
    res.status(500).json({ error: 'Submission failed. Please try again.' });
  }
});


// ════════════════════════════════════════════════════════
// ADMIN AUTH — server-issued session tokens (not the raw
// password) with expiry, plus server-side login rate limiting.
// ════════════════════════════════════════════════════════
const crypto = require('crypto');

const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours — matches admin.html's client-side TTL
// Stateless signed tokens (expiry + HMAC keyed by ADMIN_PASSWORD) so sessions
// survive deploys/restarts, and changing ADMIN_PASSWORD signs everyone out.

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 60 * 1000;
const loginAttemptsByIp = new Map(); // ip -> { count, lockedUntil }

function safeCompare(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function signAdminToken(expiry) {
  const body = String(expiry);
  const sig = crypto.createHmac('sha256', process.env.ADMIN_PASSWORD).update(body).digest('hex');
  return `${body}.${sig}`;
}

function verifyAdminToken(token) {
  if (!process.env.ADMIN_PASSWORD || typeof token !== 'string') return false;
  const [body, sig] = token.split('.');
  const expiry = Number(body);
  if (!body || !sig || !expiry || expiry < Date.now()) return false;
  const expected = crypto.createHmac('sha256', process.env.ADMIN_PASSWORD).update(body).digest('hex');
  return safeCompare(sig, expected);
}

function adminAuth(req, res, next) {
  if (!verifyAdminToken(req.headers['x-admin-key'] || '')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/api/admin/auth', (req, res) => {
  const ip = req.ip;
  const attempt = loginAttemptsByIp.get(ip) || { count: 0, lockedUntil: 0 };
  if (attempt.lockedUntil > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
  }

  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) {
    console.error('ADMIN_PASSWORD is not set — admin login is disabled until it is configured in Railway.');
    return res.status(503).json({ error: 'Admin login is not configured.' });
  }

  const { password } = req.body;
  if (password && safeCompare(password, pass)) {
    loginAttemptsByIp.delete(ip);
    const token = signAdminToken(Date.now() + ADMIN_SESSION_TTL_MS);
    return res.json({ ok: true, token });
  }

  attempt.count += 1;
  if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
    attempt.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    attempt.count = 0;
  }
  loginAttemptsByIp.set(ip, attempt);
  res.status(401).json({ error: 'Invalid credentials' });
});

// Tokens are stateless, so logout just tells the client to discard its token.
app.post('/api/admin/logout', (req, res) => res.json({ ok: true }));

app.get('/api/admin/contacts', adminAuth, async (req, res) => {
  if (!base) return res.json({ contacts: [] });
  try {
    const records = await base('Contacts').select({
      sort: [{ field: 'Submission Date', direction: 'desc' }],
      maxRecords: 200,
    }).all();
    const contacts = records.map(r => ({
      id: r.id,
      name:         r.fields['Name'] || '',
      email:        r.fields['Email'] || '',
      phone:        r.fields['Phone'] || '',
      city:         r.fields['City'] || '',
      source:       r.fields['Source Form'] || '',
      notes:        r.fields['Notes'] || '',
      status:       r.fields['Status'] || 'New Lead',
      created:      r.fields['Submission Date'] ? new Date(r.fields['Submission Date']).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '',
    }));
    res.json({ contacts });
  } catch (err) {
    console.error('Admin contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/bookings', adminAuth, async (req, res) => {
  if (!base) return res.json({ bookings: [] });
  try {
    const records = await base('Booking Requests').select({
      sort: [{ field: 'Submission Date (PST)', direction: 'desc' }],
      maxRecords: 200,
    }).all();
    const bookings = records.map(r => ({
      id:           r.id,
      name:         r.fields['Client Name'] || '',
      practitioner: r.fields['Requested Practitioner'] || '',
      service:      r.fields['Inquiry Details'] || '',
      date:         r.fields['Requested Date'] || '',
      time:         r.fields['Requested Time'] || '',
      amount:       r.fields['Amount'] || 0,
      status:       r.fields['Status'] || 'Pending',
      stripe:       r.fields['Stripe Payment Intent'] || '—',
      submitted:    r.fields['Submission Date (PST)'] ? new Date(r.fields['Submission Date (PST)']).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '',
    }));
    res.json({ bookings });
  } catch (err) {
    console.error('Admin bookings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const BOOKING_STATUSES = ['Pending', 'Confirmed', 'Cancelled'];

app.patch('/api/admin/bookings/:id', adminAuth, async (req, res) => {
  const { status } = req.body;
  if (!BOOKING_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${BOOKING_STATUSES.join(', ')}` });
  }
  if (!base) return res.status(503).json({ error: 'Airtable not configured' });
  try {
    await base('Booking Requests').update(req.params.id, { 'Status': status });
    res.json({ success: true });
  } catch (err) {
    console.error('Update booking status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/ga4', adminAuth, async (req, res) => {
  const propertyId = process.env.GOOGLE_GA4_PROPERTY_ID;
  if (!propertyId || !process.env.GOOGLE_REFRESH_TOKEN) {
    return res.json({ configured: false });
  }
  try {
    const days = parseInt(req.query.days || '30');
    const startDate = `${days}daysAgo`;

    const [trafficRes, sourcesRes, pagesRes] = await Promise.all([
      // Daily sessions over time
      analyticsdata.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [{ startDate, endDate: 'today' }],
          dimensions: [{ name: 'date' }],
          metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
          orderBys: [{ dimension: { dimensionName: 'date' } }],
        },
      }),
      // Traffic sources
      analyticsdata.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [{ startDate, endDate: 'today' }],
          dimensions: [{ name: 'sessionDefaultChannelGroup' }],
          metrics: [{ name: 'sessions' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 6,
        },
      }),
      // Top pages
      analyticsdata.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [{ startDate, endDate: 'today' }],
          dimensions: [{ name: 'pageTitle' }],
          metrics: [{ name: 'screenPageViews' }],
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: 8,
        },
      }),
    ]);

    // Format traffic timeline
    const totalSessions = trafficRes.data.rows?.reduce((s, r) => s + parseInt(r.metricValues[0].value || 0), 0) || 0;
    const traffic = (trafficRes.data.rows || []).map(r => ({
      date: r.dimensionValues[0].value, // YYYYMMDD
      sessions: parseInt(r.metricValues[0].value || 0),
      users: parseInt(r.metricValues[1].value || 0),
    }));

    // Format sources
    const sourceRows = sourcesRes.data.rows || [];
    const sourceTotal = sourceRows.reduce((s, r) => s + parseInt(r.metricValues[0].value || 0), 0) || 1;
    const sources = sourceRows.map(r => ({
      label: r.dimensionValues[0].value,
      sessions: parseInt(r.metricValues[0].value || 0),
      pct: Math.round((parseInt(r.metricValues[0].value || 0) / sourceTotal) * 100),
    }));

    // Format pages
    const pageTotal = pagesRes.data.rows?.reduce((s, r) => s + parseInt(r.metricValues[0].value || 0), 0) || 1;
    const pages = (pagesRes.data.rows || []).map(r => ({
      title: r.dimensionValues[0].value,
      views: parseInt(r.metricValues[0].value || 0),
      pct: Math.round((parseInt(r.metricValues[0].value || 0) / pageTotal) * 100),
    }));

    res.json({ configured: true, totalSessions, traffic, sources, pages });
  } catch (err) {
    console.error('GA4 error:', err.message);
    alertSlack('ga4', 'GA4 analytics is failing', err.message);
    res.json({ configured: false, error: err.message });
  }
});

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  if (!base) return res.json({ contacts: 0, bookings: 0, pending: 0, confirmed: 0 });
  try {
    const [contactRecs, bookingRecs] = await Promise.all([
      base('Contacts').select({ fields: ['Name'], maxRecords: 500 }).all(),
      base('Booking Requests').select({ fields: ['Status', 'Amount'], maxRecords: 500 }).all(),
    ]);
    const pending   = bookingRecs.filter(r => r.fields['Status'] === 'Pending').length;
    const confirmed = bookingRecs.filter(r => r.fields['Status'] === 'Confirmed').length;
    const revenue   = bookingRecs.reduce((s,r) => s + (r.fields['Amount'] || 0), 0);
    res.json({
      contacts:  contactRecs.length,
      bookings:  bookingRecs.length,
      pending,
      confirmed,
      revenue,
    });
  } catch (err) {
    console.error('Admin stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));


// ════════════════════════════════════════════════════════
// PORTAL — Get member's bookings from Airtable
// Requires valid Clerk session token in Authorization header
// ════════════════════════════════════════════════════════
app.get('/api/portal/bookings', requireAuth(), async (req, res) => {
  try {
    const { userId } = req.auth;
    const user = await clerkClient.users.getUser(userId);
    const email = user.emailAddresses[0]?.emailAddress;
    if (!email) return res.status(400).json({ error: 'No email on account' });

    if (!base) return res.json({ bookings: [], contacts: [] });

    // Find bookings by matching email via Related Contact
    const contacts = await base('Contacts').select({
      filterByFormula: `{Email} = "${email}"`,
      maxRecords: 1,
    }).firstPage();

    if (!contacts.length) return res.json({ bookings: [] });

    const contactId = contacts[0].id;
    const contactName = contacts[0].fields['Name'] || '';

    const bookingRecords = await base('Booking Requests').select({
      filterByFormula: `FIND("${contactId}", ARRAYJOIN({Related Contact}))`,
      sort: [{ field: 'Submission Date (PST)', direction: 'desc' }],
      maxRecords: 50,
    }).firstPage();

    const bookings = bookingRecords.map(r => ({
      id:          r.id,
      name:        r.fields['Request Name'] || '',
      practitioner:r.fields['Requested Practitioner'] || '',
      date:        r.fields['Requested Date'] || '',
      time:        r.fields['Requested Time'] || '',
      status:      r.fields['Status'] || 'Pending',
      details:     r.fields['Inquiry Details'] || '',
      amount:      r.fields['Amount'] || 0,
      paymentStatus: r.fields['Payment Status'] || '',
      stripePaymentIntentId: r.fields['Stripe Payment Intent'] || '',
    }));

    res.json({ bookings, memberName: contactName });
  } catch (err) {
    console.error('Portal bookings error:', err.message);
    res.status(500).json({ error: 'Failed to load bookings' });
  }
});


// ════════════════════════════════════════════════════════
// PORTAL — Create Stripe Customer + setup intent for saving card
// ════════════════════════════════════════════════════════
app.post('/api/portal/setup-payment', requireAuth(), async (req, res) => {
  try {
    const { userId } = req.auth;
    const user = await clerkClient.users.getUser(userId);
    const email = user.emailAddresses[0]?.emailAddress;
    const name  = `${user.firstName || ''} ${user.lastName || ''}`.trim();

    // Get or create Stripe customer, storing customerId in Clerk user metadata
    let customerId = user.privateMetadata?.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email, name });
      customerId = customer.id;
      await clerkClient.users.updateUserMetadata(userId, {
        privateMetadata: { stripeCustomerId: customerId },
      });
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
    });

    res.json({ clientSecret: setupIntent.client_secret, customerId });
  } catch (err) {
    console.error('Setup payment error:', err.message);
    res.status(500).json({ error: 'Failed to set up payment' });
  }
});


// ════════════════════════════════════════════════════════
// PORTAL — Pay for a confirmed booking using saved card
// ════════════════════════════════════════════════════════
// Switched off: this route took the booking and the amount from the browser without checking the booking
// belongs to the signed-in member. Rebuild it to look the amount up server-side before re-enabling.
app.post('/api/portal/pay-booking', requireAuth(), (req, res) => {
  res.status(503).json({ error: 'Online payment from the portal is not available yet. Please contact us to pay.' });
});


// ════════════════════════════════════════════════════════
// PORTAL — Get saved payment methods for current user
// ════════════════════════════════════════════════════════
app.get('/api/portal/payment-methods', requireAuth(), async (req, res) => {
  try {
    const { userId } = req.auth;
    const user = await clerkClient.users.getUser(userId);
    const customerId = user.privateMetadata?.stripeCustomerId;

    if (!customerId) return res.json({ paymentMethods: [] });

    const paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
    res.json({
      paymentMethods: paymentMethods.data.map(pm => ({
        id:    pm.id,
        brand: pm.card.brand,
        last4: pm.card.last4,
        exp:   `${pm.card.exp_month}/${pm.card.exp_year}`,
      }))
    });
  } catch (err) {
    console.error('Payment methods error:', err.message);
    res.status(500).json({ error: 'Failed to load payment methods' });
  }
});


// ════════════════════════════════════════════════════════
// ROBOTS.TXT
// ════════════════════════════════════════════════════════
app.get('/robots.txt', (req, res) => {
  res.set('Content-Type', 'text/plain').send(
`User-agent: *
Allow: /
Disallow: /admin.html
Disallow: /portal.html

Sitemap: https://compoundoc.com/sitemap.xml`
  );
});

// ════════════════════════════════════════════════════════
// SITEMAP
// ════════════════════════════════════════════════════════
app.get('/sitemap.xml', (req, res) => {
  const base = 'https://compoundoc.com';
  const today = new Date().toISOString().split('T')[0];
  const urls = [
    { loc: '/',                                  priority: '1.0', freq: 'weekly' },
    { loc: '/pathways',                          priority: '0.9', freq: 'monthly' },
    { loc: '/pathways/reset',                    priority: '0.8', freq: 'monthly' },
    { loc: '/pathways/foundation',               priority: '0.8', freq: 'monthly' },
    { loc: '/pathways/elevation',                priority: '0.8', freq: 'monthly' },
    { loc: '/practitioners',                     priority: '0.9', freq: 'monthly' },
    { loc: '/practitioners/dr-angela-colombo',   priority: '0.8', freq: 'monthly' },
    { loc: '/practitioners/dr-andrew-adams',     priority: '0.8', freq: 'monthly' },
    { loc: '/practitioners/adrienne-kruse',      priority: '0.8', freq: 'monthly' },
    { loc: '/practitioners/christine-winnen',    priority: '0.8', freq: 'monthly' },
    { loc: '/practitioners/coco-poovey',         priority: '0.8', freq: 'monthly' },
    { loc: '/practitioners/branden-carrisalez',  priority: '0.8', freq: 'monthly' },
    { loc: '/services',                          priority: '0.9', freq: 'monthly' },
    { loc: '/services/concierge-medicine',       priority: '0.8', freq: 'monthly' },
    { loc: '/services/holistic-enclave',         priority: '0.8', freq: 'monthly' },
    { loc: '/services/individual-services',      priority: '0.8', freq: 'monthly' },
    { loc: '/services/cohorts',                  priority: '0.8', freq: 'monthly' },
    { loc: '/partnerships',                      priority: '0.7', freq: 'monthly' },
    { loc: '/partnerships/corporate',            priority: '0.7', freq: 'monthly' },
    { loc: '/partnerships/hotels',               priority: '0.7', freq: 'monthly' },
    { loc: '/partnerships/residential',          priority: '0.7', freq: 'monthly' },
    { loc: '/partnerships/weddings',             priority: '0.7', freq: 'monthly' },
    { loc: '/about',                             priority: '0.7', freq: 'monthly' },
    { loc: '/contact',                           priority: '0.8', freq: 'monthly' },
    { loc: '/assessment',                        priority: '0.8', freq: 'monthly' },
    { loc: '/wednesday-meditation',              priority: '0.8', freq: 'weekly' },
    { loc: '/privacy',                           priority: '0.3', freq: 'yearly' },
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${base}${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.freq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
  res.set('Content-Type', 'application/xml').send(xml);
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// The IV quiz was retired. Send any old links to Christine's page instead.
app.get('/iv-quiz', (req, res) => res.redirect(302, '/practitioners/christine-winnen'));

app.get('/start', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'start.html'));
});

app.get(['/wednesday-meditation', '/wednesday'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'wednesday-meditation.html'));
});

// Wednesday Meditation: registration, optional donation (Stripe Checkout), emails, day-of reminders
const wednesday = require('./wednesday').register({
  app, base, stripe, adminAuth, sendGmail, saveToAirtable, addToKlaviyo,
  sendInternalNotification, notifySlack, alertSlack, nowPST,
});

// ════════════════════════════════════════════════════════
// CATCH-ALL — serve index.html for all unmatched routes
// ════════════════════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// ════════════════════════════════════════════════════════
// HELPER: Current time as ISO string in America/Los_Angeles
// ════════════════════════════════════════════════════════
function nowPST() {
  const now = new Date();
  const pstStr = now.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const [datePart, timePart] = pstStr.split(', ');
  const [mo, dy, yr] = datePart.split('/');
  // Determine offset: PDT = -07:00, PST = -08:00
  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  const isDST = now.getTimezoneOffset() < Math.max(jan, jul);
  // Use LA's actual offset
  const laOffset = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset' })
    .match(/GMT([+-]\d+)/)?.[1] || '-7';
  const hours = String(Math.abs(parseInt(laOffset))).padStart(2, '0');
  const sign = laOffset.startsWith('-') ? '-' : '+';
  const offsetStr = `${sign}${hours}:00`;
  const hr = timePart.startsWith('24') ? '00' + timePart.slice(2) : timePart;
  return `${yr}-${mo}-${dy}T${hr}${offsetStr}`;
}

// ════════════════════════════════════════════════════════
// HELPER: Save record to Airtable
// ════════════════════════════════════════════════════════
async function saveToAirtable(tableName, fields, options) {
  if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
    console.warn('Airtable not configured — skipping save to', tableName);
    return null;
  }
  try {
    const record = await base(tableName).create(fields, options);
    console.log(`✓ Airtable ${tableName}: record ${record.id} created`);
    return record;
  } catch (err) {
    // Don't throw — log and continue so submission still succeeds
    console.error(`Airtable ${tableName} error:`, err.message);
    alertSlack(`airtable-${tableName}`, `Airtable save failed (${tableName}) — a submission may not have been recorded`, err.message);
    return null;
  }
}


// ════════════════════════════════════════════════════════
// HELPER: Post a short alert to Slack (incoming webhook)
// Deliberately omits notes, phone and email: those can contain
// health details and live in Airtable / the admin dashboard.
// Fire-and-forget — a Slack outage never blocks a submission.
// ════════════════════════════════════════════════════════
function notifySlack({ title, lines = [], link = 'Open admin dashboard' }) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const text = [`*${title}*`, ...lines.filter(Boolean), `<https://www.compoundoc.com/admin.html|${link}>`].join('\n');
  axios.post(url, { text }, { timeout: 5000 })
    .then(() => console.log(`✓ Slack: ${title} posted`))
    .catch(err => console.error('Slack notify error:', err.message));
}


// ════════════════════════════════════════════════════════
// HELPER: Slack alert when an integration breaks
// Posts at most once per hour per problem so a failure that repeats on every
// submission doesn't flood the channel. Never includes client details.
// ════════════════════════════════════════════════════════
const alertLastSent = new Map();
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const RAILWAY_LOGS_URL = 'https://railway.com/project/45374fb8-739d-470f-ae5d-e8a08b6b077c/logs?environmentId=382ebd67-51db-4495-bc0a-cedd513ca359';

function alertSlack(key, title, detail) {
  const msg = String(detail || '').slice(0, 300);
  console.error(`ALERT [${key}] ${title}: ${msg}`);
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  if (Date.now() - (alertLastSent.get(key) || 0) < ALERT_COOLDOWN_MS) return;
  alertLastSent.set(key, Date.now());
  const hint = /invalid_grant/i.test(msg)
    ? '\nThe Google login has expired or been revoked. Generate a new refresh token (OAuth Playground) and update GOOGLE_REFRESH_TOKEN in Railway.'
    : '';
  const text = [`:warning: *${title}*`, msg, hint, `<${RAILWAY_LOGS_URL}|Open Railway logs>`].filter(Boolean).join('\n');
  axios.post(url, { text }, { timeout: 5000 }).catch(err => console.error('Slack alert error:', err.message));
}

// Daily check that the Google login still works, so expiry is caught before an inquiry is lost.
async function checkGoogleAuth() {
  if (!process.env.GOOGLE_REFRESH_TOKEN) return;
  try {
    await oauth2Client.getAccessToken();
    console.log('✓ Google login check passed');
  } catch (err) {
    alertSlack('google-auth', 'Google login check failed — emails and analytics are down', err.message);
  }
}


// ════════════════════════════════════════════════════════
// HELPER: Add contact to Klaviyo list
// ════════════════════════════════════════════════════════
// Klaviyo is a marketing tool without a HIPAA agreement, so it only ever receives name, contact details and
// the time of the inquiry. Never pass a practitioner, service, or health detail in `properties`.
function toE164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return undefined;
}

async function addToKlaviyo({ email, firstName, lastName, phone, source, listId, properties = {} }) {
  if (!process.env.KLAVIYO_API_KEY) {
    console.warn('Klaviyo not configured — skipping');
    return;
  }
  try {
    // Step 1: Upsert the profile
    const profileRes = await axios.post(
      'https://a.klaviyo.com/api/profiles/',
      {
        data: {
          type: 'profile',
          attributes: {
            email,
            first_name:  firstName,
            last_name:   lastName,
            ...(toE164(phone) ? { phone_number: toE164(phone) } : {}),
            properties:  { source, inquiry_time: nowPST(), ...properties },
          }
        }
      },
      {
        headers: {
          'Authorization': `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
          'Content-Type':  'application/json',
          'revision':      '2024-02-15',
        }
      }
    );

    const profileId = profileRes.data?.data?.id;

    // Step 2: Add to list (if list ID is configured)
    if (listId && profileId) {
      await axios.post(
        `https://a.klaviyo.com/api/lists/${listId}/relationships/profiles/`,
        { data: [{ type: 'profile', id: profileId }] },
        {
          headers: {
            'Authorization': `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
            'Content-Type':  'application/json',
            'revision':      '2024-02-15',
          }
        }
      );
    }

    console.log('✓ Klaviyo: profile upserted');
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Klaviyo error: HTTP', err.response?.status || '', err.response?.data?.errors?.[0]?.code || err.message);
    if (err.response?.status !== 409) alertSlack('klaviyo', 'Klaviyo is failing', `HTTP ${err.response?.status || 'error'}: check the Railway logs`);
  }
}


// ════════════════════════════════════════════════════════
// HELPER: Send email via Gmail API (from adrienne@compoundoc.com)
// ════════════════════════════════════════════════════════
function htmlToPlainText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Everything a visitor typed must be escaped before it goes into an email we send.
const escHtml = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const oneLine = v => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();

function makeEmailMessage({ to, subject, html, attachments = [] }) {
  to = oneLine(to); subject = oneLine(subject);   // a line break here would let someone add their own headers
  const outerBoundary = 'compound_outer';
  const altBoundary   = 'compound_alt';
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const plainText = htmlToPlainText(html);
  const hasAttachments = attachments.length > 0;

  const lines = [
    `From: Adrienne at The Compound <adrienne@compoundoc.com>`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/${hasAttachments ? 'mixed' : 'alternative'}; boundary="${hasAttachments ? outerBoundary : altBoundary}"`,
    ``,
  ];

  if (hasAttachments) {
    // Outer mixed wraps the alternative block + attachments
    lines.push(`--${outerBoundary}`);
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push(``);
  }

  // Plain text part
  lines.push(`--${altBoundary}`);
  lines.push(`Content-Type: text/plain; charset=UTF-8`);
  lines.push(`Content-Transfer-Encoding: base64`);
  lines.push(``);
  lines.push(Buffer.from(plainText).toString('base64'));

  // HTML part
  lines.push(`--${altBoundary}`);
  lines.push(`Content-Type: text/html; charset=UTF-8`);
  lines.push(`Content-Transfer-Encoding: base64`);
  lines.push(``);
  lines.push(Buffer.from(html).toString('base64'));
  lines.push(`--${altBoundary}--`);

  if (hasAttachments) {
    for (const att of attachments) {
      lines.push(`--${outerBoundary}`);
      lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
      lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
      lines.push(`Content-Transfer-Encoding: base64`);
      lines.push(``);
      lines.push(att.data);
    }
    lines.push(`--${outerBoundary}--`);
  }

  const raw = lines.join('\n');
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendGmail({ to, subject, html, attachments = [] }) {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    console.warn('Gmail not configured — skipping email');
    return;
  }
  try {
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: makeEmailMessage({ to, subject, html, attachments }) },
    });
    console.log('✓ Gmail: message sent');
  } catch (err) {
    console.error('Gmail send error:', err.message);
    alertSlack('gmail', 'Gmail is failing — client emails are not going out', err.message);
  }
}


// ════════════════════════════════════════════════════════
// HELPER: Send booking confirmation email
// ════════════════════════════════════════════════════════
async function sendConfirmationEmail({ to, clientName, practitioner, service, date, time, amount, meetLink }) {
  clientName = escHtml(clientName); practitioner = escHtml(practitioner); service = escHtml(service); date = escHtml(date); time = escHtml(time); amount = escHtml(amount);
  meetLink = /^https:\/\/meet\.google\.com\/[\w-]+$/.test(String(meetLink || '')) ? meetLink : '';
  const meetRow = meetLink
    ? `<tr><td style="color:#9A8E84;padding-right:16px">Google Meet</td><td><a href="${meetLink}" style="color:#8A5E38">${meetLink}</a></td></tr>`
    : '';
  await sendGmail({
    to,
    subject: `Your session is confirmed — ${service}`,
    html: `
      <div style="font-family:'Georgia',serif;max-width:560px;margin:0 auto;color:#2C2420;background:#FAF7F2;padding:40px 32px">
        <p style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#8A5E38;margin-bottom:24px">The Compound Wellness</p>
        <h1 style="font-size:32px;font-weight:300;line-height:1.1;margin-bottom:20px">You're <em>confirmed.</em></h1>
        <p style="font-size:15px;line-height:1.7;margin-bottom:32px">Hi ${clientName}, your session has been booked. I'll be in touch 24 hours before to confirm details.</p>
        <div style="border:1px solid rgba(196,168,130,.3);padding:24px;background:#F0EAE0;margin-bottom:32px">
          <table style="width:100%;font-size:13px;line-height:1.8">
            <tr><td style="color:#9A8E84;padding-right:16px">Practitioner</td><td><strong>${practitioner}</strong></td></tr>
            <tr><td style="color:#9A8E84;padding-right:16px">Service</td><td>${service}</td></tr>
            <tr><td style="color:#9A8E84;padding-right:16px">Date</td><td>${date}</td></tr>
            <tr><td style="color:#9A8E84;padding-right:16px">Time</td><td>${time}</td></tr>
            <tr><td style="color:#9A8E84;padding-right:16px">Amount Paid</td><td>$${amount} USD</td></tr>
            ${meetRow}
          </table>
        </div>
        <p style="font-size:13px;color:#7A6E64;line-height:1.7;margin-bottom:24px">Cancellations with 24+ hours notice receive a full refund. To reschedule or cancel, reply to this email.</p>
        <p style="font-size:13px;color:#7A6E64">— Adrienne</p>
        <p style="font-size:12px;color:#9A8E84">The Compound Wellness · 2801 W Coast Hwy STE 370, Newport Beach CA · compoundoc.com</p>
      </div>
    `,
  });
}


// ════════════════════════════════════════════════════════
// HELPER: Send auto-reply to inquiry submission
// ════════════════════════════════════════════════════════
setTimeout(function googleCheck() { checkGoogleAuth(); setTimeout(googleCheck, 24 * 60 * 60 * 1000); }, 20 * 1000);

async function sendAutoReply({ to, firstName, practitioner, consultTime }) {
  firstName = escHtml(firstName); practitioner = escHtml(practitioner); consultTime = escHtml(consultTime);
  const consultNote = consultTime
    ? `<p style="font-size:14px;line-height:1.7">Your requested time is <strong>${consultTime}</strong> — I'll confirm this shortly.</p>`
    : '';
  await sendGmail({
    to,
    subject: 'We received your inquiry — The Compound Wellness',
    html: `
      <div style="font-family:'Georgia',serif;max-width:560px;margin:0 auto;color:#2C2420;background:#FAF7F2;padding:40px 32px">
        <p style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#8A5E38;margin-bottom:24px">The Compound Wellness</p>
        <h1 style="font-size:32px;font-weight:300;line-height:1.1;margin-bottom:20px">We'll be in <em>touch.</em></h1>
        <p style="font-size:15px;line-height:1.7;margin-bottom:20px">Hi ${firstName}, thank you for reaching out${practitioner ? ' about ' + practitioner : ''}. I've received your inquiry and will be in touch within 24 hours.</p>
        ${consultNote}
        <p style="font-size:13px;color:#7A6E64;line-height:1.7;margin-bottom:24px">In the meantime, feel free to explore our pathways and practitioners at compoundoc.com.</p>
        <p style="font-size:13px;color:#7A6E64">— Adrienne</p>
        <p style="font-size:12px;color:#9A8E84">The Compound Wellness · Newport Beach, CA</p>
      </div>
    `,
  });
}


// ════════════════════════════════════════════════════════
// HELPER: Internal notification to adrienne@compoundoc.com
// ════════════════════════════════════════════════════════
async function sendInternalNotification(data) {
  const labels = {
    clientName: 'Client', clientEmail: 'Email', practitioner: 'Practitioner',
    service: 'Service', date: 'Date', time: 'Time', amount: 'Amount',
    notes: 'Notes', consultTime: 'Consult Time', ref: 'Reference',
  };
  const rows = Object.entries(data)
    .filter(([k]) => k !== 'type')
    .map(([k, v]) => `<tr><td style="color:#9A8E84;padding-right:16px;padding-bottom:8px">${escHtml(labels[k] || k)}</td><td>${escHtml(v) || '—'}</td></tr>`)
    .join('');
  await sendGmail({
    to: 'adrienne@compoundoc.com',
    subject: `[${data.type}]${data.ref ? ' ' + data.ref : ''} ${oneLine(data.clientName)} — ${oneLine(data.practitioner)}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#f9f9f7">
        <h2 style="font-size:18px;margin-bottom:20px">${data.type}</h2>
        <table style="font-size:13px;line-height:1.7">${rows}</table>
      </div>
    `,
  });
}


// ════════════════════════════════════════════════════════
// HELPER: Create Google Calendar event with Meet link
// ════════════════════════════════════════════════════════
async function createCalendarEvent({ clientName, clientEmail, practitioner, service, date, time }) {
  if (!process.env.GOOGLE_REFRESH_TOKEN) return null;
  try {
    // Parse date + time into a Date object (assumes Pacific time)
    const dateTimeStr = `${date}T${time || '10:00'}:00`;
    const start = new Date(dateTimeStr);
    if (isNaN(start)) return null;
    const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hour

    const event = await calendar.events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,
      requestBody: {
        summary: `${service} — ${clientName}`,
        description: `Practitioner: ${practitioner}\nClient: ${clientName} (${clientEmail})\nService: ${service}`,
        start: { dateTime: start.toISOString(), timeZone: 'America/Los_Angeles' },
        end:   { dateTime: end.toISOString(),   timeZone: 'America/Los_Angeles' },
        attendees: [
          { email: 'adrienne@compoundoc.com' },
          { email: clientEmail },
        ],
        conferenceData: {
          createRequest: {
            requestId: `compound-${Date.now()}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
    });

    const meetLink = event.data.hangoutLink || null;
    console.log(`✓ Calendar event created${meetLink ? ' with Meet: ' + meetLink : ''}`);
    return meetLink;
  } catch (err) {
    console.error('Calendar event error:', err.message);
    return null;
  }
}


// ════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n✦ The Compound Wellness running on port ${PORT}`);
  console.log(`  Stripe:   ${process.env.STRIPE_SECRET_KEY    ? '✓ connected' : '✗ not configured'}`);
  console.log(`  Airtable: ${process.env.AIRTABLE_API_KEY    ? '✓ connected' : '✗ not configured'}`);
  console.log(`  Klaviyo:  ${process.env.KLAVIYO_API_KEY     ? '✓ connected' : '✗ not configured'}`);
  console.log(`  Gmail:    ${process.env.GOOGLE_REFRESH_TOKEN ? '✓ connected' : '✗ not configured'}`);
  console.log(`  Calendar: ${process.env.GOOGLE_REFRESH_TOKEN ? '✓ connected' : '✗ not configured'}\n`);
});
