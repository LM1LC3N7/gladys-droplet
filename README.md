# gladys-droplet

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for the
**Droplet** water flow sensor by Hydrific (a LIXIL company), read on the home
network through its local WebSocket: flow rate, a water index built from the
volumes it reports, server connectivity, signal quality, leak and unusual
flow alerts. Read-only. Not affiliated with Hydrific nor LIXIL.

**Never tested with a real Droplet**: built from Hydrific's own library
[pydroplet](https://github.com/Hydrific/pydroplet) (MIT) and tested against a
fake Droplet (a local TLS WebSocket server). Reports are welcome.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Changes: [CHANGELOG.md](CHANGELOG.md). Open points: [TODO.md](TODO.md).
- Security: [SECURITY.md](SECURITY.md).

## How it works

- `wss://<address>:443/ws`, the pairing code of the Droplet app in the
  `Authorization` header, as pydroplet does. The self-signed certificate of the
  Droplet is pinned at the first connection (written to /data before the code
  is sent); another certificate later sends nothing and shows its fingerprint.
- The Droplet pushes state messages (flow in L/min, volume in mL since the
  previous report, server connectivity, signal quality, leaks) and an
  information message with its device id. One Gladys device per device id.
- The water index (litres) is the running total of the volume reports, kept in
  /data, published once a minute: never 0, never lower than before, a report
  too large for the time since the previous one held until accepted in two
  clicks.
- One connection at a time, never two attempts less than 30 s apart (kept
  across restarts), backoff up to 30 min, pings every 30 s, a refused pairing
  code never tried again by itself, 429/5xx paused up to 6 h.

## Development

```bash
npm install
npm test               # node --test --test-timeout=60000
npm run lint
npm run format:check
npm run audit          # npm audit --omit=dev
npm run cover          # cover.png
```

Tests run against the SDK's fake Gladys, a fake Droplet (`test/helpers/app.js`,
virtual clock) and a real local TLS WebSocket server (`test/helpers/server.js`,
real clock in `test/realclock.test.js`). See [CLAUDE.md](CLAUDE.md) for the
architecture and the rules.

## License

Apache-2.0 (see [LICENSE](LICENSE)); the ported logic of pydroplet is under
its MIT license, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
