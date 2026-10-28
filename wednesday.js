/**
 * Wednesday Meditation — weekly registration, optional donation, emails, reminders.
 *
 * Everything you are likely to edit is in CFG below. The weekly quotes and artworks
 * live in wednesday-content.js.
 *
 *   GET  /api/wednesday-meditations            upcoming Wednesdays, spots left, quote + art for each
 *   POST /api/wednesday-meditations/register   reserve a spot (confirmation email goes out immediately)
 *   POST /api/wednesday-meditations/donate     optional donation -> Stripe Checkout (hosted by Stripe)
 *   POST /api/admin/wednesday/send-reminders   admin only: send the day-of email now (supports dryRun)
 *   POST /api/admin/wednesday/add-registrations admin only: add people to a past or current Wednesday (no emails to them)
 *
 * Registrations are stored in the existing Airtable "Event Bookings" table. To free a spot,
 * set that row's Status to "Cancelled" (add that option to the Status field if needed).
 */
const { QUOTES, ART } = require('./wednesday-content');

const CFG = {
  id: 'wedmed',
  title: 'Wednesday Meditation',
  capacity: 10,                         // spots per Wednesday
  startHour: 18, startMinute: 0,        // 6:00 PM Pacific
  durationMinutes: 90,                  // only used for the calendar file attached to the confirmation
  tz: 'America/Los_Angeles',
  addressLine: '419 N PCH, Laguna Beach, CA 92651',
  mapsQuery: '419 N Pacific Coast Hwy, Laguna Beach, CA 92651',
  weeksAhead: 6,                        // how many upcoming Wednesdays to offer
  cancelledDates: [],                   // skip a Wednesday, e.g. ['2026-11-25']
  donation: { presets: [10, 20, 35, 50], min: 5, max: 500 },
  siteUrl: 'https://www.compoundoc.com',
  reminderHourPT: 8,                    // day-of email goes out at 8:00 AM Pacific
};
CFG.pageUrl = CFG.siteUrl + '/wednesday-meditation';
CFG.googleMapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(CFG.mapsQuery);
CFG.appleMapsUrl = 'https://maps.apple.com/?q=' + encodeURIComponent(CFG.mapsQuery);

// ── Date helpers (everything is "Pacific wall-clock time") ───────────────────
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function ptParts(date) {
  const p = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: CFG.tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).forEach(x => { if (x.type !== 'literal') p[x.type] = Number(x.value); });
  return p;
}
const pad = n => String(n).padStart(2, '0');
function todayPT(now = new Date()) { const p = ptParts(now); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; }
function addDays(iso, n) { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
function weekday(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function fmt(iso, opts) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts }); }
const shortLabel = iso => fmt(iso, { weekday: 'short', month: 'short', day: 'numeric' });          // Wed, Oct 28
const longLabel = iso => fmt(iso, { weekday: 'long', month: 'long', day: 'numeric' });            // Wednesday, October 28
function startLabel() { const h = CFG.startHour % 12 || 12; return `${h}:${pad(CFG.startMinute)} ${CFG.startHour >= 12 ? 'PM' : 'AM'}`; }
function ptWallToUtcMs(iso, h, mi) {
  const [y, mo, d] = iso.split('-').map(Number);
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let t = target;
  for (let i = 0; i < 2; i++) { const p = ptParts(new Date(t)); t += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute); }
  return t;
}

// The Wednesdays currently open for registration. Today's session closes when it starts.
function upcomingDates(now = new Date()) {
  let d = todayPT(now);
  const p = ptParts(now);
  const started = p.hour * 60 + p.minute >= CFG.startHour * 60 + CFG.startMinute;
  while (weekday(d) !== 3 || (d === todayPT(now) && started)) d = addDays(d, 1);
  const out = [];
  while (out.length < CFG.weeksAhead) { if (!CFG.cancelledDates.includes(d)) out.push(d); d = addDays(d, 7); }
  return out;
}
const eventId = iso => `${CFG.id}-${iso}`;
const ID_RE = new RegExp(`^${CFG.id}-\\d{4}-\\d{2}-\\d{2}$`);   // validated before anything goes into an Airtable formula

// A quote and an artwork for every Wednesday, rotating by calendar week.
function reflectionFor(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const week = Math.floor(Date.UTC(y, m - 1, d) / (7 * 86400000));
  return { quote: QUOTES[week % QUOTES.length], art: ART[week % ART.length] };
}

// ── Emails ───────────────────────────────────────────────────────────────────
const wrap = inner => `
  <div style="font-family:'Georgia',serif;max-width:560px;margin:0 auto;color:#2C2420;background:#FAF7F2;padding:40px 32px">
    <p style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#8A5E38;margin:0 0 24px">The Compound Wellness</p>
    ${inner}
    <p style="font-size:13px;color:#7A6E64;margin:28px 0 0">— Adrienne &amp; The Compound Team</p>
    <p style="font-size:12px;color:#9A8E84;margin:20px 0 0">The Compound Wellness · compoundoc.com</p>
  </div>`;

const detailsBlock = iso => `
  <div style="border:1px solid rgba(196,168,130,.3);padding:22px 24px;background:#F0EAE0;margin:0 0 20px">
    <table style="width:100%;font-size:14px;line-height:1.9;border-collapse:collapse">
      <tr><td style="color:#9A8E84;padding-right:16px;white-space:nowrap;vertical-align:top">Event</td><td><strong>${CFG.title}</strong></td></tr>
      <tr><td style="color:#9A8E84;padding-right:16px;white-space:nowrap;vertical-align:top">Date</td><td><strong>${esc(longLabel(iso))}</strong></td></tr>
      <tr><td style="color:#9A8E84;padding-right:16px;white-space:nowrap;vertical-align:top">Time</td><td>${esc(startLabel())}</td></tr>
      <tr><td style="color:#9A8E84;padding-right:16px;white-space:nowrap;vertical-align:top">Where</td><td>${esc(CFG.addressLine)}</td></tr>
    </table>
  </div>
  <p style="margin:0 0 28px;font-size:13px">
    <a href="${CFG.googleMapsUrl}" style="color:#8A5E38">Open in Google Maps</a> &nbsp;·&nbsp; <a href="${CFG.appleMapsUrl}" style="color:#8A5E38">Open in Apple Maps</a>
  </p>`;

const reflectionBlock = iso => {
  const { quote, art } = reflectionFor(iso);
  return `
  <div style="border-top:1px solid rgba(196,168,130,.4);padding-top:26px;margin-top:8px">
    <p style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#8A5E38;margin:0 0 14px">This week's reflection</p>
    <p style="font-size:20px;line-height:1.5;font-style:italic;margin:0 0 8px">&ldquo;${esc(quote.text)}&rdquo;</p>
    <p style="font-size:13px;color:#7A6E64;margin:0 0 26px">${esc(quote.author)}${quote.source ? ', <em>' + esc(quote.source) + '</em>' : ''}</p>
    <img src="${esc(art.image)}" alt="${esc(art.title)} by ${esc(art.artist)}" width="496" style="width:100%;max-width:496px;height:auto;display:block;margin:0 0 10px">
    <p style="font-size:14px;margin:0 0 2px"><strong>${esc(art.title)}</strong></p>
    <p style="font-size:12px;color:#9A8E84;margin:0 0 10px">${esc(art.artist)}, ${esc(art.year)} · ${esc(art.where)}</p>
    <p style="font-size:13px;color:#5E5248;line-height:1.7;margin:0">${esc(art.blurb)}</p>
  </div>`;
};

const donateLine = `
  <p style="font-size:13px;color:#7A6E64;line-height:1.7;margin:26px 0 0">Attending is free. If you would like to help cover the cost of the studio space, you are welcome to
  <a href="${CFG.pageUrl}#donate" style="color:#8A5E38">make a donation</a>. It is entirely optional.</p>`;

function confirmationEmail({ firstName, iso }) {
  return {
    subject: `You're registered — ${CFG.title}, ${shortLabel(iso)} at ${startLabel()}`,
    html: wrap(`
      <h1 style="font-size:32px;font-weight:300;line-height:1.15;margin:0 0 18px">You're <em>registered.</em></h1>
      <p style="font-size:15px;line-height:1.7;margin:0 0 26px">Hi ${esc(firstName)}, your spot is reserved for <strong>${esc(longLabel(iso))} at ${esc(startLabel())}</strong>. We will email you again the morning of to confirm.</p>
      ${detailsBlock(iso)}
      <p style="font-size:13px;color:#7A6E64;line-height:1.7;margin:0 0 6px">A calendar file is attached. If your plans change, please reply to this email so we can offer your spot to someone else.</p>
      ${donateLine}
      <div style="height:26px"></div>
      ${reflectionBlock(iso)}`),
  };
}

function reminderEmail({ firstName, iso }) {
  return {
    subject: `Tonight at ${startLabel()} — ${CFG.title}`,
    html: wrap(`
      <h1 style="font-size:30px;font-weight:300;line-height:1.15;margin:0 0 18px">See you <em>tonight.</em></h1>
      <p style="font-size:15px;line-height:1.7;margin:0 0 26px">Hi ${esc(firstName)}, this is a reminder that you are registered for ${CFG.title} tonight, <strong>${esc(longLabel(iso))}</strong>, at <strong>${esc(startLabel())}</strong> at <strong>${esc(CFG.addressLine)}</strong>.</p>
      ${detailsBlock(iso)}
      <p style="font-size:13px;color:#7A6E64;line-height:1.7;margin:0">If you can no longer make it, please reply to this email as early as you can so we can open your spot to someone else.</p>
      ${donateLine}
      <div style="height:26px"></div>
      ${reflectionBlock(iso)}`),
  };
}

function thankYouEmail({ amount }) {
  return {
    subject: 'Thank you for supporting Wednesday Meditation',
    html: wrap(`
      <h1 style="font-size:30px;font-weight:300;line-height:1.15;margin:0 0 18px">Thank <em>you.</em></h1>
      <p style="font-size:15px;line-height:1.7;margin:0">Your donation of $${esc(amount)} helps cover the cost of the studio space where we gather each Wednesday. We are grateful for you, and for the community you are part of.</p>`),
  };
}

function icsFile(iso, uidSuffix) {
  const start = ptWallToUtcMs(iso, CFG.startHour, CFG.startMinute);
  const end = start + CFG.durationMinutes * 60000;
  const z = t => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const text = s => String(s).replace(/([,;\\])/g, '\\$1');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Compound Wellness//Wednesday Meditation//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${eventId(iso)}-${uidSuffix}@compoundoc.com`, `DTSTAMP:${z(Date.now())}`, `DTSTART:${z(start)}`, `DTEND:${z(end)}`,
    `SUMMARY:${text(CFG.title)}`, `LOCATION:${text(CFG.addressLine)}`,
    `DESCRIPTION:${text('The Compound Wellness. Reply to your confirmation email if your plans change.')}`,
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return { filename: 'Wednesday-Meditation.ics', mimeType: 'text/calendar; charset=UTF-8', data: Buffer.from(lines.join('\r\n') + '\r\n').toString('base64') };
}

// ── Validation ───────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validateRegistration(b) {
  const firstName = String(b.firstName || '').trim().slice(0, 60);
  const lastName = String(b.lastName || '').trim().slice(0, 60);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
  const phone = String(b.phone || '').trim().slice(0, 30);
  const date = String(b.date || '').trim();
  if (!firstName || !lastName) return { error: 'Please enter your first and last name.' };
  if (!EMAIL_RE.test(email)) return { error: 'Please enter a valid email address.' };
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return { error: 'Please enter a valid phone number.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Please choose a date.' };
  return { value: { firstName, lastName, email, phone, date } };
}

// ── Wire-up ──────────────────────────────────────────────────────────────────
function register(deps) {
  const { app, base, stripe, adminAuth, sendGmail, saveToAirtable, addToKlaviyo, sendInternalNotification, notifySlack, alertSlack, nowPST } = deps;

  // One registration at a time, so two people can't take the last spot together.
  let chain = Promise.resolve();
  const serialize = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

  const ipHits = new Map();
  function tooMany(ip, max = 8, windowMs = 60 * 60 * 1000) {
    const now = Date.now();
    const hits = (ipHits.get(ip) || []).filter(t => now - t < windowMs);
    hits.push(now); ipHits.set(ip, hits);
    return hits.length > max;
  }

  const activeFilter = id => `AND({Event ID} = "${id}", {Status} != "Cancelled")`;
  let countCache = { at: 0, counts: {} };
  async function counts(force) {
    if (!base) return {};
    if (!force && Date.now() - countCache.at < 15000) return countCache.counts;
    const rows = await base('Event Bookings').select({
      filterByFormula: `AND(LEFT({Event ID}, ${CFG.id.length + 1}) = "${CFG.id}-", {Status} != "Cancelled")`,
      fields: ['Event ID'], maxRecords: 1000,
    }).all();
    const c = {};
    rows.forEach(r => { const id = r.fields['Event ID']; if (id) c[id] = (c[id] || 0) + 1; });
    countCache = { at: Date.now(), counts: c };
    return c;
  }

  function publicSession(iso, c) {
    const taken = c[eventId(iso)] || 0;
    const left = Math.max(0, CFG.capacity - taken);
    return { date: iso, label: shortLabel(iso), longLabel: longLabel(iso), spotsLeft: left, full: left === 0, ...reflectionFor(iso) };
  }

  app.get('/api/wednesday-meditations', async (req, res) => {
    let c = {};
    try { c = await counts(); } catch (err) { console.error('wednesday counts error:', err.message); }
    res.set('Cache-Control', 'no-store');
    res.json({
      title: CFG.title, capacity: CFG.capacity, time: startLabel(), address: CFG.addressLine,
      googleMapsUrl: CFG.googleMapsUrl, appleMapsUrl: CFG.appleMapsUrl,
      donation: CFG.donation,
      sessions: upcomingDates().map(iso => publicSession(iso, c)),
    });
  });

  app.post('/api/wednesday-meditations/register', async (req, res) => {
    try {
      // Hidden field real people never fill in: pretend it worked, store nothing.
      if (req.body && req.body.website) return res.json({ success: true });
      if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
      const v = validateRegistration(req.body || {});
      if (v.error) return res.status(400).json({ error: v.error });
      const { firstName, lastName, email, phone, date } = v.value;
      if (!upcomingDates().includes(date)) return res.status(400).json({ error: 'That date is not open for registration.' });
      const id = eventId(date);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid date.' });

      const outcome = await serialize(async () => {
        if (base) {
          const dupe = await base('Event Bookings').select({
            filterByFormula: `AND({Event ID} = "${id}", LOWER({Email}) = "${email.replace(/["\\]/g, '')}", {Status} != "Cancelled")`,
            fields: ['Event ID'], maxRecords: 1,
          }).firstPage();
          if (dupe.length) return { already: true };
          const c = await counts(true);
          if ((c[id] || 0) >= CFG.capacity) return { full: true };
        }
        const record = await saveToAirtable('Event Bookings', {
          'Event': CFG.title, 'Event Date': date, 'First Name': firstName, 'Last Name': lastName,
          'Email': email, 'Phone': phone, 'Event ID': id, 'Submission Date': nowPST(), 'Status': 'Confirmed',
        }, { typecast: true });   // lets Airtable add "Wednesday Meditation" to dropdown fields if needed
        if (base && !record) return { failed: true };   // saveToAirtable already alerted Slack
        countCache.at = 0;
        return { saved: true };
      });

      if (outcome.full) return res.status(409).json({ error: 'Sorry, that Wednesday just filled up. Please choose another date.' });
      if (outcome.failed) return res.status(503).json({ error: 'We could not save your registration. Please try again, or email adrienne@compoundoc.com.' });
      if (outcome.already) return res.json({ success: true, already: true, date, label: longLabel(date), time: startLabel() });

      const fullName = `${firstName} ${lastName}`;
      const mail = confirmationEmail({ firstName, iso: date });
      await sendGmail({ to: email, subject: mail.subject, html: mail.html, attachments: [icsFile(date, Date.now().toString(36))] });
      addToKlaviyo({ email, firstName, lastName, source: 'Event RSVP — ' + CFG.title, listId: process.env.KLAVIYO_LIST_ID, properties: { eventTitle: CFG.title, eventDate: date, eventLocation: CFG.addressLine } })
        .catch(err => console.error('Klaviyo (wednesday) error:', err.message));
      sendInternalNotification({ type: 'Event RSVP', clientName: fullName, clientEmail: email, practitioner: 'Community Event', service: `${CFG.title} — ${longLabel(date)}`, date: longLabel(date), time: startLabel(), amount: '0' })
        .catch(err => console.error('Internal notification (wednesday) error:', err.message));
      notifySlack({ title: 'New Wednesday Meditation registration', lines: [`*From:* ${fullName}`, `*Date:* ${longLabel(date)}`] });

      res.json({ success: true, date, label: longLabel(date), time: startLabel() });
    } catch (err) {
      console.error('wednesday register error:', err.message);
      res.status(500).json({ error: 'Something went wrong. Please try again, or email adrienne@compoundoc.com.' });
    }
  });

  // Only our own pages can be a return destination for Stripe.
  function returnOrigin(req) {
    const host = String(req.get('host') || '').toLowerCase();
    if (/^(www\.)?compoundoc\.com$/.test(host)) return 'https://' + host;
    if (/^localhost(:\d+)?$/.test(host)) return 'http://' + host;
    return CFG.siteUrl;
  }

  app.post('/api/wednesday-meditations/donate', async (req, res) => {
    try {
      if (tooMany('donate:' + req.ip, 20)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
      const dollars = Math.round(Number(req.body && req.body.amount) * 100) / 100;
      if (!Number.isFinite(dollars) || dollars < CFG.donation.min || dollars > CFG.donation.max) {
        return res.status(400).json({ error: `Please choose an amount between $${CFG.donation.min} and $${CFG.donation.max}.` });
      }
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      const forDate = String((req.body && req.body.date) || '');
      const origin = returnOrigin(req);
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        submit_type: 'donate',
        customer_email: EMAIL_RE.test(email) ? email : undefined,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd', unit_amount: Math.round(dollars * 100),
            product_data: { name: 'Wednesday Meditation — studio space donation', description: 'A voluntary donation toward the cost of the Laguna Beach studio.' },
          },
        }],
        payment_intent_data: {
          description: 'Wednesday Meditation donation',
          receipt_email: EMAIL_RE.test(email) ? email : undefined,
          metadata: { type: 'donation', program: CFG.id, eventDate: /^\d{4}-\d{2}-\d{2}$/.test(forDate) ? forDate : '' },
        },
        success_url: `${origin}/wednesday-meditation?thanks=1`,
        cancel_url: `${origin}/wednesday-meditation#donate`,
      });
      res.json({ url: session.url });
    } catch (err) {
      console.error('wednesday donate error:', err.message);
      res.status(500).json({ error: 'We could not start the donation just now. Please try again in a moment.' });
    }
  });

  // Called from the Stripe webhook for payments tagged type=donation.
  async function handleDonationPaid(pi) {
    const amount = (pi.amount / 100).toFixed(2);
    notifySlack({ title: 'Wednesday Meditation donation received', lines: [`*Amount:* $${amount}`, pi.metadata && pi.metadata.eventDate ? `*Made after registering for:* ${pi.metadata.eventDate}` : ''] });
    if (pi.receipt_email) {
      const mail = thankYouEmail({ amount });
      await sendGmail({ to: pi.receipt_email, subject: mail.subject, html: mail.html });
    }
    console.log(`✓ Wednesday Meditation donation: $${amount}`);
  }

  // ── Add registrations by hand (admin dashboard) ───────────────────────────
  // For people who signed up another way, e.g. a past Wednesday. Writes Airtable + Klaviyo and posts one
  // Slack summary. Deliberately sends nothing to the attendees and ignores the spot limit.
  app.post('/api/admin/wednesday/add-registrations', adminAuth, async (req, res) => {
    try {
      const date = String((req.body && req.body.date) || '');
      const people = Array.isArray(req.body && req.body.people) ? req.body.people.slice(0, 60) : [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || weekday(date) !== 3) return res.status(400).json({ error: 'Please choose a Wednesday.' });
      if (date > addDays(todayPT(), 7)) return res.status(400).json({ error: 'That date is too far ahead.' });
      if (!people.length) return res.status(400).json({ error: 'No people to add.' });
      const id = eventId(date);
      const results = [], added = [];
      for (const p of people) {
        const name = String(p.name || '').trim().slice(0, 120);
        const [firstName, ...rest] = name.split(/\s+/);
        const lastName = rest.join(' ');
        const email = String(p.email || '').trim().toLowerCase().slice(0, 120);
        const phone = String(p.phone || '').trim().slice(0, 30);
        if (!firstName || !EMAIL_RE.test(email) || phone.replace(/\D/g, '').length < 10) { results.push({ name, email, status: 'invalid' }); continue; }
        try {
          if (base) {
            const dupe = await base('Event Bookings').select({
              filterByFormula: `AND({Event ID} = "${id}", LOWER({Email}) = "${email.replace(/["\\]/g, '')}", {Status} != "Cancelled")`,
              fields: ['Event ID'], maxRecords: 1,
            }).firstPage();
            if (dupe.length) { results.push({ name, email, status: 'already registered' }); continue; }
          }
          const record = await saveToAirtable('Event Bookings', {
            'Event': CFG.title, 'Event Date': date, 'First Name': firstName, 'Last Name': lastName,
            'Email': email, 'Phone': phone, 'Event ID': id, 'Submission Date': nowPST(), 'Status': 'Confirmed',
          }, { typecast: true });
          if (base && !record) { results.push({ name, email, status: 'failed to save' }); continue; }
          let klaviyo = 'ok';
          try {
            await addToKlaviyo({ email, firstName, lastName, source: 'Event RSVP — ' + CFG.title, listId: process.env.KLAVIYO_LIST_ID, properties: { eventTitle: CFG.title, eventDate: date, eventLocation: CFG.addressLine } });
          } catch (err) { klaviyo = 'failed'; console.error('Klaviyo (wednesday import) error:', err.message); }
          added.push(name);
          results.push({ name, email, status: 'added', klaviyo });
        } catch (err) {
          console.error('wednesday import error:', err.message);
          results.push({ name, email, status: 'failed: ' + err.message.slice(0, 80) });
        }
      }
      countCache.at = 0;
      if (added.length) {
        notifySlack({ title: `Wednesday Meditation — ${added.length} registration${added.length === 1 ? '' : 's'} added`, lines: [`*Event:* ${longLabel(date)}, ${startLabel()}`, `*Added:* ${added.join(', ')}`] });
      }
      res.json({ date, label: longLabel(date), added: added.length, results });
    } catch (err) {
      console.error('wednesday add-registrations error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Day-of reminders ──────────────────────────────────────────────────────
  async function sendReminders(iso, { dryRun = false } = {}) {
    if (!base) return { sent: 0, note: 'Airtable not configured' };
    const id = eventId(iso);
    if (!ID_RE.test(id)) return { sent: 0, note: 'bad date' };
    const rows = await base('Event Bookings').select({ filterByFormula: activeFilter(id), fields: ['Email', 'First Name'], maxRecords: 100 }).all();
    let sent = 0;
    for (const r of rows) {
      const to = r.fields['Email']; if (!to) continue;
      if (!dryRun) { const m = reminderEmail({ firstName: r.fields['First Name'] || 'Friend', iso }); await sendGmail({ to, subject: m.subject, html: m.html }); }
      sent++;
    }
    return { sent, date: iso, dryRun };
  }

  const remindedFor = new Set();
  async function reminderTick() {
    try {
      const p = ptParts(new Date());
      const iso = todayPT();
      if (weekday(iso) !== 3 || CFG.cancelledDates.includes(iso)) return;
      if (p.hour !== CFG.reminderHourPT || p.minute >= 30 || remindedFor.has(iso)) return;   // 8:00–8:29 AM window, once per process
      remindedFor.add(iso);
      const r = await sendReminders(iso);
      console.log(`📅 Wednesday Meditation reminders for ${iso}: ${r.sent} sent`);
    } catch (err) {
      alertSlack('wednesday-reminders', 'Wednesday Meditation day-of reminders failed', err.message);
    }
  }
  setInterval(reminderTick, 5 * 60 * 1000);
  console.log('⏰ Wednesday Meditation reminders armed (8:00 AM Pacific on Wednesdays)');

  app.post('/api/admin/wednesday/send-reminders', adminAuth, async (req, res) => {
    try {
      const iso = String((req.body && req.body.date) || todayPT());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      res.json(await sendReminders(iso, { dryRun: !!(req.body && req.body.dryRun) }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return { handleDonationPaid };
}

module.exports = { register, CFG, upcomingDates, reflectionFor, confirmationEmail, reminderEmail, thankYouEmail, icsFile, validateRegistration, ptWallToUtcMs, todayPT };
