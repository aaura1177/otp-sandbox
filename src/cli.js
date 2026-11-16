import { readFileSync } from 'node:fs';
import { lintTemplate, matchMessage, segments } from './dlt.js';
import { createApp, loadTemplates } from './server.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `otp-sandbox ${VERSION}
A fake SMS gateway for local development, with a web inbox and a DLT template checker.

Usage:
  otp-sandbox serve                      start the gateway + inbox on http://localhost:4010
  otp-sandbox lint "<template>"          check a template against DLT rules
  otp-sandbox lint "<template>" --message "<sms>"   would this SMS match the template?

serve options:
  --port <n>            default 4010
  --host <h>            default 127.0.0.1 (use 0.0.0.0 to reach it from a phone/emulator on your Wi-Fi)
  --templates <file>    JSON list of your registered templates: [{"id","text","sender"}]
  --strict              reject messages that match none of the templates (like operators do)
  --delay <ms>          wait before answering, to test loading states
  --fail-rate <0-1>     answer 503 randomly, to test retries / "resend OTP"

lint options:
  --message <text>      an actual SMS to match against the template
  --sender <id>         the 6-letter header (sender ID) to check

Exit codes: 0 ok, 1 lint errors / no match, 2 bad usage.`;

export function parseArgs(argv) {
  const o = { command: null, args: [], port: 4010, host: '127.0.0.1', templates: null, strict: false, delay: 0, failRate: 0, message: null, sender: null };
  const value = (i, f) => {
    if (i + 1 >= argv.length) throw new Error(`${f} needs a value`);
    return argv[i + 1];
  };
  const num = (v, f, { min = 0, max = Infinity, int = true } = {}) => {
    const n = Number(v);
    if (!Number.isFinite(n) || (int && !Number.isInteger(n)) || n < min || n > max) throw new Error(`${f} must be a number from ${min} to ${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': o.command = 'help'; break;
      case '-v': case '--version': o.command = 'version'; break;
      case '--port': o.port = num(value(i, a), a, { min: 1, max: 65535 }); i++; break;
      case '--host': o.host = value(i, a); i++; break;
      case '--templates': o.templates = value(i, a); i++; break;
      case '--strict': o.strict = true; break;
      case '--delay': o.delay = num(value(i, a), a, { max: 120000 }); i++; break;
      case '--fail-rate': o.failRate = num(value(i, a), a, { max: 1, int: false }); i++; break;
      case '--message': o.message = value(i, a); i++; break;
      case '--sender': o.sender = value(i, a); i++; break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown option ${a}. Run with --help.`);
        o.args.push(a);
    }
  }
  if (!o.command) o.command = o.args.shift() || 'help';
  return o;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const color = Boolean(stdout.isTTY) && !env.NO_COLOR;
  const paint = (c, t) => (color ? `\x1b[${{ error: 31, warning: 33, info: 36, ok: 32, dim: 2 }[c]}m${t}\x1b[0m` : t);
  const out = (s = '') => stdout.write(`${s}\n`);
  try {
    const o = parseArgs(argv);
    switch (o.command) {
      case 'help': out(HELP); return 0;
      case 'version': out(VERSION); return 0;
      case 'lint': {
        const template = o.args[0];
        if (!template) throw new Error('Give the template text in quotes, e.g. otp-sandbox lint "Your OTP is {#var#}. Do not share it. - ACME"');
        const { issues, variables } = lintTemplate(template, { sender: o.sender });
        out(`Template: ${template}`);
        out(paint('dim', `${variables} variable(s); ${JSON.stringify(segments(template))}`));
        for (const i of issues) out(`${paint(i.level, i.level.toUpperCase().padEnd(7))} ${i.message}`);
        let failed = issues.some((i) => i.level === 'error');
        if (o.message !== null) {
          const m = matchMessage(template, o.message);
          if (m.ok) out(`${paint('ok', 'MATCH  ')} The message fits the template. Values: ${m.values.map((v) => JSON.stringify(v)).join(', ') || '(none)'}`);
          else {
            out(`${paint('error', 'NO MATCH')} ${m.reason}`);
            failed = true;
          }
        }
        if (!issues.length && o.message === null) out(paint('ok', 'No problems found.'));
        return failed ? 1 : 0;
      }
      case 'serve': {
        const templates = o.templates ? loadTemplates(o.templates) : [];
        const server = createApp({ templates, strict: o.strict, delay: o.delay, failRate: o.failRate });
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(o.port, o.host, resolve);
        });
        const shown = o.host === '0.0.0.0' ? 'localhost' : o.host;
        out(`otp-sandbox ${VERSION} running. Nothing is really sent.`);
        out(`  Inbox:    http://${shown}:${o.port}/`);
        out(`  Send:     POST http://${shown}:${o.port}/api/sms   {"to":"9876543210","message":"Your OTP is 123456","template_id":"..."}`);
        out(`  Read OTP: GET  http://${shown}:${o.port}/api/otp/latest?to=9876543210`);
        if (templates.length) out(`  DLT check: ${templates.length} template(s)${o.strict ? ', strict' : ''}`);
        if (o.failRate) out(`  Simulating ${Math.round(o.failRate * 100)}% failures`);
        out(paint('dim', 'Press Ctrl+C to stop.'));
        await new Promise((resolve) => server.once('close', resolve));
        return 0;
      }
      default:
        throw new Error(`Unknown command "${o.command}". Run with --help.`);
    }
  } catch (err) {
    stderr.write(`otp-sandbox: ${err.code === 'EADDRINUSE' ? 'that port is already in use; try --port 4011' : err.message}\n`);
    return 2;
  }
}
