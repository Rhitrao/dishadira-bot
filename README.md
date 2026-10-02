# dishadira-bot

A single Cloudflare Worker (Hono, TypeScript, D1) that turns Click-to-WhatsApp enquiries into paid sessions for Disha Dira; see CONTRACT.md for the rules and tickets.md for the build order. Nothing is run locally: GitHub Actions runs `npm ci`, `npm run typecheck`, `npm test`, gitleaks and `wrangler deploy --dry-run` on every pull request and push, so open a PR and read the checks.
