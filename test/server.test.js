import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { createApp, loadTemplates } from '../src/server.js';

const templates = loadTemplates(fileURLToPath(new URL('../examples/templates.json', import.meta.url)));
const OTP_MSG = '482910 is your OTP to log in to Acme. It is valid for 10 minutes. Do not share it with anyone. - Acme';

const servers = [];
async function start(opts) {
  const s = createApp(opts);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
after(() => servers.forEach((s) => s.close()));

const post = (base, body, type = 'application/json') =>
  fetch(`${base}/api/sms`, { method: 'POST', headers: { 'content-type': type }, body: type === 'application/json' ? JSON.stringify(body) : new URLSearchParams(body).toString() });

let open;
let dlt;
let strict;
before(async () => {
  open = await start();
  dlt = await start({ templates });
  strict = await start({ templates, strict: true });
});

test('accepts an SMS, normalises the number, extracts the OTP', async () => {
  const res = await post(open, { to: '98765 43210', message: 'Your code is 4821' });
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.equal(m.to, '+919876543210');
  assert.equal(m.otp, '4821');
  assert.equal(m.status, 'delivered');

  const latest = await (await fetch(`${open}/api/otp/latest?to=9876543210`)).json();
  assert.equal(latest.otp, '4821');
});

test('form-encoded bodies work too', async () => {
  const res = await post(open, { mobile: '+919000000001', text: 'OTP 112233' }, 'application/x-www-form-urlencoded');
  assert.equal(res.status, 200);
});

test('rejects bad numbers and missing message', async () => {
  assert.equal((await post(open, { to: '12345', message: 'x' })).status, 400);
  assert.equal((await post(open, { to: '9876543210' })).status, 400);
  assert.equal((await fetch(`${open}/api/sms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 400);
});

test('DLT: registered template ID with matching text is delivered', async () => {
  const res = await post(dlt, { to: '9876543211', message: OTP_MSG, template_id: '1107160000000000001', sender: 'ACMEIN' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).otp, '482910');
});

test('DLT: mismatching text, unknown template, wrong header are blocked with a reason', async () => {
  const changed = await post(dlt, { to: '9876543211', message: OTP_MSG.replace('log in', 'login'), template_id: '1107160000000000001' });
  assert.equal(changed.status, 422);
  assert.match((await changed.json()).error, /Blocked by DLT check: The message differs from the template after "…your OTP to log": the template has " in to Acme/);

  const unknown = await post(dlt, { to: '9876543211', message: OTP_MSG, template_id: '999' });
  assert.equal(unknown.status, 422);
  assert.match((await unknown.json()).error, /not registered/);

  const header = await post(dlt, { to: '9876543211', message: OTP_MSG, template_id: '1107160000000000001', sender: 'OTHERS' });
  assert.equal(header.status, 422);

  const blocked = await (await fetch(`${dlt}/api/sms?to=9876543211`)).json();
  assert.ok(blocked.some((m) => m.status === 'blocked'));
});

test('DLT: without template_id, matching is lenient unless --strict', async () => {
  const lenient = await post(dlt, { to: '9876543212', message: 'random text 1234' });
  assert.equal(lenient.status, 200);
  assert.ok((await lenient.json()).warnings.some((w) => /none of your registered templates/.test(w)));
  assert.equal((await post(strict, { to: '9876543212', message: 'random text 1234' })).status, 422);
  assert.equal((await post(strict, { to: '9876543212', message: OTP_MSG })).status, 200);
});

test('blocked messages do not count as the latest OTP', async () => {
  await post(dlt, { to: '9876543213', message: OTP_MSG.replace('Acme.', 'ACME.'), template_id: '1107160000000000001' });
  assert.equal((await fetch(`${dlt}/api/otp/latest?to=9876543213`)).status, 404);
});

test('fail-rate simulates outages', async () => {
  const flaky = await start({ failRate: 1 });
  assert.equal((await post(flaky, { to: '9876543210', message: 'OTP 1234' })).status, 503);
});

test('inbox page, listing, clearing, 404', async () => {
  const html = await (await fetch(`${open}/`)).text();
  assert.match(html, /otp-sandbox/);
  assert.equal((await fetch(`${open}/api/sms`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await (await fetch(`${open}/api/sms`)).json(), []);
  assert.equal((await fetch(`${open}/nope`)).status, 404);
});

function capture() {
  let text = '';
  return { write: (s) => ((text += s), true), get text() { return text; }, isTTY: false };
}

test('cli lint', async () => {
  const ok = capture();
  assert.equal(await main(['lint', templates[0].text, '--message', OTP_MSG, '--sender', 'ACMEIN'], { stdout: ok, stderr: capture(), env: {} }), 0);
  assert.match(ok.text, /MATCH/);
  const bad = capture();
  assert.equal(await main(['lint', 'Your OTP is {{otp}} for Acme login today'], { stdout: bad, stderr: capture(), env: {} }), 1);
  assert.match(bad.text, /ERROR/);
  assert.equal(await main(['lint'], { stdout: capture(), stderr: capture(), env: {} }), 2);
  assert.equal(await main(['serve', '--fail-rate', '2'], { stdout: capture(), stderr: capture(), env: {} }), 2);
});
