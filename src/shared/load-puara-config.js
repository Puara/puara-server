import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { DEFAULT_REGIONS, SURFACES, normalizeRegions } from './touch-layout.js';
import { GAMEPAD_STYLES } from './gamepad.js';
import { NATIVE_PARAM_DEFAULTS } from './native-gestures.js';
import { TIMESTAMP_LEVELS } from './namespace.js';

const DEFAULTS = {
  sensorRate: 100,
  bridgeTick: 30,
  emitRaw: true,
  // 'off' | 'bridge' — see src/shared/namespace.js and docs/NAMESPACE.md
  timestamps: 'off',
  // null = no inbound OSC listener, which is what a show wants. { host, port }
  // opens one; see docs/NAMESPACE.md "Inbound control".
  oscInput: null,
  interactionMode: 'sensors',
  streams: {
    accel: true,
    gyro: true,
    orientation: true,
    touch: true,
    shake: true,
    jab: true,
    brush: true,
    rub: true,
    button: true,
    region: true,
    gamepad: true,
  },
  // '' → the server fills in its own LAN origin at startup
  publicAddress: '',
  maxTouches: 5,
  // touch surface design; see src/shared/touch-layout.js
  touch: {
    split: 'single',
    // '' → the built-in bilingual hint
    text: '',
    regions: DEFAULT_REGIONS,
    // on-screen confirmation that a touch was registered and sent
    feedback: true,
    // 'regions' | 'gamepad' — what the surface draws
    surface: 'regions',
    // 'playstation' | 'xbox' — the gamepad's look
    gamepadStyle: 'playstation',
  },
  // gesture-tester branch: constants for the C++ descriptors the bridge runs
  nativeGestures: NATIVE_PARAM_DEFAULTS,
  // puara-gestures constants; see src/shared/gestures.js
  gestures: {
    shakeThreshold: 0.5,
    shakeEmitThreshold: 0.05,
    shakeFastLeak: 0.6,
    shakeSlowLeak: 0.3,
    shakeFrequency: 10,
    jabThreshold: 5,
    jabWindow: 10,
    brushLeak: 0.7,
    brushFrequency: 100,
    brushScale: 0.15,
    buttonCountInterval: 200,
    buttonHoldInterval: 5000,
  },
  zones: ['north', 'east', 'south', 'west'],
  maxClients: 350,
  oscDestinations: [{ host: '127.0.0.1', port: 9000 }],
};

// The `yaml` package parses on the YAML 1.2 core schema, where `off` is the
// string 'off' rather than the boolean false it would be under YAML 1.1. That
// is the behaviour this option is written for, but the difference is a one-line
// change away in a dependency and the failure would be silent — an unrecognized
// value must land on 'off' loudly rather than switch the namespace by accident.
function normalizeTimestamps(value) {
  if (value === undefined) {
    return DEFAULTS.timestamps;
  }
  if (value === false) {
    return 'off';
  }
  if (TIMESTAMP_LEVELS.includes(value)) {
    return value;
  }
  console.warn(
    `[puara] timestamps: ${JSON.stringify(value)} is not one of ` +
      `${TIMESTAMP_LEVELS.join(', ')} — falling back to 'off'`,
  );
  return 'off';
}

// An enum the state manager would reject outright at boot — a typo in the YAML
// must cost the operator a warning, not the server.
function oneOf(value, list, fallback, key) {
  if (list.includes(value)) {
    return value;
  }
  console.warn(
    `[puara] ${key}: ${JSON.stringify(value)} is not one of ${list.join(', ')} — ` +
      `falling back to '${fallback}'`,
  );
  return fallback;
}

// Opening a UDP port is not something to do by accident, so anything short of a
// usable port disables the listener rather than guessing one. A misspelt key
// leaves the bridge deaf, and a session would discover that only when the cue
// never arrived — hence the warning on a block that is present but unusable.
function normalizeOscInput(value) {
  if (value === undefined || value === null || value === false) {
    return null;
  }
  const port = Number(value.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.warn(
      `[puara] oscInput.port ${JSON.stringify(value.port)} is not a usable port — ` +
        'no inbound OSC listener will be opened',
    );
    return null;
  }
  return { host: value.host || '0.0.0.0', port };
}

// Node-side only (server and puara-bridge). Browsers receive these values
// through the `global` shared state.
export function loadPuaraConfig(root = process.cwd()) {
  const pathname = path.join(root, 'config', 'puara.yaml');

  if (!fs.existsSync(pathname)) {
    console.warn(`[puara] no config/puara.yaml found, using defaults`);
    return { ...DEFAULTS };
  }

  const parsed = YAML.parse(fs.readFileSync(pathname, 'utf-8')) || {};
  // `streams`, `gestures` and `touch` are merged key by key: a partial block in
  // the YAML (e.g. only `gyro: false`) must not drop the siblings to undefined.
  const touch = { ...DEFAULTS.touch, ...(parsed.touch || {}) };

  return {
    ...DEFAULTS,
    ...parsed,
    timestamps: normalizeTimestamps(parsed.timestamps),
    oscInput: normalizeOscInput(parsed.oscInput),
    streams: { ...DEFAULTS.streams, ...(parsed.streams || {}) },
    gestures: { ...DEFAULTS.gestures, ...(parsed.gestures || {}) },
    nativeGestures: { ...DEFAULTS.nativeGestures, ...(parsed.nativeGestures || {}) },
    // hand-written YAML is the one place a malformed colour can enter
    touch: {
      ...touch,
      regions: normalizeRegions(touch.regions),
      surface: oneOf(touch.surface, SURFACES, DEFAULTS.touch.surface, 'touch.surface'),
      gamepadStyle: oneOf(
        touch.gamepadStyle,
        GAMEPAD_STYLES,
        DEFAULTS.touch.gamepadStyle,
        'touch.gamepadStyle',
      ),
    },
  };
}
