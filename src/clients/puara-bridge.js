import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/node.js';
import { Client as OscClient } from 'node-osc';

import { loadPuaraConfig } from '../shared/load-puara-config.js';
import { NAMESPACE_VERSION, meta, device, zone, global as globalNs } from '../shared/namespace.js';
import { MAX_REGIONS, regionCount } from '../shared/touch-layout.js';
import { flatten, nativeAddress, NATIVE_ROOT } from '../shared/native-gestures.js';
import { loadAddon } from '../shared/native-addon.js';

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

  // Aggregates, meta and anything else that is not a per-device sample. These
  // are computed at the tick and have no sample time to report, so they are
  // never stamped — per-device messages go through enqueueDevice() below.
  function enqueue(address, ...args) {
    queue.push([address, ...args]);
  }

  // ## sample timestamps, under the `timestamps` toggle (namespace 0.4.0)
  //
  // Stamped here, at enqueue, and deliberately not in flush(): the queue is
  // drained by the bridgeTick timer, so a flush-time stamp would hand every
  // message in a tick the same time and quantise sample times onto a 33 ms
  // grid — which is the whole error this exists to remove.
  //
  // The clock is monotonic and its epoch is the bridge's own start, not the
  // wall clock: NTP can step the wall clock backwards mid-session, and a
  // recorder differencing these would read a negative interval as real.
  // Counters are never cleared, including when a phone leaves: they are keyed
  // by address, ids are reused, and a reconnecting phone whose counter restarts
  // would look to a recorder like a large reordering rather than an absence.
  // `/status 0` and `/status 1` already bracket the gap. Growth is bounded by
  // the id space, a few thousand entries at maxClients.
  const timeOrigin = process.hrtime.bigint();
  const SEQ_WRAP = 2 ** 31;
  const deviceSeq = new Map(); // per-device address -> next sequence number

  // The time is split across two 32-bit integers rather than sent as a 64-bit
  // `h`, because node-osc cannot encode one: lib/osc.mjs handles i f s b m N
  // only, and its `d` silently narrows to float32. Whole seconds plus
  // microseconds within the second is exact, and it does not wrap.
  function enqueueDevice(address, ...args) {
    if (globalState.get('timestamps') === 'off') {
      enqueue(address, ...args);
      return;
    }
    const seq = deviceSeq.get(address) ?? 0;
    deviceSeq.set(address, (seq + 1) % SEQ_WRAP);

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

    // each address is its own datagram, so a disabled stream removes messages
    // one-for-one here — the players already skip it, this also covers states
    // fed from elsewhere and updates in flight when a toggle flips.
    if (emitRaw) {
      if ('accel' in updates && globalState.get('streamAccel')) {
        enqueueDevice(device.accel(id), ...updates.accel.map(f));
      }
      if ('gyro' in updates && globalState.get('streamGyro')) {
        enqueueDevice(device.gyro(id), ...updates.gyro.map(f));
      }
      if ('orientation' in updates && globalState.get('streamOrientation')) {
        enqueueDevice(device.orientation(id), ...updates.orientation.map(f));
      }
      if ('touch' in updates && updates.touch !== null && globalState.get('streamTouch')) {
        enqueueDevice(device.touch(id), ...updates.touch.map(f));
      }
      // multi-touch: count always, then one address per pointer
      if ('touches' in updates && globalState.get('streamTouch')) {
        enqueueDevice(device.touchCount(id), i(updates.touches.length));
        updates.touches.forEach((point, n) => {
          enqueueDevice(device.touchPoint(id, n), ...point.map(f));
        });
      }
    }

    // ## gesture descriptors — emitted in every interaction mode, like events.
    // `emitRaw` does not gate these: they are already the cheap, scalable
    // representation raw streams get switched off in favour of.
    if ('shake' in updates && globalState.get('streamShake')) {
      enqueueDevice(device.shake(id), ...updates.shake.map(f));
    }
    if ('jab' in updates && globalState.get('streamJab')) {
      enqueueDevice(device.jab(id), ...updates.jab.map(f));
    }
    if ('brush' in updates && globalState.get('streamBrush')) {
      enqueueDevice(device.brush(id), ...updates.brush.map(f));
    }
    if ('rub' in updates && globalState.get('streamRub')) {
      enqueueDevice(device.rub(id), ...updates.rub.map(f));
    }
    if ('button' in updates && updates.button !== null && globalState.get('streamButton')) {
      const button = updates.button;
      // tap/dtap/ttap are high for a single tick — emit them as bangs rather
      // than streaming the zeros in between
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

    if ('region' in updates && globalState.get('streamRegion')) {
      enqueueDevice(device.region(id), i(updates.region));
    }

    // events always pass, whatever the mode — they are what scales
    if ('tap' in updates && updates.tap) {
      tapLog.push([Date.now(), player.get('zone')]);
      enqueueDevice(device.tap(id), i(1));
    }
    // shake is no longer an event: it is emitted as continuous 3-axis energy in
    // the descriptor block above.
  });

  players.onAttach(player => {
    enqueueDevice(device.status(player.get('id')), i(1));
    enqueue(meta.connected(), i(players.size));
  });
  players.onDetach(player => {
    enqueueDevice(device.status(player.get('id')), i(0));
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
    // Always MAX_REGIONS wide, not `regionCount(split)`: a piece binds to a
    // stable set of addresses, and the ones the current split retires have to
    // be driven to 0 rather than left unsent — see the emit below.
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
  // Snapshot for the dashboard, published at NATIVE_REPORT_RATE rather than the
  // tick: it is a readout for a human, not a signal path.
  const NATIVE_REPORT_RATE = 10; // Hz
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

  players.onDetach(player => {
    // the descriptors carry accumulated state; a rejoining phone starts clean
    const id = player.get('id');
    banks.delete(id);
    delete nativeSnapshot[id];
    for (const key of [...lastNative.keys()]) {
      if (key.startsWith(`${id}/`)) {
        lastNative.delete(key);
      }
    }
  });

  // Retuning a constant rebuilds nothing — the C++ objects take it live, which
  // is the whole reason the params are a single state object.
  globalState.onUpdate(updates => {
    if ('nativeParams' in updates) {
      for (const bank of banks.values()) {
        bank.setParams(updates.nativeParams);
      }
    }
  });

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
        const cacheKey = `${id}/${address}`;

        if (momentary) {
          // fires once per event; the zero frames in between say nothing
          if (values[0]) {
            enqueueDevice(nativeAddress(id, address), i(1));
          }
          continue;
        }

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

  setInterval(() => {
    nativeGestures.set({ values: nativeSnapshot });
    nativeSnapshot = {};
  }, 1000 / NATIVE_REPORT_RATE);

  const tickInterval = 1000 / puara.bridgeTick;
  setInterval(() => {
    computeAggregates();
    runNativeGestures();
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
  console.log(`  timestamps: ${globalState.get('timestamps')}`);

  // A toggle that changes the shape of every per-device message should say so
  // in the log the operator is already watching, not only on the dashboard.
  globalState.onUpdate(updates => {
    if ('timestamps' in updates) {
      console.log(`> timestamps: ${updates.timestamps}`);
    }
  });
}

// The launcher allows to launch multiple clients in the same terminal window
// e.g. `EMULATE=10 npm run watch puara-bridge` to run 10 clients side-by-side
launcher.execute(bootstrap, {
  numClients: process.env.EMULATE ? parseInt(process.env.EMULATE) : 1,
  moduleURL: import.meta.url,
});
