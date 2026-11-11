import express from 'express';
import '@soundworks/helpers/polyfills.js';
import '@soundworks/helpers/catch-unhandled-errors.js';
import { Server } from '@soundworks/core/server.js';
import { loadConfig, configureHttpRouter } from '@soundworks/helpers/server.js';
import ServerPluginCheckin from '@soundworks/plugin-checkin/server.js';
import ServerPluginPlatformInit from '@soundworks/plugin-platform-init/server.js';

import {
  playerDescription,
  globalDescription,
  bridgeStatusDescription,
  nativeGesturesDescription,
} from './shared/schemas.js';
import { loadPuaraConfig } from './shared/load-puara-config.js';
import { lanAddress } from './shared/lan-address.js';
import { SURFACES_DIR, loadSurfaces, watchSurfaces } from './shared/load-surfaces.js';
import { REGIONS_SURFACE, normalizeParams } from './shared/surfaces.js';

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
// Surface plugins are fetched by the phones and the dashboard as plain ES
// modules (src/shared/surface-host.js). Revalidated on every load rather than
// cached, so an edited file reaches a phone on its next reload.
server.router.use('/surfaces', express.static(SURFACES_DIR, { maxAge: 0 }));

server.pluginManager.register('platform-init', ServerPluginPlatformInit);
server.pluginManager.register('checkin', ServerPluginCheckin, {
  capacity: puara.maxClients,
});

server.stateManager.defineClass('player', playerDescription);
server.stateManager.defineClass('global', globalDescription);
server.stateManager.defineClass('bridge-status', bridgeStatusDescription);
// gesture-tester branch: live readout of the C++ descriptors, owned by the bridge
server.stateManager.defineClass('native-gestures', nativeGesturesDescription);

await server.start();

const { useHttps, port, serverAddress } = server.config.env;
const protocol = useHttps ? 'https' : 'http';

// QR codes must point at an address a phone can reach, which is never the
// dashboard's own origin when the operator opens it on localhost. Prefer the
// configured public address, then a fixed serverAddress, then this machine's
// LAN address as the installers and the certificate see it — found again at
// every start, so a new network needs nothing but a restart.
const publicAddress = puara.publicAddress
  || `${protocol}://${serverAddress || lanAddress() || '127.0.0.1'}:${port}`;

// ## touch surfaces — the plugins on disk, and each one's settings
function warnParam(id, source) {
  return (key, value) => console.warn(
    `[puara] ${source} ${id}.${key}: ${JSON.stringify(value)} does not fit — using the default`,
  );
}

// `stored` is { [surfaceId]: { [param]: value } }: the YAML at boot, the live
// values on a rescan. Every surface in the catalog gets a full, valid set.
function paramsFor(catalog, stored, source) {
  return Object.fromEntries(catalog.map(entry => [
    entry.id,
    normalizeParams(entry, stored[entry.id], warnParam(entry.id, source)),
  ]));
}

function surfaceOrRegions(id, catalog) {
  if (id === REGIONS_SURFACE || catalog.some(entry => entry.id === id)) {
    return id;
  }
  console.warn(`[puara] touch surface "${id}" not found in surfaces/ — drawing the regions`);
  return REGIONS_SURFACE;
}

function reportSurfaces(catalog, problems) {
  for (const problem of problems) {
    console.warn(`[puara] surfaces: ${problem}`);
  }
  const names = catalog.map(entry => (entry.source === 'local' ? `${entry.id} (local)` : entry.id));
  console.log(`Touch surfaces: ${[`${REGIONS_SURFACE} (built in)`, ...names].join(', ')}`);
}

const surfaces = await loadSurfaces();
reportSurfaces(surfaces.catalog, surfaces.problems);

const global = await server.stateManager.create('global', {
  sensorRate: puara.sensorRate,
  interactionMode: puara.interactionMode,
  emitRaw: puara.emitRaw,
  timestamps: puara.timestamps,
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
  streamSurface: puara.streams.surface,
  publicAddress,
  maxTouches: puara.maxTouches,
  touchSplit: puara.touch.split,
  touchText: puara.touch.text,
  touchRegions: puara.touch.regions,
  touchFeedback: puara.touch.feedback,
  touchSurface: surfaceOrRegions(puara.touch.surface, surfaces.catalog),
  surfaces: surfaces.catalog,
  surfaceParams: paramsFor(surfaces.catalog, puara.touch.surfaces, 'touch.surfaces'),
  ...puara.gestures,
  nativeParams: puara.nativeGestures,
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

// An artist saves a file in surfaces/ or surfaces/local/: rescan, keep every
// setting that still fits, and the phones re-import the new version.
watchSurfaces(async () => {
  const { catalog, problems } = await loadSurfaces();
  reportSurfaces(catalog, problems);
  await global.set({
    surfaces: catalog,
    surfaceParams: paramsFor(catalog, global.get('surfaceParams'), 'live'),
    touchSurface: surfaceOrRegions(global.get('touchSurface'), catalog),
  });
});
