import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/node.js';
import { Client as OscClient } from 'node-osc';

import { loadPuaraConfig } from '../shared/load-puara-config.js';
import { NAMESPACE_VERSION, meta, device, zone, global as globalNs } from '../shared/namespace.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api

// node-osc infers OSC types from JS values; whole floats would be encoded as
// int32, so the contract types (docs/NAMESPACE.md) are forced explicitly.
const f = value => ({ type: 'float', value });
const i = value => ({ type: 'integer', value });

const TAP_WINDOW = 2; // s, sliding window for tap rate descriptors

async function bootstrap() {
  const config = loadConfig(process.env.ENV, import.meta.url);
  const client = new Client(config);

  launcher.register(client);

  await client.start();

  const puara = loadPuaraConfig();
  const globalState = await client.stateManager.attach('global');
  const players = await client.stateManager.getCollection('player');

  const bridgeStatus = await client.stateManager.create('bridge-status', {
    online: true,
    destinations: puara.oscDestinations,
  });

  const oscClients = puara.oscDestinations.map(({ host, port }) => {
    console.log(`> OSC destination: ${host}:${port}`);
    return new OscClient(host, port);
  });

  // OSC emission is decoupled from state callbacks through a queue flushed at
  // bridgeTick, so a slow socket never backpressures state handling.
  let queue = [];
  let sentCount = 0;
  let lastSend = 0;

  function enqueue(address, ...args) {
    queue.push([address, ...args]);
  }

  function flush() {
    if (queue.length === 0) {
      return;
    }
    const batch = queue;
    queue = [];
    for (const message of batch) {
      for (const osc of oscClients) {
        osc.send(message, () => {});
      }
      sentCount += 1;
    }
    lastSend = Date.now();
  }

  // ## per-device: raw streams + events
  const tapLog = []; // [time, zone] pairs within TAP_WINDOW

  players.onUpdate((player, updates) => {
    const id = player.get('id');
    const emitRaw = globalState.get('emitRaw');

    if (emitRaw) {
      if ('accel' in updates) {
        enqueue(device.accel(id), ...updates.accel.map(f));
      }
      if ('gyro' in updates) {
        enqueue(device.gyro(id), ...updates.gyro.map(f));
      }
      if ('orientation' in updates) {
        enqueue(device.orientation(id), ...updates.orientation.map(f));
      }
      if ('touch' in updates && updates.touch !== null) {
        enqueue(device.touch(id), ...updates.touch.map(f));
      }
    }

    // events always pass, whatever the mode — they are what scales
    if ('tap' in updates && updates.tap) {
      tapLog.push([Date.now(), player.get('zone')]);
      enqueue(device.tap(id), i(1));
    }
    if ('shake' in updates && updates.shake !== null) {
      enqueue(device.shake(id), f(updates.shake));
    }
  });

  players.onAttach(player => {
    enqueue(device.status(player.get('id')), i(1));
    enqueue(meta.connected(), i(players.size));
  });
  players.onDetach(player => {
    enqueue(device.status(player.get('id')), i(0));
    enqueue(meta.connected(), i(players.size));
  });

  // ## aggregates at a fixed tick — often what the piece actually consumes
  function computeAggregates() {
    const now = Date.now();
    while (tapLog.length && tapLog[0][0] < now - TAP_WINDOW * 1000) {
      tapLog.shift();
    }

    const zones = {};
    let globalEnergy = 0;
    let touchCount = 0;

    players.forEach(player => {
      const zoneName = player.get('zone');
      const energy = Math.hypot(...player.get('accel'));

      zones[zoneName] = zones[zoneName] || { count: 0, energy: 0, taps: 0 };
      zones[zoneName].count += 1;
      zones[zoneName].energy += energy;
      globalEnergy += energy;

      if (player.get('touch') !== null) {
        touchCount += 1;
      }
    });

    for (const [, zoneName] of tapLog) {
      if (zones[zoneName]) {
        zones[zoneName].taps += 1 / TAP_WINDOW;
      }
    }

    for (const [name, data] of Object.entries(zones)) {
      enqueue(zone.energy(name), f(data.count ? data.energy / data.count : 0));
      enqueue(zone.count(name), i(data.count));
      enqueue(zone.taps(name), f(data.taps));
    }

    enqueue(globalNs.energy(), f(players.size ? globalEnergy / players.size : 0));
    enqueue(globalNs.taps(), f(tapLog.length / TAP_WINDOW));
    enqueue(globalNs.touchcount(), i(touchCount));
  }

  const tickInterval = 1000 / puara.bridgeTick;
  setInterval(() => {
    computeAggregates();
    flush();
  }, tickInterval);

  // bridge health for the dashboard, 1 Hz
  setInterval(() => {
    bridgeStatus.set({ oscRate: sentCount, lastSend });
    sentCount = 0;
  }, 1000);

  enqueue(meta.version(), NAMESPACE_VERSION);
  enqueue(meta.zones(), i(globalState.get('zones').length));
  enqueue(meta.connected(), i(players.size));

  console.log(`> puara-bridge online — namespace v${NAMESPACE_VERSION}, tick ${puara.bridgeTick} Hz`);
}

// The launcher allows to launch multiple clients in the same terminal window
// e.g. `EMULATE=10 npm run watch puara-bridge` to run 10 clients side-by-side
launcher.execute(bootstrap, {
  numClients: process.env.EMULATE ? parseInt(process.env.EMULATE) : 1,
  moduleURL: import.meta.url,
});
