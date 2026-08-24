# x402 Services Directory

A free, live directory of x402-paid API services, generated from public facilitator
discovery endpoints and regenerated on a schedule.

- **Human view:** `docs/index.html` (deployed via GitHub Pages)
- **Machine view:** `docs/services.json` — agents can consume this directly

Each service is probed for a real `402` payment challenge at generation time, so the
"verified sellable" count reflects working payment gates, not just registrations.

## Why

x402 sellers are discoverable only if you already know which facilitator to ask.
This aggregates public discovery endpoints into one neutral listing with prices,
networks, and gate-check results. It is intentionally dependency-free (Node 18+
built-ins only) so anyone can run it themselves.

## Regenerate locally

```bash
node generate.js   # writes docs/index.html + docs/services.json
```

## Automation

A GitHub Action regenerates the directory every 6 hours and pushes to `main`,
which republishes Pages. See `.github/workflows/refresh.yml`.
