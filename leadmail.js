/**
 * Personal follow-up email to a new lead (used by the admin "Import leads" card).
 * Plain, letter-style HTML: the text you write in the admin panel, with {name} swapped for the
 * person's first name, links made clickable, and a blank line starting a new paragraph.
 */
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// "cynthia Borbolla" -> "Cynthia". Falls back to "there" when there is no usable name.
function firstNameOf(full) {
  const t = String(full || '').trim().split(/\s+/)[0] || '';
  const clean = t.replace(/[^\p{L}'’\-]/gu, '');
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase() : 'there';
}

const linkify = html => html.replace(/https?:\/\/(?:[A-Za-z0-9\-._~:\/?#@!$'()*+,;=%]|&amp;)+/g, u => {
  const tail = (u.match(/[.,;:!?)]+$/) || [''])[0];
  const url = tail ? u.slice(0, -tail.length) : u;
  return `<a href="${url}" style="color:#8A5E38">${url}</a>${tail}`;
});

function followupEmail({ text, name, subject }) {
  const first = esc(firstNameOf(name));
  const paras = String(text).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p style="margin:0 0 16px">${linkify(esc(p)).replace(/\{name\}/g, first).replace(/\n/g, '<br>')}</p>`).join('');
  return {
    subject,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:600px">${paras}</div>`,
  };
}

module.exports = { followupEmail, firstNameOf };
