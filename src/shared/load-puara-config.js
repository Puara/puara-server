import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

const DEFAULTS = {
  sensorRate: 100,
  bridgeTick: 30,
  emitRaw: true,
  interactionMode: 'sensors',
  streams: { accel: true, gyro: true, orientation: true, touch: true },
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
  // `streams` is merged key by key: a partial block in the YAML (e.g. only
  // `gyro: false`) must not drop the other streams to undefined.
  return {
    ...DEFAULTS,
    ...parsed,
    streams: { ...DEFAULTS.streams, ...(parsed.streams || {}) },
  };
}
