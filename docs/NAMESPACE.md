# OSC Namespace — `/puara/audience` (v0.5.0)

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
| `/puara/audience/meta/version` | `s` | namespace version, e.g. `"0.5.0"` |
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
| `emitRaw: false` | yes, the raw addresses in this section | **no** — phones keep streaming |
| `streams.<name>: false` | yes, that address | yes, the field leaves the state update |

So `streams` is the one to reach for when the *network* is the constraint —
`emitRaw` only spares the OSC consumer. Both are live from the dashboard.
`emitRaw` does not touch the gesture descriptors below: they are already the
cheap representation you switch the raw streams off in favour of.

With `streams.accel: false` the per-device `accel` address goes silent and the
energy aggregates report `0` rather than the last value the states happen to
hold. `streams.touch: false` likewise leaves `global/touchcount` at `0`.

| address | types | units / range |
|---|---|---|
| `/puara/audience/<id>/accel` | `fff` | m/s², **gravity included** (`accelerationIncludingGravity`), device axes x/y/z |
| `/puara/audience/<id>/gyro` | `fff` | deg/s, devicemotion `rotationRate` order **alpha, beta, gamma** |
| `/puara/audience/<id>/orientation` | `fff` | degrees, deviceorientation euler **alpha (0–360), beta (−180–180), gamma (−90–90)** |
| `/puara/audience/<id>/touch` | `ff` | normalized x, y in 0–1, top-left origin, **primary pointer only**; `null` between touches is not sent |
| `/puara/audience/<id>/touch/count` | `i` | active pointers, 0–`maxTouches` |
| `/puara/audience/<id>/touch/<n>` | `ff` | pointer `n` (0-based, ordered by pointerId), normalized x, y |
| `/puara/audience/<id>/tap` | `i` | bang-style, always `1` |
| `/puara/audience/<id>/status` | `i` | `1` on connect, `0` on disconnect — **always emitted**, regardless of `emitRaw` |

Events (`tap`, `status`) are always emitted, in every `interactionMode` — they
are the scalable interaction primitives.

`touch` stays single-point for compatibility; `touch/count` plus `touch/<n>` is
the multi-touch view of the same frame. Both are gated by `streams.touch`.

Touch coordinates are normalized against the **touch surface**, which stops
above the player's tab bar, not against the whole viewport: `y = 1` is the
bottom of the area the audience can actually touch. `region` is derived from the
same coordinates, so a seam is where the phone draws it. (Before namespace
0.3.1 the divisor was the viewport height, which biased `y` low by the height of
the tab bar and moved every horizontal seam down by half of it.)

## Gesture descriptors — every `interactionMode`, not gated by `emitRaw`

Ports of [puara-gestures](https://github.com/Puara/puara-gestures), computed
**on the phone** ([`src/shared/gestures.js`](../src/shared/gestures.js)) so the
network carries descriptors rather than the raw motion behind them. Each is
gated by its own `streams.<name>` flag, and every constant is tunable live from
the dashboard's *Gesture settings* panel (see `gestures` in
[`config/puara.yaml`](../config/puara.yaml)).

| address | types | value |
|---|---|---|
| `/puara/audience/<id>/shake` | `fff` | shake energy per device axis: accumulates while moving, decays to exactly `0` when still |
| `/puara/audience/<id>/jab` | `fff` | signed acceleration span per axis inside the rolling window; **latches** on the last jab until the next one |
| `/puara/audience/<id>/brush` | `ff` | leaky integral of primary-pointer movement per screen axis, **signed** — direction of travel |
| `/puara/audience/<id>/rub` | `ff` | same on `\|movement\|`, so back-and-forth accumulates instead of cancelling |
| `/puara/audience/<id>/button/count` | `i` | taps counted in the current `buttonCountInterval` window |
| `/puara/audience/<id>/button/tap` | `i` | bang `1` — single tap confirmed |
| `/puara/audience/<id>/button/dtap` | `i` | bang `1` — double tap |
| `/puara/audience/<id>/button/ttap` | `i` | bang `1` — triple tap |
| `/puara/audience/<id>/button/press` | `i` | `1` while a finger is down, `0` on release |
| `/puara/audience/<id>/button/hold` | `i` | `1` once a press passes `buttonHoldInterval` |
| `/puara/audience/<id>/button/presstime` | `f` | ms the last press lasted |
| `/puara/audience/<id>/region` | `i` | index of the touch-surface sub-area under the **primary** pointer, `-1` on release |

Behaviour worth knowing before patching against these:

- **`shake` is not an event.** Before 0.2.0 `/shake` was a single float emitted
  on a threshold crossing — that is what `jab` measures now. If a patch listened
  to `/shake f`, move it to `/jab fff`.
- Shake runs on **gravity-free** acceleration: the player low-passes
  `accelerationIncludingGravity` and subtracts the estimate, because the
  browser's gravity-free `acceleration` is unreliable across devices. Values
  below `shakeEmitThreshold` are reported as `0`, so an idle phone emits nothing.
- **`jab` latches** by design, matching the C++: it holds the last detected span
  until another exceeds `jabThreshold`. It is a "what was the last hit" value,
  not a gate.
- `tap` (the surface event) and `button/tap` are different things: `tap` bangs on
  any short touch, `button/tap` bangs only after the multi-tap window closes and
  resolves to exactly one tap.
- `brush`/`rub` follow the **primary** pointer. Lifting the first of several
  fingers promotes the next one, which reads as a position jump; the
  `|delta| > 1` guard only catches jumps larger than the whole screen.
- A descriptor is only sent when its value changed, so idle phones cost nothing
  on the wire.

## Sample timestamps — `timestamps`, off by default

The bridge enqueues a message on every phone state update and flushes the queue
on a fixed timer at `bridgeTick`, 30 Hz by default. Every message in a tick
therefore leaves within microseconds of its neighbours, whenever the phone
actually sampled the sensor. A consumer that timestamps datagrams on arrival —
which is what a recorder does — sees samples quantised onto a 33 ms grid, and
with `sensorRate: 100` roughly three samples share a timestamp and their order
within the tick is the queue's rather than the phone's. Raising `bridgeTick`
narrows the grid without removing it, and multiplies the datagram rate that the
batching exists to hold down.

The fix is to carry the sample time in the message. The `timestamps` option in
[`config/puara.yaml`](../config/puara.yaml), live from the dashboard, takes two
values:

| value | meaning |
|---|---|
| `off` | nothing appended. Byte-identical to namespace 0.3.1 — what a show runs |
| `bridge` | the bridge stamps each message as it is queued, which removes the tick quantisation entirely |

Under `bridge`, **every per-device message** — the raw streams, the gesture
descriptors, `tap`, `status`, and the C++ descriptors under `/puara/gestures/…`
on the `gesture-tester` branch — gains three trailing arguments:

| argument | type | meaning |
|---|---|---|
| `seq` | `i` | per-address sample counter, monotonic, wrapping at 2³¹ |
| `t_s` | `i` | whole seconds since the bridge started |
| `t_us` | `i` | microseconds within that second, 0–999999 |

So `/puara/audience/3/accel fff` becomes `/puara/audience/3/accel fffiii`. The
sample time in microseconds is `t_s * 1000000 + t_us`.

Aggregates and meta are never stamped: they are computed at the tick and have
no sample time to report.

Three properties of this that are easy to assume wrong:

- **The time is split across two 32-bit integers rather than sent as one 64-bit
  `h`.** This is not a preference; `node-osc` cannot encode `h` — its encoder
  handles `i f s b m N` only, and its `d` narrows to 32-bit float without
  saying so. Two integers are exact and do not wrap for 68 years.
- **The epoch is the bridge's own start, not the Unix epoch.** The clock is
  `process.hrtime.bigint()`, which is monotonic. A wall clock can be stepped
  backwards by NTP mid-session, and a consumer differencing two samples across
  the step would read a negative interval as a real measurement.
- **`seq` does not reset when a phone reconnects.** Counters are keyed by
  address and ids are recycled, so a restarted counter would look like a large
  reordering rather than an absence. `status 0` and `status 1` bracket the gap.

What `bridge` does not recover is the phone-to-server path — browser event
scheduling, the state update, and Wi-Fi transit. Those stay in the measurement
as an unknown but common-mode term, the same for every sample from a given
phone under stable conditions, which is enough to compare descriptors against
each other and to measure onset jitter, but not to state an absolute end-to-end
latency. Recovering that needs the phone to stamp its own samples and a
synchronisation layer to convert its clock to the server's; that level is
specified as `device` in puara-creator's `docs/PUARA_SERVER.md` §2.2 and is
deliberately absent from the option list until it exists, rather than offered
and broken.

This option exists for gesture-design sessions recorded with
[puara-creator](https://github.com/Puara/puara-creator), which reads the
trailers through the `timestamp_split` field of its namespace schema. Leave it
`off` for anything else: a patch that reads a fixed argument count breaks under
it, which is the whole reason for the 0.4.0 minor bump.

## Inbound control — `oscInput`, off by default

Everything above is output. The bridge also *listens*, but only when `oscInput`
is set in [`config/puara.yaml`](../config/puara.yaml); absent, which is the
default, it opens no port at all. A show has no reason to accept inbound OSC,
and this exists for gesture-design sessions.

| address | types | meaning |
|---|---|---|
| `/puara/cue` | `ii` | cue index, armed (`0` during the count-in) — buzz every connected phone |

The address and its arguments are owned by puara-creator's cue engine, not by
this repository; they match `src/puara_creator/cue.py`. A cue with no arguments
is treated as an armed cue at index 0, so a bare bang from a patch works.

**Every connected phone is buzzed.** The recording tool names no device, and a
session with several performers is meant to cue them together — that is how one
afternoon yields the subject diversity a corpus needs.

**The cue bypasses the `bridgeTick` queue.** Outbound messages are batched;
this is not. The buzz is the stimulus that reaction time is measured against,
so holding it for up to a tick would put 0–33 ms of jitter into the one number
the exercise exists to measure.

**The count-in feels identical to an armed cue.** The count-in is there so the
performer entrains to the period, which is exactly what a cue that felt
different would undermine. `armed` is carried for the recording tool, not for
the phone.

Two things to know before planning a session around this:

- **iOS Safari implements no Vibration API.** An iPhone cannot be cued
  haptically at all, whatever this bridge sends. Plan an audible cue for iPhone
  performers, and do not mix modalities within a subject — the modality is part
  of the latency being measured.
- **The motor drives the accelerometer.** The phone is streaming the sensor the
  buzz shakes, so the cue appears in the recording, at the instant the label is
  anchored to. The buzz is kept to 40 ms and a gesture follows a cue by
  150–400 ms, so the artefact does not overlap the gesture, but it is a large
  energy spike near the start of the labelling window and anything searching
  that window for an onset has to be told to ignore it.

## Touch surface regions

The touch surface is designed on the dashboard ("Touch surface" panel) and
seeded from the `touch` block of [`config/puara.yaml`](../config/puara.yaml):
a split, a headline, and a label + colour per sub-area. Region math and
geometry live in
[`src/shared/touch-layout.js`](../src/shared/touch-layout.js).

| `split` | regions | numbering |
|---|---|---|
| `single` | 1 | `0` — whole screen |
| `columns` | 2 | `0` left, `1` right |
| `rows` | 2 | `0` top, `1` bottom |
| `quad` | 4 | `0` top-left, `1` top-right, `2` bottom-left, `3` bottom-right |

Always left-to-right, then top-to-bottom.

- `region` is a **descriptor**, not a raw stream: it is emitted in every
  `interactionMode` and is not gated by `emitRaw`. It has its own
  `streams.region` toggle, so a piece can consume "which panel" at audience
  scale with `touch` switched off entirely.
- The split is exactly at 0.5, and the boundary itself belongs to the **higher**
  index: `x < 0.5` is region `0` of a `columns` split, `x == 0.5` is region `1`.
  The 2 px visual seam between cells is cosmetic and does not shift the split.
- Changing the split on the dashboard does **not** re-emit `region` for phones
  that are not touching; a phone reports its new index on the next touch. The
  `global/region/<n>/count` aggregate discards indices outside the current
  geometry, so a stale value never inflates a count.
- All four `global/region/<n>/count` addresses are emitted at every tick
  regardless of split, so narrowing `quad` → `columns` drives regions 2 and 3 to
  `0` instead of leaving a patch latched on their last count.
- `region` follows the **primary** pointer only, like `touch` and `brush`/`rub`.
  Multi-touch across several regions is visible in `touch/<n>`, not here.

## Virtual gamepad — `touch.surface: gamepad`, gated by `streams.gamepad`

Added in 0.5.0. The touch surface can be drawn as a game controller instead of
the regions (dashboard *Touch surface* panel → `surface`). Layout and hit
testing: [`src/shared/gamepad.js`](../src/shared/gamepad.js).

Nothing above changes in gamepad mode: `touch`, `touch/<n>`, `tap`, `brush`,
`rub`, `button/*` and `region` are computed from the same pointers as with the
regions drawn — `region` keeps following `split` even though the split is not
on screen. The addresses below are **added** on top.

Like `region`, these are descriptors of the touch, not raw streams: emitted in
every `interactionMode`, not gated by `emitRaw`, and `streams.gamepad: false`
removes them from the phone uplink as well as from OSC.

| address | types | value |
|---|---|---|
| `/puara/audience/<id>/gamepad/<button>` | `i` | `1` on press, `0` on release — one message per change, never repeated while held |
| `/puara/audience/<id>/gamepad/stick/left` | `ff` | x, y in −1..1, **+y down** (W3C Gamepad API); sent when it changes |
| `/puara/audience/<id>/gamepad/stick/right` | `ff` | same |

`<button>` is positional, never the printed glyph, so a patch survives switching
`gamepadStyle`:

| `<button>` | PlayStation | Xbox | W3C index |
|---|---|---|---|
| `south` | ✕ | A | 0 |
| `east` | ○ | B | 1 |
| `west` | □ | X | 2 |
| `north` | △ | Y | 3 |
| `l1` / `r1` | L1 / R1 | LB / RB | 4 / 5 |
| `l2` / `r2` | L2 / R2 | LT / RT | 6 / 7 |
| `select` / `start` | Select / Start | View / Menu | 8 / 9 |
| `dpad/up` `dpad/down` `dpad/left` `dpad/right` | d-pad | d-pad | 12–15 |

The W3C index is the bit in the `gamepadButtons` mask the phone sends, matching
`navigator.getGamepads()[n].buttons[index]`. Stick clicks (10/11) and home (16)
have no touch control.

- **Buttons are sent from the touch handler, not the sensor tick**, so a press
  shorter than one tick still reaches OSC; at a low `sensorRate` it would
  otherwise be lost. Sticks ride the tick like `touch`.
- Triggers are digital: `l2`/`r2` are `0`/`1`, not an axis.
- A finger can slide across buttons without lifting. Between two face buttons
  both are pressed; between two d-pad arms both directions are (the diagonal).
- Sticks have a radial dead zone of 0.12, rescaled so the rim still reads 1, and
  three decimals of resolution. A stick is held by the finger that grabbed it
  until that finger lifts, wherever it travels.
- **Releases are guaranteed.** A phone that disconnects mid-press gets a `0` on
  every button it held and its sticks zeroed by the bridge, after its
  `/status 0`. Switching the surface back to `regions`, a tab change or a panic
  release on the phone — sent immediately, even while paused.

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
| `/puara/audience/global/region/<n>/count` | `i` | players currently touching region `<n>`, `<n>` = 0–3 **always** (regions the current split does not use report `0`), gated by `streams.region` |
| `/puara/audience/global/gamepad/<button>/count` | `i` | players currently holding `<button>`, every button at every tick — **only while the surface is `gamepad`** and `streams.gamepad` is on, plus one final round of `0`s when either stops |
| `/puara/audience/global/gamepad/stick/left` | `ff` | mean left stick across **all** connected players (a phone not touching it counts as centred) — same gating as above |
| `/puara/audience/global/gamepad/stick/right` | `ff` | same, right stick |

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
