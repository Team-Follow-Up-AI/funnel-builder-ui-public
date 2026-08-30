# Funnel Studio public sandbox

This standalone contributor project packages the complete Funnels-panel presentation as a safe localhost demo. It uses synthetic data and has no authentication, proxy, database, provider, deployment, or release connection.

## Start locally

Prerequisites: Node.js 20 or newer and npm.

```sh
npm install --ignore-scripts
npm run dev
```

Open <http://127.0.0.1:4173/#/funnels>. No environment file, account, token, VPN, or external service is required. Fixture changes live only in memory and reset when the process stops.

Run the complete gate with:

```sh
npm run validate
```

The packaged baseline was tested with Node.js 26.5.0 and npm 11.17.0 using `npm install --ignore-scripts`, `npm run validate`, and isolated Chrome smoke checks at 1440×900 and 390×844.

## Demo routes

| Surface | URL |
| --- | --- |
| Funnel list | <http://127.0.0.1:4173/#/funnels> |
| Current fixture | <http://127.0.0.1:4173/#/funnels/summer-roofing-guide> |
| Editable Test draft | <http://127.0.0.1:4173/#/funnels/summer-roofing-guide/build> |
| Empty state | <http://127.0.0.1:4173/?scenario=empty#/funnels> |
| Error state | <http://127.0.0.1:4173/?scenario=error#/funnels> |
| Loading state | <http://127.0.0.1:4173/?scenario=loading#/funnels> |

Only Funnels is supported. Other product panels are intentionally unavailable.

## Architecture and safety

- `public/` contains the editable full presentation UI.
- `server.mjs` is a loopback-only static server and explicit mock API allowlist.
- `fixtures.mjs` contains obvious synthetic funnels, versions, drafts, and conversations.
- `test/` proves the main UI contract and refusal boundaries.
- `scripts/audit.mjs` rejects common secrets, personal data, workstation paths, and non-allowlisted absolute URLs.
- `PROVENANCE.json` maps the packaged presentation files and records their hashes and sandbox-only adaptations.

The preview is generated locally and cannot submit forms or load external resources. Co-author messages are visibly simulated. Check, Commit, release, WebSocket, provider, and unknown API paths fail closed.

## Contributing

Read [`AGENTS.md`](./AGENTS.md), start the demo, and run `npm run validate` before editing. Use only synthetic fixtures and keep all runtime traffic on localhost. Work on a feature branch, smoke-test desktop and mobile, push only that branch, and open a pull request. Do not merge or deploy from this sandbox.

Integration is intentionally one-way and manual: changes are reviewed in this repository, then an authorized maintainer may separately port an approved UI diff into an authorized product repository. There is no automatic sync, authenticated bridge, or deployment path.

## Limitations

Only Funnels is packaged. Data resets on restart, preview pages are synthetic, the co-author is simulated, and browser checks, restore, Commit, release, deployment, provider, and customer-data workflows are unavailable.
