import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/node.js';
import { Client as OscClient, Server as OscServer } from 'node-osc';

import { loadPuaraConfig } from '../shared/load-puara-config.js';
import {
  NAMESPACE_VERSION,
  CUE_ADDRESS,
  meta,
  device,
  zone,
  global as globalNs,
} from '../shared/namespace.js';
import { MAX_REGIONS, regionCount } from '../shared/touch-layout.js';
import { flatten, nativeAddress, NATIVE_ROOT } from '../shared/native-gestures.js';
import { loadAddon } from '../shared/native-addon.js';

// node-osc infers OSC types from JS values; whole floats would be encoded as
// int32, so the contract types (docs/NAMESPACE.md) are forced explicitly.
const f = value => ({ type: 'float', value });
const i = value => ({ type: 'integer', value });

const TAP_WINDOW = 2; // s, sliding window for tap rate descriptors
const NATIVE_REPORT_RATE = 10; // Hz, dashboard readout of the C++ descriptors
const SEQ_WRAP = 2 ** 31;

// Per-device vector fields that need nothing but a toggle and an address.
// `emitRaw` gates the raw sensors; the descriptors are the cheap representation
// raw streams get switched off in favour of, so they are never gated by it.
const RAW_STREAMS = [
  { key: 'accel', toggle: 'streamAccel', address: device.accel },
  { key: 'gyro', toggle: 'streamGyro', address: device.gyro },
  { key: 'orientation', toggle: 'streamOrientation', address: device.orientation },
  { key: 'touch', toggle: 'streamTouch', address: device.touch },
];

const DESCRIPTOR_STREAMS = [
  { key: 'shake', toggle: 'streamShake', address: device.shake },
  { key: 'jab', toggle: 'streamJab', address: device.jab },
  { key: 'brush', toggle: 'streamBrush', address: device.brush },
  { key: 'rub', toggle: 'streamRub', address: device.rub },
];

// Outbound OSC, decoupled from state callbacks through a queue flushed at
// bridgeTick so a slow socket never backpressures state handling.
//
// Per-device messages can carry a sequence number and a sample time, under the
// `timestamps` toggle (namespace 0.4.0). Stamped at enqueue rather than at
// flush: the queue drains on the tick timer, so a flush-time stamp would give
// every message in a tick the same time and quantise onto a 33 ms grid — the
// error this exists to remove. The clock is monotonic from the bridge's own
// start, because NTP can step the wall clock backwards mid-session and a
// recorder differencing these would read a negative interval as real.
function createOscQueue(destinations, timestampsEnabled) {
  const clients = destinations.map(({ host, port }) => {
    console.log(`> OSC destination: ${host}:${port}`);
    return new OscClient(host, port);
  });

  const timeOrigin = process.hrtime.bigint();
  // Never cleared, including when a phone leaves: keyed by address, and a
  // reconnecting phone whose counter restarted would look to a recorder like a
  // large reordering rather than an absence (`/status 0`/`1` already bracket the
  // gap). Bounded by the id space — a few thousand entries at maxClients.
  const sequence = new Map();

  let queue = [];
  let sentCount = 0;
  let lastSend = 0;

  // Aggregates, meta, anything computed at the tick: no sample time to report,
  // so never stamped.
  function enqueue(address, ...args) {
    queue.push([address, ...args]);
  }

  // The time is split across two 32-bit integers rather than sent as a 64-bit
  // `h`, because node-osc cannot encode one: lib/osc.mjs handles i f s b m N
  // only, and its `d` silently narrows to float32. Whole seconds plus
  // microseconds within the second is exact, and it does not wrap.
  function enqueueDevice(address, ...args) {
    if (!timestampsEnabled()) {
      enqueue(address, ...args);
      return;
    }
    const seq = sequence.get(address) ?? 0;
    sequence.set(address, (seq + 1) % SEQ_WRAP);

    const elapsed = (process.hrtime.bigint() - timeOrigin) / 1000n; // ns -> us
    enqueue(
      address,
      ...args,
      i(seq),
      i(Number(elapsed / 1000000n)),
      i(Number(elapsed % 1000000n)),
    );
  }

  function flush() {
    if (queue.length === 0) {
      return;
    }
    const batch = queue;
    queue = [];
    for (const message of batch) {
      for (const osc of clients) {
        osc.send(message, () => {});
      }
      sentCount += 1;
    }
    lastSend = Date.now();
  }

  // messages sent since the last call, for the dashboard's 1 Hz health readout
  function drainStats() {
    const stats = { oscRate: sentCount, lastSend };
    sentCount = 0;
    return stats;
  }

  return { enqueue, enqueueDevice, flush, drainStats };
}

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

  const { enqueue, enqueueDevice, flush, drainStats } = createOscQueue(
    puara.oscDestinations,
    () => globalState.get('timestamps') !== 'off',
  );

  // ## per-device: raw streams + events
  const tapLog = []; // [time, zone] pairs within TAP_WINDOW

  // Each address is its own datagram, so a disabled stream removes messages
  // one-for-one here. The players already skip it; this also covers states fed
  // from elsewhere and updates in flight when a toggle flips.
  function emitStreams(id, updates, streams) {
    for (const { key, toggle, address } of streams) {
      const value = updates[key];
      if (value == null || !globalState.get(toggle)) {
        continue;
      }
      enqueueDevice(address(id), ...value.map(f));
    }
  }

  function emitButton(id, button) {
    // tap/dtap/ttap are high for a single tick — emit them as bangs rather than
    // streaming the zeros in between
    if (button.tap) {
      enqueueDevice(device.buttonTap(id), i(1));
    }
    if (button.dtap) {
      enqueueDevice(device.buttonDtap(id), i(1));
    }
    if (button.ttap) {
      enqueueDevice(device.buttonTtap(id), i(1));
    }
    enqueueDevice(device.buttonCount(id), i(button.count));
    enqueueDevice(device.buttonPress(id), i(button.press ? 1 : 0));
    enqueueDevice(device.buttonHold(id), i(button.hold ? 1 : 0));
    enqueueDevice(device.buttonPressTime(id), f(button.pressTime));
  }

  players.onUpdate((player, updates) => {
    const id = player.get('id');

    if (globalState.get('emitRaw')) {
      emitStreams(id, updates, RAW_STREAMS);
      // multi-touch: count always, then one address per pointer
      if ('touches' in updates && globalState.get('streamTouch')) {
        enqueueDevice(device.touchCount(id), i(updates.touches.length));
        updates.touches.forEach((point, n) => {
          enqueueDevice(device.touchPoint(id, n), ...point.map(f));
        });
      }
    }

    emitStreams(id, updates, DESCRIPTOR_STREAMS);

    if (updates.button != null && globalState.get('streamButton')) {
      emitButton(id, updates.button);
    }
    if ('region' in updates && globalState.get('streamRegion')) {
      enqueueDevice(device.region(id), i(updates.region));
    }
    // events always pass, whatever the mode — they are what scales
    if (updates.tap) {
      tapLog.push([Date.now(), player.get('zone')]);
      enqueueDevice(device.tap(id), i(1));
    }
  });

  players.onAttach(player => {
    enqueueDevice(device.status(player.get('id')), i(1));
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
    const activeRegions = regionCount(globalState.get('touchSplit'));
    const regionCounts = new Array(MAX_REGIONS).fill(0);

    // energy is derived from accel; with that stream off the states keep their
    // last value, so report 0 rather than a frozen number the piece would read
    // as real motion.
    const hasAccel = globalState.get('streamAccel');

    players.forEach(player => {
      const zoneName = player.get('zone');
      const energy = hasAccel ? Math.hypot(...player.get('accel')) : 0;

      zones[zoneName] = zones[zoneName] || { count: 0, energy: 0, taps: 0 };
      zones[zoneName].count += 1;
      zones[zoneName].energy += energy;
      globalEnergy += energy;

      if (player.get('touch') !== null) {
        touchCount += 1;
      }

      // a stale index survives a split change until the phone next reports, so
      // ignore anything outside the current geometry
      const region = player.get('region');
      if (region >= 0 && region < activeRegions) {
        regionCounts[region] += 1;
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

    // Every region address, including the ones the current split does not use:
    // narrowing quad -> columns must push regions 2 and 3 to 0, or a patch bound
    // to them holds its last count forever and reads phantom fingers.
    if (globalState.get('streamRegion')) {
      regionCounts.forEach((count, n) => {
        enqueue(globalNs.regionCount(n), i(count));
      });
    }
  }

  // ## gesture-tester branch: the real C++ descriptors, in parallel
  // One Bank per phone, fed the raw frame at the bridge tick. The JS ports the
  // phones compute are untouched and still go out under `/puara/audience/...`;
  // these land under `/puara/gestures/...` from the same input, so `oscdump`
  // shows both implementations of a gesture side by side.
  const { Bank, reason } = loadAddon();
  const banks = new Map(); // player id -> Bank
  // Last value sent per address, so an idle phone does not re-send identical
  // numbers for ~60 addresses at every tick. Momentary flags bypass this.
  const lastNative = new Map();
  let nativeSnapshot = {};

  const nativeGestures = await client.stateManager.create('native-gestures', {
    available: Bank !== null,
    reason: reason || '',
  });

  if (Bank === null) {
    console.log(`> puara-gestures addon unavailable: ${reason}`);
    console.log('  the audience system runs as usual; no /puara/gestures output');
  } else {
    console.log(`> puara-gestures addon loaded — C++ descriptors on ${NATIVE_ROOT}/<id>/...`);
  }

  function bankFor(id) {
    let bank = banks.get(id);
    if (bank === undefined) {
      bank = new Bank(globalState.get('nativeParams'));
      banks.set(id, bank);
    }
    return bank;
  }

  function runNativeGestures() {
    if (Bank === null) {
      return;
    }

    players.forEach(player => {
      const id = player.get('id');
      const outputs = bankFor(id).update({
        accel: player.get('accel'),
        gyro: player.get('gyro'),
        touches: player.get('touches'),
      });

      nativeSnapshot[id] = outputs;

      for (const { address, values, type, momentary } of flatten(outputs)) {
        if (momentary) {
          // fires once per event; the zero frames in between say nothing
          if (values[0]) {
            enqueueDevice(nativeAddress(id, address), i(1));
          }
          continue;
        }

        const cacheKey = `${id}/${address}`;
        const serialized = values.join(',');
        if (lastNative.get(cacheKey) === serialized) {
          continue;
        }
        lastNative.set(cacheKey, serialized);

        const cast = type === 'integer' ? i : f;
        enqueueDevice(nativeAddress(id, address), ...values.map(cast));
      }
    });
  }

  players.onDetach(player => {
    const id = player.get('id');
    enqueueDevice(device.status(id), i(0));
    enqueue(meta.connected(), i(players.size));

    // the descriptors carry accumulated state; a rejoining phone starts clean
    banks.delete(id);
    delete nativeSnapshot[id];
    for (const key of [...lastNative.keys()]) {
      if (key.startsWith(`${id}/`)) {
        lastNative.delete(key);
      }
    }
  });

  globalState.onUpdate(updates => {
    // Retuning a constant rebuilds nothing — the C++ objects take it live, which
    // is the whole reason the params are a single state object.
    if ('nativeParams' in updates) {
      for (const bank of banks.values()) {
        bank.setParams(updates.nativeParams);
      }
    }
    // A toggle that changes the shape of every per-device message should say so
    // in the log the operator is already watching, not only on the dashboard.
    if ('timestamps' in updates) {
      console.log(`> timestamps: ${updates.timestamps}`);
    }
  });

  // ## inbound OSC — a recording tool driving the phones
  //
  // Only opened when `oscInput` is configured; a show has no reason to listen.
  // The one address is `/puara/cue i i` (cue index, armed), sent by
  // puara-creator when it is given `--cue-out`.
  //
  // This deliberately does not go through the outbound queue. The buzz is the
  // stimulus that reaction time is measured against, so a cue held for up to a
  // bridgeTick would add 0–33 ms of jitter to the one number the whole exercise
  // exists to measure. Setting the state is the fast path and is the whole job.
  if (puara.oscInput) {
    const { host, port } = puara.oscInput;
    const oscServer = new OscServer(port, host, () => {
      console.log(`> OSC input: ${host}:${port} — /puara/cue`);
    });

    oscServer.on('message', ([address, ...args]) => {
      if (address !== CUE_ADDRESS) {
        return;
      }
      // A cue with no arguments is a bare bang, which is a reasonable thing for
      // a patch to send; treat it as an armed cue rather than dropping it.
      const [index = 0, armed = 1] = args;
      globalState.set({ cue: { index: Number(index), armed: Number(armed) !== 0 } });
    });

    // The launcher restarts a client that loses the server; without this the old
    // socket keeps the port and the restarted bridge silently never hears a cue.
    client.onStatusChange(status => {
      if (status === 'stopped') {
        oscServer.close();
      }
    });
  }

  setInterval(() => {
    computeAggregates();
    runNativeGestures();
    flush();
  }, 1000 / puara.bridgeTick);

  // a readout for a human, not a signal path — slower than the tick
  setInterval(() => {
    nativeGestures.set({ values: nativeSnapshot });
    nativeSnapshot = {};
  }, 1000 / NATIVE_REPORT_RATE);

  setInterval(() => bridgeStatus.set(drainStats()), 1000);

  enqueue(meta.version(), NAMESPACE_VERSION);
  enqueue(meta.zones(), i(globalState.get('zones').length));
  enqueue(meta.connected(), i(players.size));

  console.log(`> puara-bridge online — namespace v${NAMESPACE_VERSION}, tick ${puara.bridgeTick} Hz`);
  console.log(`  timestamps: ${globalState.get('timestamps')}`);
}

// The launcher allows to launch multiple clients in the same terminal window
// e.g. `EMULATE=10 npm run watch puara-bridge` to run 10 clients side-by-side
launcher.execute(bootstrap, {
  numClients: process.env.EMULATE ? parseInt(process.env.EMULATE) : 1,
  moduleURL: import.meta.url,
});
