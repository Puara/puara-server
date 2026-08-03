# gesture-tester — puara-server as a test bench for puara-gestures

This branch turns puara-server into a live test platform for
[puara-gestures](https://github.com/Puara/puara-gestures). It is a **permanent
parallel branch**, not a candidate for `main`: it carries a native build step and
a dependency on a checkout of another repository, neither of which belongs in the
audience system a show runs on.

Which library code is under test is whatever branch your puara-gestures checkout
is on. To test unmerged work, build a branch from the PRs you want with
[`scripts/combine-gestures-prs.sh`](./COMBINE-GESTURES-PRS.md).

## What it does

Phones stream raw sensor and touch data, as they already do. The bridge feeds
that data into the **real C++ descriptors** through a Node addon and emits the
results under a namespace of its own:

```
[phones] --wss--> [server] --state--> [puara-bridge] --+-- /puara/audience/...  (JS ports, computed on the phone)
                                                       |
                                                       +-- /puara/gestures/...  (C++ library, computed in the bridge)
```

Both run at once, from the same input. `src/shared/gestures.js` — the JS ports —
is untouched, and the phones keep computing and sending them. So a single
`oscdump` shows the same gesture computed two ways, which is the point: the
comparison is the test.

```
/puara/audience/0/shake  fff  0.117 0.000 0.000     <- JS port, on the phone
/puara/gestures/0/shake  fff  0.121 0.000 0.000     <- C++ library, in the bridge
```

## Why the descriptors run in the bridge, not on the phone

On `main` they deliberately run on the phone: the network then carries gestures
instead of the motion behind them, which is what makes an audience of hundreds
affordable. That argument does not apply here.

Running the real library on a phone would mean compiling it to WebAssembly
(emscripten, a ~1 GB toolchain that is not on this machine). Running it in the
bridge needs only a C++ compiler, which is. And a test bench is a small-N
setting — `config/puara.yaml` already calls 100 Hz an "R&D/small-N default (≤ 5
devices)" — so the extra uplink traffic from raw streams is not a constraint.

The cost is honest and worth stating: **this is not the phone's arithmetic.** It
tests the library, not the library-on-a-phone. Timing comes from the bridge's
tick and the C++ monotonic clock, not from the browser's sensor callbacks, so a
descriptor whose behaviour depends on sample rate will behave differently here
than it would on a device. Compare shapes and values, not latency.

## Install and run

```sh
git clone --recursive https://github.com/Puara/puara-gestures ../puara-gestures

./scripts/install.sh     # builds the addon as one of its steps
./scripts/start.sh       # server + bridge, as usual
./scripts/start.sh --dump  # ...and an oscdump on the first OSC port
```

`install.sh` looks for puara-gestures **beside this repo**. Point it elsewhere
with `PUARA_GESTURES_PATH=/path/to/clone ./scripts/install.sh`.

To test unmerged library work instead of whatever `main` holds, assemble a branch
from the PRs you care about — this also clones the checkout if it is missing, so
it can replace the `git clone` above:

```sh
./scripts/combine-gestures-prs.sh --all --exclude 135 --build
./scripts/combine-gestures-prs.sh 118 121 134 --build   # or just these
```

See [COMBINE-GESTURES-PRS.md](./COMBINE-GESTURES-PRS.md).

The addon is optional. Without it — no checkout, no compiler, missing submodule —
every step above still works, the audience system behaves exactly as on `main`,
and the bridge says why at startup:

```
> puara-gestures addon unavailable: addon not built — run ./scripts/install.sh
  the audience system runs as usual; no /puara/gestures output
```

To rebuild after changing the library (a new branch, an edited header):

```sh
npm run build:native
```

Nothing else needs rebuilding — the addon compiles the headers directly from your
working copy, so `git switch` in puara-gestures plus `npm run build:native` is
the whole loop.

## Reading the output

Two places, same numbers:

- **the dashboard** — a *puara-gestures (C++)* panel lists every descriptor per
  connected phone, addressed exactly as the bridge emits it, so a value you see
  can be grepped straight out of `oscdump`;
- **OSC** — `/puara/gestures/<id>/<descriptor>[/<field>]`.

Addresses are derived from what the addon reports, not from a table: a descriptor
added to the C++ side appears in both places as soon as the addon returns it.
Nested outputs become path segments (`impact/intensity`), arrays become
multi-argument messages (`shake fff`), booleans become `i`.

Levels are sent **on change**, so an idle phone does not restate ~53 addresses at
every tick. Momentary flags — `strike`, `onset`, `offset`, `landed`, `tap`,
`doubleTap`, `tripleTap` — are sent as a bang when they fire, because they are
true for exactly one `update()` and a 30 Hz tick can contain both the true and
its own false.

The 19 constants in *puara-gestures constants (C++)* apply live, per phone, with
no rebuild — the C++ objects take them through `setParams()`. They are seeded
from the `nativeGestures` block of `config/puara.yaml` and are **separate** from
the `gestures` block, which tunes the JS ports. Two implementations, two sets of
constants, on purpose.

## What is wired, and what is not

Chosen by what a phone browser can actually measure.

| descriptor | fed from | notes |
|---|---|---|
| `Shake3D`, `Jab3D` | gravity-free acceleration | the same signals the JS ports compute |
| `Envelope`, `Impact`, `Stillness`, `Segmenter`, `Derivative` | magnitude of gravity-free acceleration | one activity signal, five readings of it |
| `Freefall` | **total** acceleration magnitude | weightless is ~0, so gravity must stay in |
| `Spin3D` | gyroscope, per axis | `revolutions` and `turns` accumulate |
| `Tilt_Roll` | acceleration | the accel-only pair; `Tilt`/`Roll` proper need a magnetometer |
| `MultiTouch` | first two pointers | re-references on each new two-finger gesture |
| `Ribbon` | primary pointer x | the touch surface read as a 1D strip |
| `Button`, `Rhythm` | touch as a key | `Rhythm` counts `Button`'s taps, so tapping gives tempo |
| `BrushRubDetector` | primary pointer, per axis | two instances, x and y |

Not wired, and why:

- **`Heading`, `Tilt`, `Roll`** — need magnetometer data. Browsers do not expose
  a magnetometer through `devicemotion`/`deviceorientation`.
- **`Breath`** — needs a pressure sensor.
- **`TouchArrayGestureDetector`** — expects a capacitive strip's discrete
  channels, not a screen's coordinate pairs. Mapping one onto the other is a
  design decision, not a wiring detail; left out until it is made deliberately.

Gravity is estimated in the addon (a low-pass on
`accelerationIncludingGravity`, the same coefficient `src/clients/player.js`
uses) rather than on the phone, so the addon receives exactly what the browser
reported.

## Notes for the library

Found while wiring this up, in `combined-descriptors`. None of them block this
branch:

- **`descriptors/button.h:112`** — `value = value;` is a self-assignment. Judging
  by the surrounding code it was meant to store the reading, and as written the
  statement does nothing.
- **`descriptors/button.h`** — `count` is `unsigned int` (line 92) but is
  assigned `-1` when a hold ends, which wraps to `4294967295` rather than acting
  as the "reset to zero on the next increment" the arithmetic seems to expect.
  `-Wsign-compare` flags the comparison this feeds.
- **`descriptors/multitouch.h`** — `setAnchor()` is private while `anchor()` is
  public; calling `anchor()` *before* the first `update()` of a pair pins the
  reference to a zero distance, so `scale` stays `1.0` for the whole gesture. The
  working order is `reset()` then `update()`, which takes the reference itself.
  Worth a note in the class docs — the public method looks like the way to start
  a gesture.
- The quaternion filters emit a number of `-Wunused-variable` warnings
  (`madgwickQuaternion.h`, `mahonyQuaternion.h`).

## Files

| path | role |
|---|---|
| `scripts/combine-gestures-prs.sh` | builds a library branch from chosen PRs ([docs](./COMBINE-GESTURES-PRS.md)) |
| `native/binding.gyp` | addon build, C++20, includes from the puara-gestures checkout |
| `native/gestures-path.cjs` | resolves that checkout; CommonJS because gyp shells out to `node -p` |
| `native/src/puara_addon.cpp` | one `Bank` per phone: raw frame in, every descriptor out |
| `src/shared/native-gestures.js` | address derivation and the constants spec; browser-safe |
| `src/shared/native-addon.js` | loads the compiled addon; node-only |
| `src/clients/puara-bridge.js` | a bank per player, fed at the tick, emitted and published |
| `src/clients/controller.js` | the readout and the constants panel |
| `config/puara.yaml` | `nativeGestures:` seeds the constants |
