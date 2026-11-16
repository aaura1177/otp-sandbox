# Contributing

- **No runtime dependencies.** Node.js 18+ built-ins only.
- **Never send real SMS.** This tool is a sandbox; it must not forward messages anywhere.
- DLT rules change and differ per operator. When you add or change a rule in `src/dlt.js`, link the source
  (operator portal doc, provider doc, or a real rejection you saw) in the PR.
- Every rule needs a passing and a failing case in `test/dlt.test.js`. Server behaviour goes in `test/server.test.js`.

## Before you open a PR

```bash
npm test
```
