# Contributing to Phinq

Thanks for your interest! Phinq is open source (MIT) and contributions are welcome.

## Getting started

```bash
git clone https://github.com/phinq-co/phinq.git
cd phinq/proxy
npm install
npm run build
npm test
```

## What needs help

- **New adapter integrations** — Mastra, LangChain, Vercel AI SDK, etc.
- **Classifier rules** — add tool-name patterns to the deterministic classifier
- **Docs and examples** — demos, integrations, blog posts
- **SDK** — the `@phinq/governance` in-process SDK in `sdk/`

## Pull request process

1. Open an issue first if it's not a trivial fix
2. Make your changes, add or update tests
3. Run `npm test` — all tests must pass
4. Open a PR against `main`

## Code style

- TypeScript strict mode
- No external AI services used in the classifier (it must remain deterministic)
- Audit entries must always carry `prev_hash` and `entry_hash`

## License

By contributing, you agree that your contributions will be licensed under MIT.