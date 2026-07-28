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

const global = await server.stateManager.create('global', {
  sensorRate: puara.sensorRate,
  interactionMode: puara.interactionMode,
  emitRaw: puara.emitRaw,
  streamAccel: puara.streams.accel,
  streamGyro: puara.streams.gyro,
  streamOrientation: puara.streams.orientation,
  streamTouch: puara.streams.touch,
  zones: puara.zones,
});

const { useHttps, port } = server.config.env;
const protocol = useHttps ? 'https' : 'http';

console.log('Player URLs per zone (QR codes available in the controller dashboard):');
for (const zone of global.get('zones')) {
  console.log(`- ${zone}: ${protocol}://<server-ip>:${port}/?zone=${zone}`);
}
console.log(`- default: ${protocol}://<server-ip>:${port}/`);
console.log(`Controller dashboard: ${protocol}://<server-ip>:${port}/controller`);
