import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { extractOtp, lintSender, matchMessage, normalisePhone, segments } from './dlt.js';

const INBOX_HTML = readFileSync(new URL('./inbox.html', import.meta.url), 'utf8');
const MAX_MESSAGES = 500;
const MAX_BODY = 64 * 1024;

/**
 * options: templates [{id, text, sender?, name?}], strict (reject messages matching no template),
 * delay (ms before answering), failRate (0–1, random 503s to test your retry logic), random (for tests).
 */
export function createApp({ templates = [], strict = false, delay = 0, failRate = 0, random = Math.random } = {}) {
  const messages = [];

  function check(text, templateId, sender) {
    const warnings = lintSender(sender).map((i) => i.message);
    if (!templates.length) return { ok: true, warnings, values: [] };
    if (templateId) {
      const t = templates.find((x) => String(x.id) === String(templateId));
      if (!t) return { ok: false, reason: `Template ID ${templateId} is not registered (not in your templates file).` };
      if (t.sender && sender && t.sender !== sender) return { ok: false, reason: `Template ${t.id} is registered for header "${t.sender}", not "${sender}".` };
      const m = matchMessage(t.text, text);
      return m.ok ? { ok: true, template: t, values: m.values, warnings } : { ok: false, reason: m.reason, template: t };
    }
    for (const t of templates) {
      const m = matchMessage(t.text, text);
      if (m.ok) return { ok: true, template: t, values: m.values, warnings: [...warnings, 'No template_id sent; most providers require it for India.'] };
    }
    if (strict) return { ok: false, reason: 'The message matches none of your registered templates. Operators would drop it.' };
    return { ok: true, values: [], warnings: [...warnings, 'The message matches none of your registered templates; real operators would drop it.'] };
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const type = req.headers['content-type'] || '';
    if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      throw Object.assign(new Error('Body must be JSON or form-encoded'), { status: 400 });
    }
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,DELETE', 'access-control-allow-headers': 'content-type' });
      return res.end();
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(INBOX_HTML);
    }
    if (req.method === 'POST' && path === '/api/sms') {
      const body = await readBody(req);
      const text = body.message ?? body.text ?? body.body;
      const to = normalisePhone(body.to ?? body.mobile ?? body.number);
      const sender = body.sender ?? body.from ?? null;
      const templateId = body.template_id ?? body.templateId ?? body.DltTemplateId ?? null;
      if (!to) return send(res, 400, { error: `"${body.to ?? body.mobile ?? ''}" is not a valid mobile number. Use 10 digits starting 6–9, or +<country code>.` });
      if (typeof text !== 'string' || !text) return send(res, 400, { error: 'message is required' });

      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (failRate && random() < failRate) return send(res, 503, { error: 'Simulated provider outage (--fail-rate). Your app should retry or show a "resend OTP" option.' });

      const result = check(text, templateId, sender);
      const msg = {
        id: `sms_${crypto.randomBytes(6).toString('hex')}`,
        to,
        sender,
        text,
        templateId: templateId ?? result.template?.id ?? null,
        status: result.ok ? 'delivered' : 'blocked',
        reason: result.ok ? null : result.reason,
        warnings: result.warnings ?? [],
        otp: extractOtp(text, result.values),
        ...segments(text),
        createdAt: new Date().toISOString(),
      };
      messages.unshift(msg);
      if (messages.length > MAX_MESSAGES) messages.length = MAX_MESSAGES;
      return send(res, result.ok ? 200 : 422, result.ok ? msg : { error: `Blocked by DLT check: ${result.reason}`, ...msg });
    }
    if (req.method === 'GET' && path === '/api/sms') {
      const to = url.searchParams.get('to');
      const n = to ? normalisePhone(to) : null;
      return send(res, 200, n || to ? messages.filter((m) => m.to === n) : messages);
    }
    if (req.method === 'GET' && path === '/api/otp/latest') {
      const n = normalisePhone(url.searchParams.get('to'));
      if (!n) return send(res, 400, { error: 'Pass ?to=<mobile number>' });
      const m = messages.find((x) => x.to === n && x.status === 'delivered' && x.otp);
      return m ? send(res, 200, { to: n, otp: m.otp, message: m.text, createdAt: m.createdAt }) : send(res, 404, { error: `No OTP sent to ${n} yet` });
    }
    if (req.method === 'DELETE' && path === '/api/sms') {
      messages.length = 0;
      return send(res, 200, { cleared: true });
    }
    if (req.method === 'GET' && path === '/api/templates') return send(res, 200, templates);
    return send(res, 404, { error: 'Not found. Endpoints: POST /api/sms, GET /api/sms, GET /api/otp/latest?to=, DELETE /api/sms' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => send(res, err.status || 500, { error: err.message }));
  });
  server.messages = messages;
  return server;
}

export function loadTemplates(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(data) ? data : data.templates;
  if (!Array.isArray(list)) throw new Error(`${file}: expected an array of {"id", "text", "sender"} objects`);
  for (const t of list) {
    if (!t || !t.id || typeof t.text !== 'string') throw new Error(`${file}: every template needs "id" and "text"`);
  }
  return list;
}
