# puara-server

Browser-based audience interaction system for the
[Satosphère](https://sat.qc.ca/) — the SAT's 18 m immersive dome.

Audience members scan a QR code, open a web page on their phone, tap
**Commencer / Start**, and their device becomes a sensor/controller for the
piece: accelerometer, gyroscope, orientation, touch, taps and shakes stream to
the show system as OSC under a [Puara](https://github.com/Puara)-compatible
namespace, consumed by [ossia score](https://ossia.io/) and onward by
[SpatGRIS](https://gris.musique.umontreal.ca/)/MBAP or any OSC-capable tool.

This repository is **reusable infrastructure**, not a one-off piece: residency
artists configure interaction modes, zones, rates and OSC destinations in one
YAML file ([`config/puara.yaml`](config/puara.yaml)) without touching
framework internals.

## Architecture

```
[phone browsers]  --wss-->  [soundworks server (Node.js)]  <--ws-->  [controller dashboard (browser)]
                                      |
                                      v (SharedState observation)
                            [puara-bridge (soundworks Node client)]
                                      |
                                      v UDP OSC
                              [ossia score]  -->  [SpatGRIS / MBAP / piece logic]
```

Three client roles, one server:

| role | runtime | purpose |
|---|---|---|
| `player` | browser (phone) | sensors + touch UI → shared state; bilingual FR/EN, wake lock, zone from QR `?zone=…` |
| `controller` | browser | operator dashboard: live counts, per-client meters, sensor rate / interaction mode / scene controls, panic, per-zone QR codes (printable) |
| `puara-bridge` | node (headless) | observes all player states, computes crowd aggregates at a fixed tick, emits OSC |

## Built on soundworks (IRCAM)

The networking, state and client lifecycle layer is
[**soundworks**](https://soundworks.dev/), an open-source (BSD-3-Clause)
creative-coding framework for distributed WebAudio/web applications, developed
by the [{Sound Music Movement} Interaction team (ISMM)](https://ismm.ircam.fr/)
at IRCAM (STMS-LAB, Paris). soundworks was designed exactly for this class of
piece — *collaborative mobile web performances* where dozens to hundreds of
phones join a shared, synchronized environment.

What soundworks provides here:

- **Distributed shared state** (`StateManager`): each phone owns a `player`
  state; the server, dashboard and bridge observe collections of them. A
  dashboard change to the server-owned `global` state (e.g. `sensorRate`)
  propagates to every phone in well under a second — no hand-rolled protocol.
- **Client lifecycle & reconnection**: init screens, automatic WebSocket
  reconnection after lock/unlock or WiFi blips, browser *and* Node.js clients
  from the same codebase (the OSC bridge is just a headless soundworks client).
- **Plugins**: [`platform-init`](https://soundworks.dev/plugins/platform-init.html)
  (iOS motion-permission flow inside the required user gesture, via
  [`@ircam/devicemotion`](https://github.com/ircam-ismm/devicemotion) which
  normalizes iOS/Android sensor conventions) and
  [`checkin`](https://soundworks.dev/plugins/checkin.html) (unique client ids).
- **Tooling**: [`@soundworks/create`](https://github.com/collective-soundworks/soundworks-create)
  scaffolding, build pipeline, and [`@ircam/sc-components`](https://ircam-ismm.github.io/sc-components/)
  web components used by the dashboard.

References:

- Documentation & tutorials: <https://soundworks.dev/>
- API reference: <https://soundworks.dev/api>
- Source: <https://github.com/collective-soundworks/soundworks>
- ISMM team at IRCAM: <https://ismm.ircam.fr/>
- Founding paper: S. Robaszkiewicz & N. Schnell, *“Soundworks – A playground
  for artists and developers to create collaborative mobile web performances”*,
  Proceedings of the 1st Web Audio Conference (WAC), Paris, 2015.

The OSC vocabulary follows the conventions of the SAT's own
[**Puara**](https://github.com/Puara) framework for new media instruments and
installations; the full contract lives in [`docs/NAMESPACE.md`](docs/NAMESPACE.md).

## Getting started

Two scripts cover a Linux workstation or show machine end to end. No sudo.

```sh
./scripts/install.sh     # dependencies, mkcert, LAN certificate, env, build
./scripts/start.sh       # soundworks server + OSC bridge, Ctrl-C stops both
```

`install.sh` is **safe to rerun**: each step checks its own result and skips.
Nothing existing is overwritten — neither `certs/*.pem` nor
`config/env-dev.yaml`. Delete the file yourself to have it regenerated. What it
does: verifies Node ≥ 18 · `npm install` · fetches mkcert to `~/.local/bin`
(checksum-pinned) if missing · issues a certificate for the detected LAN IP,
hostname and localhost · writes `config/env-dev.yaml` pointing at it · builds.
Use `--no-https` for a desktop-only setup (no phone sensors).

`start.sh` flags:

| flag | effect |
|---|---|
| *(none)* | `ENV=dev` (HTTPS) if `config/env-dev.yaml` exists, else `default` (HTTP) |
| `--env <name>` | pick `config/env-<name>.yaml` explicitly |
| `--no-bridge` | server only |
| `--dump` | also run `oscdump` on the first configured OSC port |
| `--serve-ca` | serve the mkcert root CA over HTTP :8001 so a phone can install it |

Manual equivalent, if you prefer separate terminals:

```sh
npm install
npm run dev        # build + watch, server on http://127.0.0.1:8000
npm run bridge     # in a second terminal: OSC bridge (after `npm run build`)
```

- Player (phones): `https://<server-ip>:8000/?zone=north`
- Controller dashboard: `https://<server-ip>:8000/controller`
- OSC out: UDP `127.0.0.1:9000` by default — verify with
  `oscdump 9000` or point ossia score at it. Only one process can bind that
  port: add a second entry to `oscDestinations` to feed a monitor and ossia at
  the same time.
- Emulate a crowd without phones: `http://127.0.0.1:8000/?emulate=10`.

### Connecting a real phone

1. `./scripts/install.sh`, then `./scripts/start.sh`.
2. `./scripts/start.sh --serve-ca` in another terminal, open that URL on the
   phone, install the CA. On iOS also enable it under Settings → General →
   About → Certificate Trust Settings — the install alone is not enough, and
   without it `wss://` fails silently while the page still loads. Stop serving
   once enrolled.
3. Open the player URL, tap **Commencer / Start** — that gesture is what
   triggers the iOS motion permission prompt.
4. On the dashboard, switch `running` on. Sensors are gated on it.

Installing a local CA on a phone means whoever holds the CA private key
(`$(mkcert -CAROOT)/rootCA-key.pem`, on the server) can impersonate any HTTPS
site to that device. Use your own test hardware, keep the key on the machine
that generated it, and remove the CA from the phone when testing is over.
Audience devices must never install it — that is what the Let's Encrypt path in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) is for.

## HTTPS & certificates

**Real phones require HTTPS**: browsers only expose the motion sensors and
wake lock in a secure context, and on iOS a page-level certificate exception
does *not* cover `wss://` — so a properly trusted certificate is not optional.
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) covers the whole topic:

- **dev/lab**: [mkcert](https://github.com/FiloSottile/mkcert) local CA,
  installed once on each test phone;
- **production/audience**: a real hostname (e.g. `connect.sat.qc.ca`) with a
  free Let's Encrypt certificate obtained via DNS-01 challenge — including the
  concrete Cloudflare + certbot recipe, renewal, and why the server never
  needs to be exposed to the internet;
- the audience-scale WiFi checklist for the venue network team.

## Configuration (artist-facing)

Everything tunable lives in [`config/puara.yaml`](config/puara.yaml):
`sensorRate` (ceiling, Hz), `bridgeTick` (aggregate/OSC tick, Hz), `emitRaw`
(per-device raw streams on/off), `interactionMode`
(`sensors` / `touch` / `events-only`), `zones` (dome sections → QR codes),
`streams` (per-stream enable for accel/gyro/orientation/touch and each gesture
descriptor — gates the phone uplink, not just the OSC output), `publicAddress`
(origin the QR codes point at), `maxTouches`, `gestures` (puara-gestures
constants), `maxClients`, `oscDestinations`. Everything except
`bridgeTick`/`maxClients`/`oscDestinations` can also be changed **live** from
the controller dashboard.

### Gestures

Phones compute the [puara-gestures](https://github.com/Puara/puara-gestures)
descriptors locally ([`src/shared/gestures.js`](src/shared/gestures.js)) and
send those, so the network carries gestures rather than the motion behind them:

| descriptor | OSC | behaviour |
|---|---|---|
| `shake` | `fff` | energy per axis, accumulates while shaking, decays to 0 |
| `jab` | `fff` | signed acceleration span, latches on the last hit |
| `brush` | `ff` | signed touch travel per screen axis |
| `rub` | `ff` | unsigned, so back-and-forth accumulates |
| `button` | see below | `count`/`tap`/`dtap`/`ttap`/`press`/`hold`/`presstime` |

Multi-touch is on: `touch/count` plus `touch/<n>` per pointer, up to
`maxTouches`. Every constant is editable live in the dashboard's *Gesture
settings* panel — thresholds, leak rates, tap window, hold time. Full contract
in [`docs/NAMESPACE.md`](docs/NAMESPACE.md).

**Upgrading from namespace 0.1.0:** `/shake` was an event float on a threshold
crossing; that measurement is now `/jab fff` and `/shake fff` is the continuous
energy signal. Patches listening for the old `/shake f` should move to `/jab`.

### QR code address

QR codes point at `publicAddress`, never the dashboard's own URL — an operator
with the dashboard open on `localhost` would otherwise print QR codes no phone
can reach. Leave it blank and the server uses its own LAN address; set it to a
hostname (`https://connect.sat.qc.ca:8000`) when one points at the machine. The
dashboard has an editable field for it and regenerates the codes on change.

Environment config (port, HTTPS certs) follows the soundworks convention:
`config/env-default.yaml`, overridden by `ENV=<name>` →
`config/env-<name>.yaml` (gitignored except default).

## Repository layout

```
src/
├── server.js                 # server, plugins, state classes, global state
├── clients/
│   ├── player.js             # audience phone client
│   ├── controller.js         # operator dashboard
│   └── puara-bridge.js       # headless client → UDP OSC
└── shared/
    ├── schemas.js            # SharedState class descriptions
    ├── namespace.js          # OSC namespace builder (single source of truth)
    ├── strings.js            # FR/EN UI strings
    └── load-puara-config.js  # config/puara.yaml loader (node side)
docs/
├── NAMESPACE.md              # the OSC contract (versioned, currently 0.1.0)
└── DEPLOYMENT.md             # certs, DNS, WiFi notes
```

## Status & roadmap

Prototype (M1–M2 of the project brief): skeleton + bridge verified end-to-end
on LAN. Remaining: dashboard hardening (M3), aggregate tuning with a 5-phone
demo driving an ossia scenario (M4), frozen namespace + artist guide (M5).
Explicit non-goals for v1: phone audio playback, puara-gestures descriptor
extraction (raw + simple aggregates only — richer descriptors happen
ossia-side), accounts/persistence, public-internet deployment.

## License

[BSD 3-Clause](LICENSE), matching the
[soundworks](https://github.com/collective-soundworks/soundworks) framework it
is built on.

## Related projects

- [Puara](https://github.com/Puara) — SAT framework for new media instruments
- [ossia score](https://ossia.io/) — intermedia sequencer consuming the OSC
- [SpatGRIS](https://gris.musique.umontreal.ca/) — spatialization (GRIS, Université de Montréal)
- [CoMo](https://ismm.ircam.fr/como/), [Playground](https://github.com/collective-soundworks)
  — other soundworks-based collective experiences from IRCAM
