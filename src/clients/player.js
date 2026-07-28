import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/browser.js';
import ClientPluginPlatformInit from '@soundworks/plugin-platform-init/client.js';
import ClientPluginCheckin from '@soundworks/plugin-checkin/client.js';
import devicemotion from '@ircam/devicemotion';
import { html, render, nothing } from 'lit';

import { tt } from '../shared/strings.js';
import { createDetectors, GESTURE_PARAM_KEYS } from '../shared/gestures.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api

const TAP_MAX_DURATION = 250; // ms
// low-pass coefficient for the gravity estimate; ~0.5 s time constant at 60 Hz
const GRAVITY_ALPHA = 0.03;

async function main($container) {
  const config = loadConfig();
  const client = new Client(config);

  client.pluginManager.register('platform-init', ClientPluginPlatformInit, {
    devicemotion,
  });
  client.pluginManager.register('checkin', ClientPluginCheckin);

  launcher.register(client, {
    initScreensContainer: $container,
    reloadOnVisibilityChange: false,
  });

  await client.start();

  const checkin = await client.pluginManager.get('checkin');
  const zone = new URLSearchParams(window.location.search).get('zone') || 'default';

  const player = await client.stateManager.create('player', {
    id: checkin.getIndex(),
    zone,
    userAgent: navigator.userAgent,
  });

  const global = await client.stateManager.attach('global');

  // ## screen wake lock, re-acquired when the page becomes visible again
  let wakeLock = null;
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) {
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      console.warn('wakeLock denied:', err.message);
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wakeLock?.released !== false) {
      acquireWakeLock();
    }
  });
  acquireWakeLock();

  // ## sensors
  // devicemotion events land at whatever rate the browser delivers (iOS
  // Safari ~60 Hz); we buffer the latest frame and send at
  // min(global.sensorRate, delivery rate) — one batched state update per tick.
  const frame = {
    accel: [0, 0, 0],
    // accel with gravity subtracted — what the shake/jab detectors run on
    linear: [0, 0, 0],
    gyro: [0, 0, 0],
    orientation: [0, 0, 0],
    dirty: false,
  };
  // Running estimate of the gravity vector, so shake decays to 0 on a still
  // phone. `acceleration` (gravity-free) is unreliable across browsers, so
  // low-pass `accelerationIncludingGravity` and subtract instead.
  const gravity = [0, 0, 0];

  devicemotion.addEventListener(e => {
    const a = e.accelerationIncludingGravity;
    const r = e.rotationRate;
    frame.accel = [a.x || 0, a.y || 0, a.z || 0];
    frame.gyro = [r.alpha || 0, r.beta || 0, r.gamma || 0];

    for (let i = 0; i < 3; i++) {
      gravity[i] += (frame.accel[i] - gravity[i]) * GRAVITY_ALPHA;
      frame.linear[i] = frame.accel[i] - gravity[i];
    }

    frame.dirty = true;
  });

  // iOS grants motion + orientation through the same permission prompt,
  // already triggered by platform-init inside the user gesture.
  window.addEventListener('deviceorientation', e => {
    frame.orientation = [e.alpha || 0, e.beta || 0, e.gamma || 0];
  });

  // ## gesture descriptors
  function gestureParams() {
    const params = {};
    for (const key of GESTURE_PARAM_KEYS) {
      params[key] = global.get(key);
    }
    return params;
  }

  let detectors = createDetectors(gestureParams());
  // last position fed to brush/rub: after a release the detectors keep being
  // fed the same value, which is what makes them decay to 0 (10 still samples)
  let lastTouchPos = [0, 0];

  let sensorTimer = null;
  let sentCount = 0;
  // JSON of the last value sent per descriptor — these are `any` fields, so
  // soundworks cannot diff them for us and an idle phone would otherwise
  // re-send identical arrays at the full tick rate.
  const lastSent = {};

  function addIfChanged(payload, key, value) {
    const serialized = JSON.stringify(value);
    if (lastSent[key] === serialized) {
      return;
    }
    lastSent[key] = serialized;
    payload[key] = value;
  }

  function startSensorLoop() {
    clearInterval(sensorTimer);
    const rate = global.get('sensorRate');
    sensorTimer = setInterval(tick, 1000 / rate);
  }

  function tick() {
    // `running` gates everything so panic is a single reversible switch —
    // without it, pausing had to clobber interactionMode to stop the sensors.
    if (!global.get('running')) {
      return;
    }

    const now = performance.now();
    const mode = global.get('interactionMode');
    const payload = {};

    // Descriptors run in every interaction mode: they are the scalable
    // primitives, and `events-only` exists precisely to keep them without the
    // raw streams. They must also tick when nothing is happening, or a leaky
    // integrator never decays.
    const shake = detectors.shake.update(frame.linear, now);
    const jab = detectors.jab.update(frame.linear);

    const touches = activeTouches();
    const primary = touches.length > 0 ? touches[0] : null;
    if (primary !== null) {
      lastTouchPos = primary;
    }
    const { brush, rub } = detectors.touch.update(lastTouchPos, now);
    detectors.button.update(primary !== null, now);

    if (global.get('streamShake')) {
      const floor = global.get('shakeEmitThreshold');
      addIfChanged(payload, 'shake', shake.map(v => (v < floor ? 0 : v)));
    }
    if (global.get('streamJab')) {
      addIfChanged(payload, 'jab', jab);
    }
    if (global.get('streamBrush')) {
      addIfChanged(payload, 'brush', brush);
    }
    if (global.get('streamRub')) {
      addIfChanged(payload, 'rub', rub);
    }
    if (global.get('streamButton')) {
      addIfChanged(payload, 'button', detectors.button.getValues());
    }

    // ## raw streams — mode-gated, and only what is enabled. Still one batched
    // update per tick, so this saves bytes; lower `sensorRate` to save packets.
    if (global.get('streamTouch') && (mode === 'sensors' || mode === 'touch')) {
      addIfChanged(payload, 'touch', primary);
      addIfChanged(payload, 'touches', touches);
    }

    if (mode === 'sensors' && frame.dirty) {
      frame.dirty = false;
      if (global.get('streamAccel')) {
        payload.accel = frame.accel;
      }
      if (global.get('streamGyro')) {
        payload.gyro = frame.gyro;
      }
      if (global.get('streamOrientation')) {
        payload.orientation = frame.orientation;
      }
    }

    if (Object.keys(payload).length === 0) {
      return;
    }

    sentCount += 1;
    player.set(payload);
  }
  startSensorLoop();

  // report the effective send rate every 2 s for dashboard triage
  setInterval(() => {
    player.set({ effectiveRate: sentCount / 2 });
    sentCount = 0;
  }, 2000);

  // ## battery (unavailable on iOS Safari, stays at -1)
  if ('getBattery' in navigator) {
    const battery = await navigator.getBattery();
    const reportBattery = () => player.set({ battery: battery.level });
    battery.addEventListener('levelchange', reportBattery);
    reportBattery();
  }

  // ## touch surface — multi-touch through pointer events. The CSS sets
  // `touch-action: none`, so the browser hands us every finger instead of
  // turning the second one into a pinch-zoom.
  let touchStartTime = 0;
  const pointers = new Map(); // pointerId -> [x, y]

  // Positions are read by the tick, not pushed from the handlers: pointermove
  // fires faster than we want to hit the network, and the tick already batches.
  function activeTouches() {
    const max = global.get('maxTouches');
    return [...pointers.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, max)
      .map(([, position]) => position);
  }

  function pointerPosition(e) {
    return [
      Math.min(1, Math.max(0, e.clientX / window.innerWidth)),
      Math.min(1, Math.max(0, e.clientY / window.innerHeight)),
    ];
  }

  function onPointerDown(e) {
    e.preventDefault();
    if (pointers.size === 0) {
      touchStartTime = performance.now();
    }
    pointers.set(e.pointerId, pointerPosition(e));
  }

  function onPointerMove(e) {
    // no entry means this pointer is hovering, not pressed
    if (!pointers.has(e.pointerId)) {
      return;
    }
    pointers.set(e.pointerId, pointerPosition(e));
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    // tap stays an immediate event rather than waiting for the next tick
    if (pointers.size === 0 && performance.now() - touchStartTime < TAP_MAX_DURATION) {
      player.set({ tap: true });
    }
  }

  // ## rendering
  function renderApp() {
    const running = global.get('running');
    const scene = global.get('scene');
    // the surface is needed in every mode: tap is an event, emitted always
    const touchEnabled = running;

    let statusKey = 'waiting';
    if (running) {
      statusKey = 'active';
    }
    if (scene === 'end') {
      statusKey = 'over';
    }

    render(html`
      <div class="player-layout">
        <header>
          <span class="status-dot ${running ? 'running' : ''}"></span>
          <span>${tt('zone')}: ${zone} · #${player.get('id')}</span>
        </header>
        ${touchEnabled
          ? html`
            <div class="touch-surface"
              @pointerdown="${onPointerDown}"
              @pointermove="${onPointerMove}"
              @pointerup="${onPointerUp}"
              @pointercancel="${onPointerUp}"
            >
              <p>${tt('touchHint')}</p>
            </div>`
          : nothing
        }
        <main>
          <p class="status-message">${tt(statusKey)}</p>
        </main>
      </div>
    `, $container);
  }

  global.onUpdate(updates => {
    if ('sensorRate' in updates) {
      startSensorLoop();
    }
    // a gesture setting changed on the dashboard: rebuild the detectors with
    // the new constants (their state does not survive, by design)
    if (GESTURE_PARAM_KEYS.some(key => key in updates)) {
      detectors = createDetectors(gestureParams());
    }
    renderApp();
  });

  renderApp();
}

// The launcher allows to launch multiple clients in the same browser window
// e.g. `http://127.0.0.1:8000?emulate=10` to run 10 clients side-by-side
launcher.execute(main, {
  numClients: parseInt(new URLSearchParams(window.location.search).get('emulate') || '') || 1,
});
