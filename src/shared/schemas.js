// SharedState class descriptions — cf. https://soundworks.dev/api
// Units and axis conventions are the OSC contract: see docs/NAMESPACE.md.

import { SPLITS, DEFAULT_REGIONS } from './touch-layout.js';

// One `player` state per connected phone, owned by the phone.
export const playerDescription = {
  id: {
    type: 'integer',
    default: -1,
  },
  // dome section, from the QR URL param (`?zone=...`)
  zone: {
    type: 'string',
    default: 'default',
  },
  // m/s^2, gravity included (devicemotion accelerationIncludingGravity)
  accel: {
    type: 'any',
    default: [0, 0, 0],
  },
  // deg/s (devicemotion rotationRate: alpha, beta, gamma)
  gyro: {
    type: 'any',
    default: [0, 0, 0],
  },
  // degrees, deviceorientation euler angles [alpha, beta, gamma]
  orientation: {
    type: 'any',
    default: [0, 0, 0],
  },
  // normalized [x, y] in 0-1 of the primary pointer, null when not touching
  touch: {
    type: 'any',
    default: null,
    nullable: true,
  },
  // every active pointer: [[x, y], ...] normalized 0-1, ordered by pointerId,
  // capped at `maxTouches`. Empty when nothing is touching.
  touches: {
    type: 'any',
    default: [],
  },
  tap: {
    type: 'boolean',
    event: true,
  },
  // ## puara-gestures descriptors, computed on the phone (src/shared/gestures.js)
  // Shake energy per axis: accumulates while shaking, decays to 0 when still.
  // Not an event — a continuous signal. Was an event-on-threshold value before
  // namespace 0.2.0; that behaviour is `jab`.
  shake: {
    type: 'any',
    default: [0, 0, 0],
  },
  // Signed acceleration span per axis over the rolling jab window. Latches on
  // the last detected jab until the next one exceeds the threshold.
  jab: {
    type: 'any',
    default: [0, 0, 0],
  },
  // Leaky integral of primary-pointer movement per screen axis, signed —
  // direction of travel. [x, y].
  brush: {
    type: 'any',
    default: [0, 0],
  },
  // Same on |movement|, so back-and-forth rubbing accumulates instead of
  // cancelling out. [x, y].
  rub: {
    type: 'any',
    default: [0, 0],
  },
  // { count, tap, dtap, ttap, press, hold, pressTime } from the touch surface
  // used as a button. tap/dtap/ttap are momentary — high for a single tick.
  button: {
    type: 'any',
    default: null,
    nullable: true,
  },
  // Index of the touch-surface sub-area the primary pointer is in, per the
  // layout authored on the dashboard (`touchSplit`/`touchRegions`). -1 when not
  // touching. Mirrors `touch`, but as one integer instead of coordinates, so a
  // piece can react to "which panel" without duplicating the region math.
  region: {
    type: 'integer',
    default: -1,
    min: -1,
    max: 3,
  },
  // 0-1, -1 when the Battery API is unavailable (iOS Safari)
  battery: {
    type: 'float',
    default: -1,
    min: -1,
    max: 1,
  },
  userAgent: {
    type: 'string',
    default: '',
  },
  // measured sensor updates/s actually sent, for dashboard triage
  effectiveRate: {
    type: 'float',
    default: 0,
  },
};

// Server-owned global state; defaults are overridden by config/puara.yaml
// at server startup, then driven live from the controller dashboard.
export const globalDescription = {
  running: {
    type: 'boolean',
    default: false,
  },
  scene: {
    type: 'string',
    default: 'idle',
  },
  // ceiling in Hz — phones send at min(sensorRate, what the browser delivers)
  sensorRate: {
    type: 'integer',
    default: 100,
    min: 1,
    max: 120,
  },
  interactionMode: {
    type: 'enum',
    list: ['sensors', 'touch', 'events-only'],
    default: 'sensors',
  },
  emitRaw: {
    type: 'boolean',
    default: true,
  },
  // Per-stream enable. Read by BOTH the player (skips the field in its state
  // update, so nothing crosses the WiFi) and the bridge (skips the OSC
  // message). Gating only one side leaves the other spamming — `emitRaw`
  // deliberately stays OSC-only, these are end-to-end.
  streamAccel: {
    type: 'boolean',
    default: true,
  },
  streamGyro: {
    type: 'boolean',
    default: true,
  },
  streamOrientation: {
    type: 'boolean',
    default: true,
  },
  streamTouch: {
    type: 'boolean',
    default: true,
  },
  streamShake: {
    type: 'boolean',
    default: true,
  },
  streamJab: {
    type: 'boolean',
    default: true,
  },
  streamBrush: {
    type: 'boolean',
    default: true,
  },
  streamRub: {
    type: 'boolean',
    default: true,
  },
  streamButton: {
    type: 'boolean',
    default: true,
  },
  streamRegion: {
    type: 'boolean',
    default: true,
  },
  // Origin the QR codes point at, e.g. 'https://connect.sat.qc.ca:8000'. The
  // server seeds it from config/puara.yaml, falling back to its own LAN
  // address — the dashboard's own URL is wrong for phones whenever the
  // operator opens it on localhost. Editable live from the dashboard.
  publicAddress: {
    type: 'string',
    default: '',
  },
  // ## gesture settings — see src/shared/gestures.js and config/puara.yaml.
  // Editing any of these rebuilds the detectors on every phone.
  // shake: activity threshold in m/s^2 (gravity removed) — below it the
  // integrator leaks instead of accumulating
  shakeThreshold: {
    type: 'float',
    default: 0.5,
    min: 0,
    max: 50,
  },
  // shake values below this are reported as 0 instead of streamed, so idle
  // phones do not emit sensor noise
  shakeEmitThreshold: {
    type: 'float',
    default: 0.05,
    min: 0,
    max: 50,
  },
  shakeFastLeak: {
    type: 'float',
    default: 0.6,
    min: 0,
    max: 1,
  },
  shakeSlowLeak: {
    type: 'float',
    default: 0.3,
    min: 0,
    max: 1,
  },
  // Hz — how often the leak is applied; between applications the integrator
  // accumulates without decay
  shakeFrequency: {
    type: 'integer',
    default: 10,
    min: 1,
    max: 200,
  },
  // jab: m/s^2 span within the window that counts as a jab
  jabThreshold: {
    type: 'float',
    default: 5,
    min: 0,
    max: 100,
  },
  jabWindow: {
    type: 'integer',
    default: 10,
    min: 2,
    max: 100,
  },
  brushLeak: {
    type: 'float',
    default: 0.7,
    min: 0,
    max: 1,
  },
  brushFrequency: {
    type: 'integer',
    default: 100,
    min: 1,
    max: 200,
  },
  brushScale: {
    type: 'float',
    default: 0.15,
    min: 0,
    max: 10,
  },
  // ms window in which repeated taps count as double/triple
  buttonCountInterval: {
    type: 'integer',
    default: 200,
    min: 50,
    max: 2000,
  },
  // ms a press must last to register as a hold
  buttonHoldInterval: {
    type: 'integer',
    default: 5000,
    min: 100,
    max: 20000,
  },
  // upper bound on simultaneous pointers reported per phone
  maxTouches: {
    type: 'integer',
    default: 5,
    min: 1,
    max: 10,
  },
  // ## touch surface design — authored on the dashboard, live on every phone.
  // See src/shared/touch-layout.js for the region ordering and geometry.
  // How the surface is divided into sub-areas.
  touchSplit: {
    type: 'enum',
    list: SPLITS,
    default: 'single',
  },
  // Headline shown across the surface. Empty falls back to the built-in
  // bilingual "Touchez l'écran / Touch the screen" — an operator who types
  // their own text is on their own for translation.
  touchText: {
    type: 'string',
    default: '',
  },
  // Always MAX_REGIONS entries of { label, color }; only the first
  // `regionCount(touchSplit)` are shown. The tail is retained so switching
  // splits back and forth does not lose the operator's colours.
  touchRegions: {
    type: 'any',
    default: DEFAULT_REGIONS,
  },
  // Whether a phone confirms a touch on screen (ring at the fingertip, pressed
  // region dimmed). On by default — an audience with no confirmation cannot
  // tell a working phone from a dead one — but an operator has to be able to
  // kill it for a cue that needs the seats fully dark.
  touchFeedback: {
    type: 'boolean',
    default: true,
  },
  zones: {
    type: 'any',
    default: ['default'],
  },
};

// Owned by the puara-bridge client; dashboard attaches for bridge health.
export const bridgeStatusDescription = {
  online: {
    type: 'boolean',
    default: false,
  },
  // OSC messages/s over the last second
  oscRate: {
    type: 'float',
    default: 0,
  },
  // epoch ms of the last OSC send, 0 if none yet
  lastSend: {
    type: 'float',
    default: 0,
  },
  destinations: {
    type: 'any',
    default: [],
  },
};
