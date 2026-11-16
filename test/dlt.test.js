import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractOtp, lintSender, lintTemplate, matchMessage, normalisePhone, parseTemplate, segments } from '../src/dlt.js';

const OTP_T = '{#var#} is your OTP to log in to Acme. It is valid for 10 minutes. Do not share it with anyone. - Acme';
const levels = (r) => r.issues.map((i) => i.level);

test('parseTemplate splits fixed text and typed variables', () => {
  assert.deepEqual(parseTemplate('Hi {#var#}, code {#numeric#}.'), [{ fixed: 'Hi ' }, { variable: 'var' }, { fixed: ', code ' }, { variable: 'numeric' }, { fixed: '.' }]);
});

test('a good OTP template has no errors', () => {
  const r = lintTemplate(OTP_T, { sender: 'ACMEIN' });
  assert.ok(!levels(r).includes('error'), JSON.stringify(r.issues));
  assert.equal(r.variables, 1);
  assert.ok(r.issues.some((i) => /Service Implicit/.test(i.message)));
});

test('wrong placeholder styles are errors', () => {
  for (const bad of ['Your OTP is {{otp}} for Acme login today', 'Your OTP is {otp} for Acme login today', 'Your OTP is %s for Acme login today', 'Your OTP is $otp for Acme login today', 'Your OTP is <otp> for Acme login today', 'Your OTP is {#VAR#} for Acme login today', 'Your OTP is {# var #} for Acme login today', 'Your OTP is ##otp## for Acme login today']) {
    const r = lintTemplate(bad);
    assert.ok(levels(r).includes('error'), bad);
  }
  assert.ok(!levels(lintTemplate('Your OTP is {#numeric#} for Acme login today')).includes('error'));
});

test('too-generic and adjacent-variable templates are flagged', () => {
  assert.ok(levels(lintTemplate('{#var#} {#var#}')).includes('error'));
  assert.ok(lintTemplate('Dear customer {#var#}{#var#} is your login code at Acme').issues.some((i) => /next to each other/.test(i.message)));
  assert.ok(levels(lintTemplate('')).includes('error'));
});

test('links and length are warned about', () => {
  assert.ok(lintTemplate('Track your Acme order at https://acme.in/t/{#var#} today').issues.some((i) => /whitelisted/.test(i.message)));
  const long = `Dear {#var#}, ${'this is a long message for you. '.repeat(4)}`;
  assert.ok(lintTemplate(long).issues.some((i) => /SMS parts/.test(i.message)));
});

test('sender IDs', () => {
  assert.deepEqual(lintSender('ACMEIN'), []);
  assert.equal(lintSender('acmein')[0].level, 'warning');
  assert.equal(lintSender('123456')[0].level, 'warning');
  assert.equal(lintSender('ACME')[0].level, 'error');
});

test('matchMessage: exact match and values', () => {
  const m = matchMessage(OTP_T, '482910 is your OTP to log in to Acme. It is valid for 10 minutes. Do not share it with anyone. - Acme');
  assert.deepEqual(m, { ok: true, values: ['482910'] });
});

test('matchMessage: explains the usual mismatches', () => {
  const changed = matchMessage(OTP_T, '482910 is your OTP to login to Acme. It is valid for 10 minutes. Do not share it with anyone. - Acme');
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /differs from the template after "…your OTP to log": the template has " in to Acme/);

  const tooLong = matchMessage('Hi {#var#}, welcome to Acme services today', `Hi ${'x'.repeat(31)}, welcome to Acme services today`);
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.reason, /at most 30/);

  const extra = matchMessage('Your Acme code is {#numeric#}. Thanks', 'Your Acme code is 1234. Thanks!!');
  assert.equal(extra.ok, false);

  const typed = matchMessage('Your Acme code is {#numeric#}. Thanks', 'Your Acme code is 12AB. Thanks');
  assert.equal(typed.ok, false);
  assert.match(typed.reason, /numeric/);
});

test('matchMessage handles regex characters in fixed text', () => {
  assert.ok(matchMessage('Pay Rs.(100) + tax [GST] to Acme? {#var#}', 'Pay Rs.(100) + tax [GST] to Acme? now').ok);
});

test('segments: GSM vs Unicode', () => {
  assert.deepEqual(segments('a'.repeat(160)), { encoding: 'GSM-7', length: 160, parts: 1 });
  assert.equal(segments('a'.repeat(161)).parts, 2);
  assert.equal(segments('€'.repeat(80)).length, 160);
  assert.deepEqual(segments('आपका OTP 1234 है'), { encoding: 'Unicode', length: 16, parts: 1 });
  assert.equal(segments('क'.repeat(71)).parts, 2);
});

test('extractOtp', () => {
  assert.equal(extractOtp('Use 4821 to log in. Valid for 10 mins'), '4821');
  assert.equal(extractOtp('Order 12 shipped'), null);
  assert.equal(extractOtp('Ref 12345678901 code 778899', ['778899']), '778899');
});

test('normalisePhone', () => {
  for (const v of ['9876543210', '+919876543210', '919876543210', '09876543210', '98765 43210', '+91 98765-43210']) assert.equal(normalisePhone(v), '+919876543210', v);
  assert.equal(normalisePhone('+14155550100'), '+14155550100');
  for (const v of ['12345', '5876543210', '', null, 'abc']) assert.equal(normalisePhone(v), null, String(v));
});
