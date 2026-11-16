#!/usr/bin/env node
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`otp-sandbox needs Node.js 18 or newer (you have ${process.version}). Get it from https://nodejs.org`);
  process.exit(2);
}

const { main } = await import('../src/cli.js');
process.exitCode = await main(process.argv.slice(2));
