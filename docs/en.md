# Droplet

Unofficial integration, not affiliated with Hydrific nor LIXIL. It reads a
**Droplet** clamp-on water flow sensor on your home network, without the
cloud, through the local WebSocket the Droplet opens (firmware 1.4.0 or
later), as Hydrific's own library pydroplet does. **Read-only**: no setting
nor command is ever sent to the Droplet. **Never tested with a real Droplet**: it was
built from pydroplet and tested against a fake one; please report what you
see.

## Setup

1. In the Droplet app, find the **pairing code** for local access.
2. Give the Droplet a fixed IP address in your router.
3. In Gladys, fill **Droplet address** (e.g. `192.168.1.30`, a port only if it
   is not 443) and **Pairing code**, then save.
4. The status shows `Connected to Droplet <id>` once the Droplet has sent its
   device id. Create the device in the **Discover** tab.

The pairing code is kept by Gladys in its database, never shown again, and
sent only to the Droplet, over TLS, after its certificate was checked.

## What you get

| Feature             | Unit | Notes                                           |
| ------------------- | ---- | ----------------------------------------------- |
| Flow rate           | m³/h | the Droplet gives L/min (1 L/min = 0.06 m³/h)   |
| Water index         | L    | built from the volume reports, see below        |
| Server connectivity | text | as the Droplet says it (e.g. "Connected")       |
| Signal quality      | text | ultrasonic signal, as the Droplet says it       |
| Leak                | 0/1  | flow above the threshold set in the Droplet app |
| Unusual flow        | 0/1  | a leaky flapper, a slow leak                    |

Leak and unusual flow are only known while the Droplet reaches the Hydrific
servers. The live values go to Gladys at most every 10 seconds; a value older
than 2 minutes is not sent again as new (after a restart of Gladys, a device
created).

## The water index

The Droplet has no meter reading: it reports the volume since its previous
report (in mL, sometimes negative). The integration adds the reports up into
an index in litres, kept in /data across restarts, published once a minute
after /data holds it. Its rules:

- it is never 0 and never goes down: a negative report lowers the running
  total, and the index waits until the total climbs back above it (the status
  says by how much when it is 1 L or more);
- a report larger than what 200 L/min (about 53 US gal/min) bring in the time
  since the previous report (counted up to 10 minutes) plus 10 L is **held**:
  shown in the status (orange badge), kept in /data, never counted by time
  nor by repetition. The reports after it count as usual. If it is right,
  click **Accept the held volume** twice (3 seconds to 5 minutes apart): the
  second click adds exactly what the first one listed. A negative report that
  large is ignored (counted in the status);
- the volumes reported before the Droplet gives its device id count for that
  Droplet once it does; the volumes reported while the integration is not
  connected to the Droplet are not known (the index stays where it was);
- if Gladys already holds a larger index than /data (a /data lost), the index
  goes on from Gladys's value;
- another Droplet at the address (a replacement) is another device, with its
  own index. Deleting and creating the device again keeps the index going.

## Connection

- One connection at a time. A connection that ends is opened again 30 seconds
  after the previous attempt; while it fails, after 30 s, 1, 2, 4... up to 30
  minutes. Never
  two attempts less than 30 seconds apart, whatever asks (the test button, a
  save, a restart: the time of the attempt is kept in /data).
- A ping every 30 seconds: no answer within 15 seconds, the connection is
  closed and opened again later.
- **Pairing code refused** (an HTTP 401/403 at the handshake, or, with
  firmware 1.4.1 and older, the connection closed by the Droplet before any
  message, twice in a row): nothing is tried by itself until you save the code
  again or the **Test the connection** button gets a connection (one attempt
  per click, at the pace above).
- HTTP 429 or 5xx at the handshake: a pause of 1 minute, doubled up to 6 hours,
  kept across restarts.
- **Certificate**: pinned at the first connection (written to /data before the
  code is sent). Another certificate later: nothing is sent and the status
  shows its fingerprint; if you replaced or reset the Droplet, copy it into
  **Certificate fingerprint** and save.
- /data that cannot be read: no certificate is learned (nothing sent unless a
  fingerprint is typed), the index is not published (its volumes are kept in
  memory and added once /data reads again), and the file is never
  overwritten.

## Buttons

- **Test the connection**: while connected, the flow and the index; otherwise
  one attempt when it is due.
- **Accept the held volume**: see "The water index".

## Not done

No discovery on the network (type the address), no settings of the Droplet,
no history from the Hydrific cloud.
