# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
Runtime dependencies: the SDK and `ws`. It started from the official
JavaScript template.

It reads a **Droplet** water flow sensor (Hydrific) through its local
WebSocket (`wss://<host>:443/ws`, pairing code in `Authorization`, a
self-signed certificate), ported from
[pydroplet](https://github.com/Hydrific/pydroplet) 2.5.0 (MIT, Hydrific), see
`THIRD_PARTY_NOTICES.md`. Unofficial. **Read-only**: never `onSetValue`, never
a message sent to the Droplet (only the upgrade and pings). Siblings:
`gladys-sunpower-pvs` (structure of `src/app.js`, store, pin, config parsers),
`gladys-span-panel` (the counter guard `src/volume.js` follows), `gladys-flo`
(water units). No Droplet was available: every test runs against a fake one.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png, 800 x 534, plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

## Architecture

```
index.js                SDK wiring only: handlers registered before connect()
src/app.js              DropletApp: getConfig retries, the pace, the pin, the refusal, identity, publication, /data, buttons
src/droplet/client.js   the only network access (ws, fingerprint checked before the code goes, bounded)
src/droplet/model.js    the messages -> values, strict (pure)
src/volume.js           the water index built from the volume reports (pure)
src/store.js            what /data keeps across restarts (unreadable is not empty)
src/devices.js          the device, feature keys, external ids, states (pure)
src/config.js           the address, the pairing code, the fingerprint, normalized
src/constants.js        pacing, limits, manifest keys
src/i18n.js             runtime texts (en/fr)
test/helpers/app.js     the app on a fake Gladys, a fake Droplet and a virtual clock
test/helpers/server.js  a real TLS WebSocket server playing the Droplet; a TLS impostor
```

## Rules

- **External ids are forever**: `ext:<selector>:droplet:<ids>`, feature keys
  `flow`, `water_index`, `server`, `signal`, `leak`, `unusual_flow`.
- **The pairing code** is never logged, never in /data, never in a status nor
  an error (our own messages only). It leaves only after `checkPeer` accepted
  the certificate (pinned in /data first).
- **Water index**: `src/volume.js`. Never 0, never down, held reports only by
  `accept_held` in two clicks, bounded to the listed amount; published only
  after /data holds it. Dates on the session clock (`sessionNow`).
- **Pace**: never two attempts less than `CONNECT_INTERVAL` apart, the attempt
  time in /data before the connection; one connection at a time.
- **Clocks**: `monotonic` for every timer and decision; the wall clock only for
  /data. Tests use the virtual clock of `test/helpers/clock.js` (copied from
  the test kit).
- Units: only `DEVICE_FEATURE_UNITS_BY_CATEGORY` of the core.
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks
  they agree. **Changelog** under `## [Unreleased]`. **User-facing text**
  bilingual (en/fr), docs in sync with the code.
- **Style**: Prettier, ESLint; comments in English explain why; tests never
  touch the network beyond 127.0.0.1.
