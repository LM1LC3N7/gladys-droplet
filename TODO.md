# TODO

## Before announcing

- [ ] Review r1 (high).
- [ ] Test with a real Droplet (none available): the pairing code, the first
      connection and pin, the information message, the cadence of the state
      messages, the units, a few days of water index against the Droplet app.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic at publication only.

## To confirm on a real Droplet (built without one)

- [ ] The Droplet sends its information message (`ids`) at each connection,
      or at least within a minute: nothing is published before it (pydroplet
      waits up to 10 s for it in its discovery). If it never comes, a
      fallback is needed (pydroplet's discovery takes the device id from the
      mDNS service name `Droplet-XXXX`).
- [ ] The units: `flow` in L/min and `volume` in mL (pydroplet README). The
      Droplet app counts in US gallons: if the local API ever sends gallons,
      the conversion goes in `src/devices.js` / `src/app.js`.
- [ ] How often `volume` comes and whether the first report of a connection
      covers time before it (the bound allows 10 L of slack plus 200 L/min).
- [ ] The answer of a wrong pairing code on firmware after 1.4.1 (401 or 403
      assumed; another 4xx is read as an HTTP error, retried with backoff).
- [ ] Whether the Droplet answers WebSocket pings (pydroplet's aiohttp
      heartbeat relies on it).
- [ ] Whether the certificate is per device (a replaced Droplet then shows
      "certificate changed" until its fingerprint is typed).
- [ ] How many local clients the Droplet accepts (Home Assistant and Gladys
      at once).

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`).
- SDK `^0.16.0` (the template's; the latest published is 0.16.0). `ws`
  `^8.22.0` for the WebSocket (`finishRequest` holds the upgrade until the
  certificate is checked).
- Manifest: `categories: ["energy", "security"]` (a water meter, leak alerts),
  `gladys_version: ">=5.1.0"`; no `keywords` / `countries` yet (to add when
  the core accepts them: `US`, `CA`).
- Flow as `water-valve` / `flow` in m³/h (the only unit the core lists for
  it, as gladys-flo); index as `volume-sensor` / `decimal` in L. The core
  counts no water consumption: the index is a plain cumulative value.
- Device id = the `ids` field of the information message; nothing published
  without it; another id at the address = another device with its own index.
- The water index is built here (the Droplet has no counter): never 0, never
  down (a drop of a built index is never accepted, not even by a click), a
  report above 200 L/min over the time since the previous one (capped to
  10 min) plus 10 L held until accepted in two clicks, bounded to the amount
  listed. /data keeps the net total; Gladys's value wins when larger.
- The volumes are kept counting while Gladys is disconnected (the connection
  to the Droplet stays); they are lost while the Droplet is not connected.
- The pairing code refused is a marker in /data, never the code nor a hash
  (a 6-digit code would be found back): after a restart, any save of the
  form lifts it (one attempt per save).
- Leak alerts as `leak-sensor` / `binary` (only known while the Droplet
  reaches the Hydrific servers, said in the docs).
- No mDNS discovery: the address is typed.
- The 10 L slack of the volume bound is per report, not per duration (review
  r1, m5, kept as it is): a burst of 10 L reports would be counted.
- Two closes at once before any data = the code taken as refused (firmware
  1.4.1 and older), said as "most likely" in the status: a Droplet full of
  local clients would look the same (to confirm on a real Droplet).
- Flow and leak alerts keep their last value when the Droplet is unreachable
  (no "unknown" state in Gladys); the badge turns unreachable after a minute
  (review r1, m2, said in the docs).

## Later

- A daily volume (the core has no water consumption API yet).
- A "discard the held volume" button, if held reports turn out to be common.
