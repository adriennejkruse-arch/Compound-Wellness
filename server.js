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

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Google OAuth2 client ─────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:3000/oauth/callback'
);
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}
const gmail    = google.gmail({ version: 'v1', auth: oauth2Client });
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

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

// Serve static files (HTML, images, etc.)
app.use(express.static(path.join(__dirname)));


// ════════════════════════════════════════════════════════
// STRIPE — Create Payment Intent
// Called when user reaches payment step in booking.html
// ════════════════════════════════════════════════════════
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', metadata = {} } = req.body;

    if (!amount || amount < 50) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount:   Math.round(amount * 100), // convert dollars → cents
      currency,
      metadata: {
        practitioner: metadata.practitioner || '',
        service:      metadata.service      || '',
        date:         metadata.date         || '',
        time:         metadata.time         || '',
        clientName:   metadata.clientName   || '',
        clientEmail:  metadata.clientEmail  || '',
      },
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe create-payment-intent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


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
      source:      'Booking — ' + m.practitioner,
      listId:      process.env.KLAVIYO_BOOKINGS_LIST_ID || process.env.KLAVIYO_LIST_ID,
      properties:  { practitioner: m.practitioner, service: m.service, bookedDate: m.date },
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

    console.log(`✓ Booking confirmed: ${m.clientName} — ${m.service}`);
  }

  res.json({ received: true });
});


// ════════════════════════════════════════════════════════
// INQUIRY SUBMISSION
// For Adrienne, Andrew, Christine, Branden (inquiry-only)
// ════════════════════════════════════════════════════════
app.post('/api/submit-inquiry', async (req, res) => {
  try {
    const {
      firstName, lastName, email, phone,
      city, notes, availability,
      practitioner, pracRole,
      consultTime,  // for Angela/Adrienne consult slot
      service, price, date, time,
      source = 'Website',
    } = req.body;

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

    const fullName = `${firstName} ${lastName}`.trim();

    // Resolve the date/time string — some flows use `date`+`time`, others pack it into `consultTime`
    const requestedDate = date || consultTime || '';
    const requestedTime = time || '';

    // Save contact info only to Contacts table
    const contactRecord = await saveToAirtable('Contacts', {
      'Name':            fullName,
      'Email':           email,
      'Phone':           phone  || '',
      'City':            city   || '',
      'Notes':           notes  || '',
      'Source Form':     airtableSource,
      'Submission Date': nowPST(),
    });

    // Save booking details to Booking Requests table, linked back to the contact
    const bookingFields = {
      'Request Name':           `${fullName} — ${practitioner || 'General'}`,
      'Client Name':            fullName,
      'Requested Practitioner': practitioner || '',
      'Requested Time':         requestedTime,
      'Inquiry Details':        [service, availability ? `Availability: ${availability}` : '', notes].filter(Boolean).join('\n') || '',
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
      source:      'Inquiry — ' + (practitioner || 'General'),
      listId:      process.env.KLAVIYO_INQUIRIES_LIST_ID || process.env.KLAVIYO_LIST_ID,
      properties:  { practitioner, city, phone },
    });

    // Auto-reply to client
    await sendAutoReply({ to: email, firstName, practitioner, consultTime });

    // Internal notification
    await sendInternalNotification({
      type:        'New Inquiry',
      clientName:  fullName,
      clientEmail: email,
      practitioner,
      notes,
      consultTime,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Inquiry submission error:', err.message);
    res.status(500).json({ error: 'Submission failed. Please try again.' });
  }
});


// ════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    services: {
      stripe:   !!process.env.STRIPE_SECRET_KEY,
      airtable: !!process.env.AIRTABLE_API_KEY,
      klaviyo:  !!process.env.KLAVIYO_API_KEY,
      gmail:    !!process.env.GOOGLE_REFRESH_TOKEN,
      calendar: !!process.env.GOOGLE_REFRESH_TOKEN,
    }
  });
});


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
app.post('/api/portal/pay-booking', requireAuth(), async (req, res) => {
  try {
    const { bookingId, amount } = req.body;
    const { userId } = req.auth;
    const user = await clerkClient.users.getUser(userId);
    const customerId = user.privateMetadata?.stripeCustomerId;

    if (!customerId) return res.status(400).json({ error: 'No payment method on file. Please add a card first.' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    // Get saved payment methods for customer
    const paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
    if (!paymentMethods.data.length) return res.status(400).json({ error: 'No saved card found. Please add a card first.' });

    const paymentMethodId = paymentMethods.data[0].id;

    const paymentIntent = await stripe.paymentIntents.create({
      amount:               Math.round(amount * 100),
      currency:             'usd',
      customer:             customerId,
      payment_method:       paymentMethodId,
      confirm:              true,
      off_session:          true,
      metadata:             { bookingId, userId },
    });

    // Update Airtable booking with payment info
    if (base && bookingId) {
      await base('Booking Requests').update(bookingId, {
        'Payment Status':        'Paid',
        'Stripe Payment Intent': paymentIntent.id,
      });
    }

    res.json({ success: true, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error('Pay booking error:', err.message);
    res.status(500).json({ error: err.message || 'Payment failed' });
  }
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
    { loc: '/practitioners/adrienne-kruse',      priority: '0.8', freq: 'monthly' },
    { loc: '/practitioners/dr-angela-colombo',   priority: '0.8', freq: 'monthly' },
    { loc: '/practitioners/dr-andrew-adams',     priority: '0.8', freq: 'monthly' },
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

// ════════════════════════════════════════════════════════
// CATCH-ALL — serve index.html for all unmatched routes
// ════════════════════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
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
async function saveToAirtable(tableName, fields) {
  if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
    console.warn('Airtable not configured — skipping save to', tableName);
    return null;
  }
  try {
    const record = await base(tableName).create(fields);
    console.log(`✓ Airtable ${tableName}: record ${record.id} created`);
    return record;
  } catch (err) {
    // Don't throw — log and continue so submission still succeeds
    console.error(`Airtable ${tableName} error:`, err.message);
    return null;
  }
}


// ════════════════════════════════════════════════════════
// HELPER: Add contact to Klaviyo list
// ════════════════════════════════════════════════════════
async function addToKlaviyo({ email, firstName, lastName, source, listId, properties = {} }) {
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
            properties:  { source, ...properties },
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

    console.log(`✓ Klaviyo: profile ${email} upserted`);
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Klaviyo error:', JSON.stringify(detail));
  }
}


// ════════════════════════════════════════════════════════
// HELPER: Send email via Gmail API (from adrienne@compoundoc.com)
// ════════════════════════════════════════════════════════
function makeEmailMessage({ to, subject, html }) {
  const boundary = 'compound_boundary';
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const raw = [
    `From: Adrienne at The Compound <adrienne@compoundoc.com>`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(html).toString('base64'),
    `--${boundary}--`,
  ].join('\n');
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendGmail({ to, subject, html }) {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    console.warn('Gmail not configured — skipping email');
    return;
  }
  try {
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: makeEmailMessage({ to, subject, html }) },
    });
    console.log(`✓ Gmail sent to ${to}`);
  } catch (err) {
    console.error('Gmail send error:', err.message);
  }
}


// ════════════════════════════════════════════════════════
// HELPER: Send booking confirmation email
// ════════════════════════════════════════════════════════
async function sendConfirmationEmail({ to, clientName, practitioner, service, date, time, amount, meetLink }) {
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
async function sendAutoReply({ to, firstName, practitioner, consultTime }) {
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
    notes: 'Notes', consultTime: 'Consult Time',
  };
  const rows = Object.entries(data)
    .filter(([k]) => k !== 'type')
    .map(([k, v]) => `<tr><td style="color:#9A8E84;padding-right:16px;padding-bottom:8px">${labels[k] || k}</td><td>${v || '—'}</td></tr>`)
    .join('');
  await sendGmail({
    to: 'adrienne@compoundoc.com',
    subject: `[${data.type}] ${data.clientName} — ${data.practitioner || ''}`,
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
