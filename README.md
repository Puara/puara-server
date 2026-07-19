# Puara Audience

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

```sh
npm install
npm run dev        # build + watch, server on http://127.0.0.1:8000
npm run bridge     # in a second terminal: OSC bridge (after `npm run build`)
```

- Player (phones): `http://<server-ip>:8000/?zone=north`
- Controller dashboard: `http://<server-ip>:8000/controller`
- OSC out: UDP `127.0.0.1:9000` by default — verify with
  `oscdump 9000` or point ossia score at it.
- Emulate a crowd without phones: `http://127.0.0.1:8000/?emulate=10`.

**Real phones need HTTPS** (sensor APIs require a secure context) — see
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the mkcert setup (dev) and the
Let's Encrypt / venue-DNS path (production), plus the audience-scale WiFi
checklist.

## Configuration (artist-facing)

Everything tunable lives in [`config/puara.yaml`](config/puara.yaml):
`sensorRate` (ceiling, Hz), `bridgeTick` (aggregate/OSC tick, Hz), `emitRaw`
(per-device raw streams on/off), `interactionMode`
(`sensors` / `touch` / `events-only`), `zones` (dome sections → QR codes),
`maxClients`, `oscDestinations`. `sensorRate`, `interactionMode` and `emitRaw`
can also be changed **live** from the controller dashboard.

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

## Related projects

- [Puara](https://github.com/Puara) — SAT framework for new media instruments
- [ossia score](https://ossia.io/) — intermedia sequencer consuming the OSC
- [SpatGRIS](https://gris.musique.umontreal.ca/) — spatialization (GRIS, Université de Montréal)
- [CoMo](https://ismm.ircam.fr/como/), [Playground](https://github.com/collective-soundworks)
  — other soundworks-based collective experiences from IRCAM
