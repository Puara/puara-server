import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

const DEFAULTS = {
  sensorRate: 100,
  bridgeTick: 30,
  emitRaw: true,
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
  },
  // '' → the server fills in its own LAN origin at startup
  publicAddress: '',
  maxTouches: 5,
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

// Node-side only (server and puara-bridge). Browsers receive these values
// through the `global` shared state.
export function loadPuaraConfig(root = process.cwd()) {
  const pathname = path.join(root, 'config', 'puara.yaml');

  if (!fs.existsSync(pathname)) {
    console.warn(`[puara] no config/puara.yaml found, using defaults`);
    return { ...DEFAULTS };
  }

  const parsed = YAML.parse(fs.readFileSync(pathname, 'utf-8')) || {};
  // `streams` and `gestures` are merged key by key: a partial block in the YAML
  // (e.g. only `gyro: false`) must not drop the siblings to undefined.
  return {
    ...DEFAULTS,
    ...parsed,
    streams: { ...DEFAULTS.streams, ...(parsed.streams || {}) },
    gestures: { ...DEFAULTS.gestures, ...(parsed.gestures || {}) },
  };
}
