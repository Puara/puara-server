// Single source of truth for the OSC namespace — the contract lives in
// docs/NAMESPACE.md and must match this file exactly.

// 0.6.0 — touch surfaces are plugins (surfaces/*.js). Each one's outputs go out
// as `<id>/<surface>/<output>` per device and `global/<surface>/<output>` (mean
// of a value) or `global/<surface>/<output>/count` (phones pressing a button)
// for the audience, under `streams.surface` (was `streams.gamepad`). The
// gamepad is now one such plugin and its addresses are unchanged; the new
// shipped `xy-pad` and any local surface add their own.
// 0.5.0 — virtual gamepad: per-device `gamepad/<button>` and
// `gamepad/stick/<side>`, and the audience-scale `global/gamepad/...` counts and
// mean sticks, emitted while the touch surface is drawn as a gamepad. Additive;
// nothing that existed in 0.4.0 changed.
// 0.4.0 — under the `timestamps` toggle, every per-device message carries three
// trailing arguments: a per-address sequence number and a sample time split
// into whole seconds and microseconds within the second. Nothing is appended
// while the toggle is off, which is the default, so 0.4.0 is byte-identical to
// 0.3.1 for a show. See docs/NAMESPACE.md "Sample timestamps".
// 0.3.1 — `touch`/`touch/<n>`/`region` are normalized against the touch surface
// instead of the viewport; y was biased low by the height of the tab bar and
// horizontal seams sat half a tab bar below where the phone draws them.
// 0.3.0 — touch surface sub-areas: per-device `region` and per-region audience
// counts, driven by the layout authored on the dashboard.
// 0.2.0 — `shake` changed from an event float to a continuous 3-axis energy
// signal (puara-gestures semantics) and `jab` took over the old behaviour;
// jab/brush/rub/button and multi-touch addresses added.
export const NAMESPACE_VERSION = '0.6.0';

const ROOT = '/puara/audience';

// Values of the `timestamps` toggle. `device` — the phone stamping its own
// samples — is specified in puara-creator's docs/PUARA_SERVER.md §2.2 and is
// not implemented, because it needs clock synchronization between phone and
// server; it is deliberately absent from this list rather than offered and
// broken.
export const TIMESTAMP_LEVELS = ['off', 'bridge'];

// Inbound, not emitted: the one address the bridge listens on when `oscInput` is
// configured. `i i` — cue index, armed. Owned by puara-creator's cue engine
// (src/puara_creator/cue.py), so this string has to match that one.
export const CUE_ADDRESS = '/puara/cue';

export const meta = {
  version: () => `${ROOT}/meta/version`,
  connected: () => `${ROOT}/meta/connected`,
  zones: () => `${ROOT}/meta/zones`,
};

export const device = {
  accel: id => `${ROOT}/${id}/accel`,
  gyro: id => `${ROOT}/${id}/gyro`,
  orientation: id => `${ROOT}/${id}/orientation`,
  touch: id => `${ROOT}/${id}/touch`,
  // multi-touch: count, then one address per pointer index
  touchCount: id => `${ROOT}/${id}/touch/count`,
  touchPoint: (id, n) => `${ROOT}/${id}/touch/${n}`,
  tap: id => `${ROOT}/${id}/tap`,
  status: id => `${ROOT}/${id}/status`,
  // index of the touch-surface sub-area under the primary finger, -1 on release
  region: id => `${ROOT}/${id}/region`,
  // puara-gestures descriptors
  shake: id => `${ROOT}/${id}/shake`,
  jab: id => `${ROOT}/${id}/jab`,
  brush: id => `${ROOT}/${id}/brush`,
  rub: id => `${ROOT}/${id}/rub`,
  buttonCount: id => `${ROOT}/${id}/button/count`,
  buttonTap: id => `${ROOT}/${id}/button/tap`,
  buttonDtap: id => `${ROOT}/${id}/button/dtap`,
  buttonTtap: id => `${ROOT}/${id}/button/ttap`,
  buttonPress: id => `${ROOT}/${id}/button/press`,
  buttonHold: id => `${ROOT}/${id}/button/hold`,
  buttonPressTime: id => `${ROOT}/${id}/button/presstime`,
  // a plugin surface's output, e.g. ('7', 'gamepad', 'dpad/up') or
  // ('7', 'xy-pad', 'position') — names from the surface's `outputs`
  surfaceOutput: (id, surface, name) => `${ROOT}/${id}/${surface}/${name}`,
};

export const zone = {
  energy: name => `${ROOT}/zone/${name}/energy`,
  count: name => `${ROOT}/zone/${name}/count`,
  taps: name => `${ROOT}/zone/${name}/taps`,
};

export const global = {
  energy: () => `${ROOT}/global/energy`,
  taps: () => `${ROOT}/global/taps`,
  touchcount: () => `${ROOT}/global/touchcount`,
  // how many phones are currently touching region <n> — the audience-scale
  // answer the sub-areas exist for, emitted for every region of the current
  // split so a piece can read them as a fixed-size set
  regionCount: n => `${ROOT}/global/region/${n}/count`,
  // a plugin surface across the audience: how many phones hold a `button`
  // output, and the mean of a `value` output (a phone at rest counts as 0)
  surfaceCount: (surface, name) => `${ROOT}/global/${surface}/${name}/count`,
  surfaceMean: (surface, name) => `${ROOT}/global/${surface}/${name}`,
};
