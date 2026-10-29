# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below, distributed under its own
license. No code of it is shipped: the logic was rewritten in JavaScript.

## pydroplet (Hydrific/pydroplet)

<https://github.com/Hydrific/pydroplet>, published by Hydrific (a LIXIL
company), the maker of the Droplet. Version 2.5.0 (tag `v2.5.0`, commit
923f613, 2026-10-02). Its `pyproject.toml` declares the MIT license; its
`LICENSE` file carries the MIT text with the copyright line of the Python
packaging template it started from, reproduced below as it is.

Ported to JavaScript in `src/droplet/client.js` and `src/droplet/model.js`:
the local WebSocket `wss://<host>:443/ws` with the pairing code in the
`Authorization` header, a wrong code refused at the handshake (firmware after
1.4.1) or the connection closed at once (1.4.1 and older), the 30-second
heartbeat, the information message (`ids`, `mdl`, `mf`, `sw`, `sn`) and the
state message (`flow` in L/min, `volume` in mL since the previous report,
`server`, `signal`, `low_leak` / `high_leak` as "ON"/"OFF"), and the idea of
adding up the volume reports. Changed here: the certificate pinned instead of
ignored (checked before the code is sent), values read against strict types
and bounds (a text or `null` is never 0), the volumes added into an index
kept across restarts with a plausibility guard, the connection paced.

```
Copyright (c) 2018 The Python Packaging Authority

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

(MIT License.)

## ws

<https://github.com/websockets/ws>, the WebSocket client used at runtime,
installed from npm with its own MIT license (in `node_modules/ws/LICENSE`).

## Shared code of this author

`src/store.js`, the parsers of `src/config.js`, the structure of `src/app.js`
and `scripts/cover.mjs` come from gladys-sunpower-pvs; `src/volume.js` follows
the guard of the lifetime counters of gladys-span-panel (`src/guard.js`);
`test/helpers/clock.js` and the test certificates come from the author's test
kit. Same author, same license (Apache-2.0).
