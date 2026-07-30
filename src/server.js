import { networkInterfaces } from 'node:os';

import '@soundworks/helpers/polyfills.js';
import '@soundworks/helpers/catch-unhandled-errors.js';
import { Server } from '@soundworks/core/server.js';
import { loadConfig, configureHttpRouter } from '@soundworks/helpers/server.js';
import ServerPluginCheckin from '@soundworks/plugin-checkin/server.js';
import ServerPluginPlatformInit from '@soundworks/plugin-platform-init/server.js';

import { playerDescription, globalDescription, bridgeStatusDescription } from './shared/schemas.js';
import { loadPuaraConfig } from './shared/load-puara-config.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api
// - Issue Tracker:         https://github.com/collective-soundworks/soundworks/issues
// - Wizard & Tools:        `npx soundworks`

const config = loadConfig(process.env.ENV, import.meta.url);
const puara = loadPuaraConfig();

console.log(`
--------------------------------------------------------
- launching "${config.app.name}" in "${process.env.ENV || 'default'}" environment
- [pid: ${process.pid}]
--------------------------------------------------------
`);

const server = new Server(config);
configureHttpRouter(server);

server.pluginManager.register('platform-init', ServerPluginPlatformInit);
server.pluginManager.register('checkin', ServerPluginCheckin, {
  capacity: puara.maxClients,
});

server.stateManager.defineClass('player', playerDescription);
server.stateManager.defineClass('global', globalDescription);
server.stateManager.defineClass('bridge-status', bridgeStatusDescription);

await server.start();

const { useHttps, port, serverAddress } = server.config.env;
const protocol = useHttps ? 'https' : 'http';

// The QR codes must point at an address a phone can reach, which is never the
// dashboard's own origin when the operator opens it on localhost. Prefer the
// configured public address (a hostname behind a real certificate), then the
// configured serverAddress, then the first non-internal IPv4 interface.
function detectLanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }
  return '127.0.0.1';
}

const publicAddress = puara.publicAddress
  || `${protocol}://${serverAddress || detectLanAddress()}:${port}`;

const global = await server.stateManager.create('global', {
  sensorRate: puara.sensorRate,
  interactionMode: puara.interactionMode,
  emitRaw: puara.emitRaw,
  streamAccel: puara.streams.accel,
  streamGyro: puara.streams.gyro,
  streamOrientation: puara.streams.orientation,
  streamTouch: puara.streams.touch,
  streamShake: puara.streams.shake,
  streamJab: puara.streams.jab,
  streamBrush: puara.streams.brush,
  streamRub: puara.streams.rub,
  streamButton: puara.streams.button,
  streamRegion: puara.streams.region,
  publicAddress,
  maxTouches: puara.maxTouches,
  touchSplit: puara.touch.split,
  touchText: puara.touch.text,
  touchRegions: puara.touch.regions,
  touchFeedback: puara.touch.feedback,
  ...puara.gestures,
  zones: puara.zones,
});

console.log(`Public address for QR codes: ${publicAddress}`);
console.log(`  ${puara.publicAddress ? 'from config/puara.yaml' : 'auto-detected — set publicAddress in config/puara.yaml to override'}`);
console.log('Player URLs per zone (QR codes available in the controller dashboard):');
for (const zone of global.get('zones')) {
  console.log(`- ${zone}: ${publicAddress}/?zone=${zone}`);
}
console.log(`- default: ${publicAddress}/`);
console.log(`Controller dashboard: ${publicAddress}/controller`);
