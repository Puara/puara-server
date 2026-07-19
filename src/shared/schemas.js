// SharedState class descriptions — cf. https://soundworks.dev/api
// Units and axis conventions are the OSC contract: see docs/NAMESPACE.md.

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
  // normalized [x, y] in 0-1, null when not touching
  touch: {
    type: 'any',
    default: null,
    nullable: true,
  },
  tap: {
    type: 'boolean',
    event: true,
  },
  // intensity in m/s^2 above the shake threshold
  shake: {
    type: 'float',
    event: true,
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
