// Checks SMS templates and messages against India's DLT (TRAI) rules, as far as they can be checked offline.
// Operators match every message against the registered template; a mismatch means the SMS is silently dropped.

export const MAX_VAR_LENGTH = 30;
const VAR_TYPES = ['var', 'numeric', 'alphanumeric', 'url', 'urlott', 'cbn', 'email'];
const VAR_TOKEN = /\{#(var|numeric|alphanumeric|url|urlott|cbn|email)#\}/g;

// Placeholders people write by habit that DLT does not understand.
const WRONG_PLACEHOLDERS = [
  { re: /\{#\s*[A-Za-z_]+\s*#\}/g, ok: (m) => VAR_TYPES.includes(m.slice(2, -2)), hint: 'DLT variables are lowercase with no spaces: {#var#}' },
  { re: /\{\{\s*[\w.]+\s*\}\}/g, hint: '{{name}} is template-engine syntax; DLT needs {#var#}' },
  { re: /(?<![#{])\{[A-Za-z_]\w*\}(?!#)/g, hint: '{name} is not a DLT variable; use {#var#}' },
  { re: /%[sd]\b/g, hint: 'printf placeholders (%s) are not DLT variables; use {#var#}' },
  { re: /\$\{?[A-Za-z_]\w*\}?/g, hint: '$name is not a DLT variable; use {#var#}' },
  { re: /<(otp|code|name|var)>/gi, hint: '<otp> is not a DLT variable; use {#var#}' },
  { re: /##\w+##/g, hint: '##otp## is not a DLT variable; use {#var#}' },
];

/** Split a template into fixed text and variables. */
export function parseTemplate(template) {
  const parts = [];
  let last = 0;
  for (const m of template.matchAll(VAR_TOKEN)) {
    if (m.index > last) parts.push({ fixed: template.slice(last, m.index) });
    parts.push({ variable: m[1] });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ fixed: template.slice(last) });
  return parts;
}

// GSM 03.38 basic set; anything else forces Unicode (UCS-2) encoding.
const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€';

/** How many SMS parts a message costs. */
export function segments(text) {
  let gsmLen = 0;
  let unicode = false;
  for (const ch of text) {
    if (GSM.includes(ch)) gsmLen += 1;
    else if (GSM_EXT.includes(ch)) gsmLen += 2;
    else {
      unicode = true;
      break;
    }
  }
  if (unicode) {
    const len = [...text].length;
    return { encoding: 'Unicode', length: len, parts: len <= 70 ? 1 : Math.ceil(len / 67) };
  }
  return { encoding: 'GSM-7', length: gsmLen, parts: gsmLen <= 160 ? 1 : Math.ceil(gsmLen / 153) };
}

export function lintSender(sender) {
  if (!sender) return [];
  if (/^[A-Z]{6}$/.test(sender)) return [];
  if (/^[A-Za-z]{6}$/.test(sender)) return [{ level: 'warning', message: `Sender ID "${sender}" should be in capitals as registered, e.g. "${sender.toUpperCase()}".` }];
  if (/^\d{6}$/.test(sender)) return [{ level: 'warning', message: `Numeric sender ID "${sender}" is only for promotional SMS. OTP and service SMS need a 6-letter header such as "ACMEIN".` }];
  return [{ level: 'error', message: `Sender ID (header) "${sender}" must be exactly 6 characters, letters for OTP/service SMS (e.g. "ACMEIN").` }];
}

export function lintTemplate(template, { sender } = {}) {
  const issues = [];
  const add = (level, message) => issues.push({ level, message });
  const text = String(template ?? '');

  if (!text.trim()) {
    add('error', 'Template is empty.');
    return { issues, parts: [] };
  }

  for (const w of WRONG_PLACEHOLDERS) {
    for (const m of text.matchAll(w.re)) {
      if (w.ok && w.ok(m[0])) continue;
      add('error', `"${m[0]}": ${w.hint}.`);
    }
  }

  const parts = parseTemplate(text);
  const vars = parts.filter((p) => p.variable);
  const fixedText = parts.filter((p) => p.fixed).map((p) => p.fixed).join('');

  if (fixedText.replace(/[\s\p{P}]/gu, '').length < 10) {
    add('error', 'Too little fixed text. Templates that are mostly variables are rejected as too generic.');
  }
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].variable && parts[i - 1].variable) add('warning', 'Two variables next to each other: operators cannot tell where one ends. Put fixed text between them.');
  }
  if (/https?:\/\/|www\./i.test(fixedText)) {
    add('warning', 'Links in SMS must be whitelisted on your DLT portal (and the operator), or the message is blocked.');
  }
  if (vars.some((v) => v.variable === 'url' || v.variable === 'urlott')) {
    add('info', 'URL variables only accept whitelisted domains.');
  }
  if (/\b(otp|one[- ]time|verification code|passcode)\b/i.test(text)) {
    add('info', 'OTP template: register it under the "Service Implicit" category (banks may use "Transactional").');
    if (!/\b(do not|don't|never) share\b/i.test(text)) add('info', 'Tip: add "Do not share it with anyone" to OTP messages.');
  }

  const worst = parts.map((p) => (p.fixed ? p.fixed : 'x'.repeat(MAX_VAR_LENGTH))).join('');
  const seg = segments(worst);
  if (seg.parts > 1) add('warning', `With variables at full length this is ${seg.length} characters (${seg.encoding}) = ${seg.parts} SMS parts per message. You pay per part.`);
  else if (seg.encoding === 'Unicode') add('info', 'Unicode (e.g. Hindi) messages fit 70 characters per SMS instead of 160.');

  issues.push(...lintSender(sender));
  return { issues, parts, variables: vars.length };
}

const TYPE_CHECK = {
  numeric: (v) => /^\d+$/.test(v),
  alphanumeric: (v) => /^[A-Za-z0-9]+$/.test(v),
  url: (v) => /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v),
  urlott: (v) => /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v),
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  cbn: (v) => /^\+?\d{6,15}$/.test(v),
  var: () => true,
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does `message` match `template` the way DLT scrubbing does? Fixed text must match exactly;
 * each variable is 0–30 characters. Returns { ok, values } or { ok: false, reason }.
 */
export function matchMessage(template, message) {
  const parts = parseTemplate(template);
  const re = new RegExp(`^${parts.map((p) => (p.fixed ? escapeRe(p.fixed) : `([\\s\\S]{0,${MAX_VAR_LENGTH}}?)`)).join('')}$`, 'u');
  const m = re.exec(message);
  if (m) {
    const values = m.slice(1);
    const vars = parts.filter((p) => p.variable);
    for (let i = 0; i < vars.length; i++) {
      if (!TYPE_CHECK[vars[i].variable](values[i])) {
        return { ok: false, reason: `Variable ${i + 1} is {#${vars[i].variable}#} but the value "${values[i]}" does not fit that type.` };
      }
    }
    return { ok: true, values };
  }
  return { ok: false, reason: explainMismatch(parts, message) };
}

function explainMismatch(parts, message) {
  let pos = 0;
  let afterVar = false;
  for (const p of parts) {
    if (p.variable) {
      afterVar = true;
      continue;
    }
    const idx = afterVar ? message.indexOf(p.fixed, pos) : message.startsWith(p.fixed, pos) ? pos : -1;
    if (idx === -1) {
      // Find the longest start of this fixed text that does match, to point at the exact difference.
      for (let k = p.fixed.length - 1; k > 0; k--) {
        const pre = p.fixed.slice(0, k);
        const at = afterVar ? message.indexOf(pre, pos) : message.startsWith(pre, pos) ? pos : -1;
        if (at === -1 || (afterVar && at - pos > MAX_VAR_LENGTH)) continue;
        const ctx = p.fixed.slice(Math.max(0, k - 15), k);
        const want = p.fixed.slice(k, k + 15);
        const got = message.slice(at + k, at + k + 15);
        return `The message differs from the template after "…${ctx}": the template has "${want}…" but the message has "${got || '(end of message)'}…". Fixed text must match exactly (spaces, punctuation and capitals included).`;
      }
      const near = message.slice(pos, pos + 25);
      return `Expected the fixed text "${p.fixed.trim() || p.fixed}" ${pos === 0 ? 'at the start' : `after character ${pos}`}, found "${near}${message.length > pos + 25 ? '…' : ''}". Fixed text must match the registered template exactly (spaces, punctuation and capitals included).`;
    }
    if (afterVar && idx - pos > MAX_VAR_LENGTH) {
      return `A variable value is ${idx - pos} characters ("${message.slice(pos, idx).slice(0, 40)}…"); DLT allows at most ${MAX_VAR_LENGTH} per variable.`;
    }
    pos = idx + p.fixed.length;
    afterVar = false;
  }
  if (afterVar && message.length - pos > MAX_VAR_LENGTH) {
    return `The last variable value is ${message.length - pos} characters; DLT allows at most ${MAX_VAR_LENGTH}.`;
  }
  if (!afterVar && pos < message.length) return `Extra text at the end: "${message.slice(pos, pos + 30)}". The message must end where the template ends.`;
  return 'The message does not match the template.';
}

/** Best-effort OTP: a numeric variable of 4–8 digits, else the first stand-alone 4–8 digit number. */
export function extractOtp(message, values = []) {
  const fromVar = values.find((v) => /^\d{4,8}$/.test(v));
  if (fromVar) return fromVar;
  const m = /(?<!\d)(\d{4,8})(?!\d)/.exec(message);
  return m ? m[1] : null;
}

/** Normalise an Indian mobile number to +91XXXXXXXXXX; other countries must be in +<code> form. */
export function normalisePhone(input) {
  const s = String(input ?? '').replace(/[\s()-]/g, '');
  const m = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(s);
  if (m) return `+91${m[1]}`;
  if (/^\+[1-9]\d{6,14}$/.test(s)) return s;
  return null;
}
