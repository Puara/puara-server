# OSC Namespace — `/puara/audience` (v0.1.0)

This document is the **contract** between the puara-bridge and everything
downstream (ossia score, SpatGRIS, piece logic). The single source of truth in
code is [`src/shared/namespace.js`](../src/shared/namespace.js) — the two must
match exactly. Version bumps follow semver; the current version is emitted at
bridge startup on `/puara/audience/meta/version`.

Transport: **UDP**, destinations configured in
[`config/puara.yaml`](../config/puara.yaml) (`oscDestinations`, default
`127.0.0.1:9000`).

## Meta

Sent once at bridge startup, `connected` also on every join/leave.

| address | types | value |
|---|---|---|
| `/puara/audience/meta/version` | `s` | namespace version, e.g. `"0.1.0"` |
| `/puara/audience/meta/connected` | `i` | connected player count |
| `/puara/audience/meta/zones` | `i` | configured zone count |

## Per-device (raw) — gated by `emitRaw` and by `streams`

`<id>` is the integer index assigned by the checkin plugin (stable for the
lifetime of a connection, recycled after disconnect). Raw streams follow each
phone's effective sensor rate (see caveats below); messages are queued and
flushed in batches at the bridge tick (`bridgeTick`, default 30 Hz). At
audience scale set `emitRaw: false` and consume aggregates + events only.

Two gates, deliberately different in reach:

| gate | stops OSC output | stops the WiFi uplink |
|---|---|---|
| `emitRaw: false` | yes, all four raw addresses | **no** — phones keep streaming |
| `streams.<name>: false` | yes, that address | yes, the field leaves the state update |

So `streams` is the one to reach for when the *network* is the constraint —
`emitRaw` only spares the OSC consumer. Both are live from the dashboard.

With `streams.accel: false` the per-device `accel` address goes silent and the
energy aggregates report `0` rather than the last value the states happen to
hold. `streams.touch: false` likewise leaves `global/touchcount` at `0`.

| address | types | units / range |
|---|---|---|
| `/puara/audience/<id>/accel` | `fff` | m/s², **gravity included** (`accelerationIncludingGravity`), device axes x/y/z |
| `/puara/audience/<id>/gyro` | `fff` | deg/s, devicemotion `rotationRate` order **alpha, beta, gamma** |
| `/puara/audience/<id>/orientation` | `fff` | degrees, deviceorientation euler **alpha (0–360), beta (−180–180), gamma (−90–90)** |
| `/puara/audience/<id>/touch` | `ff` | normalized x, y in 0–1, top-left origin; **only sent while touching** |
| `/puara/audience/<id>/tap` | `i` | bang-style, always `1` |
| `/puara/audience/<id>/shake` | `f` | intensity in m/s² above the shake threshold (25 m/s²) |
| `/puara/audience/<id>/status` | `i` | `1` on connect, `0` on disconnect — **always emitted**, regardless of `emitRaw` |

Events (`tap`, `shake`, `status`) are always emitted, in every
`interactionMode` — they are the scalable interaction primitives.

## Zone aggregates — always emitted, at `bridgeTick`

`<zone>` is a zone name from `config/puara.yaml` (phones join a zone through
the QR URL param `?zone=…`; no param → `default`).
Only zones with at least one connected player are emitted.

| address | types | value |
|---|---|---|
| `/puara/audience/zone/<zone>/energy` | `f` | mean accel magnitude of the zone's players, m/s² (≈9.8 at rest — gravity included) |
| `/puara/audience/zone/<zone>/count` | `i` | connected players in the zone |
| `/puara/audience/zone/<zone>/taps` | `f` | taps/second, 2 s sliding window |

## Global aggregates — always emitted, at `bridgeTick`

| address | types | value |
|---|---|---|
| `/puara/audience/global/energy` | `f` | mean accel magnitude across all players, m/s² |
| `/puara/audience/global/taps` | `f` | taps/second across all players, 2 s window |
| `/puara/audience/global/touchcount` | `i` | players currently touching the screen |

## Axis conventions & caveats

- **accel**: W3C devicemotion device coordinate frame — x right, y up (toward
  top of screen), z out of the screen. Gravity included: a phone flat on a
  table reads ≈ `[0, 0, 9.8]`.
- **gyro**: deg/s. `alpha` = rotation around z, `beta` = around x, `gamma` =
  around y. iOS reports deg/s natively; `@ircam/devicemotion` normalizes
  Android to the same convention.
- **orientation**: `alpha` is **not** compass-calibrated across devices; treat
  it as relative. `beta`/`gamma` are usable absolute tilt.
- OSC **float types are forced** on the wire (a JS `0` would otherwise encode
  as int32) — receivers can rely on the typetags above verbatim.
- Raw stream rate per device is `min(sensorRate ceiling, what the browser
  delivers)`: iOS Safari delivers devicemotion at ~60 Hz, Android Chrome up to
  100+ Hz. The effective rate per client is visible in the controller
  dashboard.
