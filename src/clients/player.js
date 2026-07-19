import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/browser.js';
import ClientPluginPlatformInit from '@soundworks/plugin-platform-init/client.js';
import ClientPluginCheckin from '@soundworks/plugin-checkin/client.js';
import devicemotion from '@ircam/devicemotion';
import { html, render, nothing } from 'lit';

import { tt } from '../shared/strings.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api

const SHAKE_THRESHOLD = 25; // m/s^2, accel magnitude (gravity included)
const SHAKE_DEBOUNCE = 400; // ms
const TAP_MAX_DURATION = 250; // ms

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
    gyro: [0, 0, 0],
    orientation: [0, 0, 0],
    dirty: false,
  };
  let lastShakeTime = 0;

  devicemotion.addEventListener(e => {
    const a = e.accelerationIncludingGravity;
    const r = e.rotationRate;
    frame.accel = [a.x || 0, a.y || 0, a.z || 0];
    frame.gyro = [r.alpha || 0, r.beta || 0, r.gamma || 0];
    frame.dirty = true;

    const magnitude = Math.hypot(...frame.accel);
    const now = performance.now();
    if (magnitude > SHAKE_THRESHOLD && now - lastShakeTime > SHAKE_DEBOUNCE) {
      lastShakeTime = now;
      player.set({ shake: magnitude - SHAKE_THRESHOLD });
    }
  });

  // iOS grants motion + orientation through the same permission prompt,
  // already triggered by platform-init inside the user gesture.
  window.addEventListener('deviceorientation', e => {
    frame.orientation = [e.alpha || 0, e.beta || 0, e.gamma || 0];
  });

  let sensorTimer = null;
  let sentCount = 0;

  function startSensorLoop() {
    clearInterval(sensorTimer);
    const rate = global.get('sensorRate');
    sensorTimer = setInterval(() => {
      if (global.get('interactionMode') !== 'sensors' || !frame.dirty) {
        return;
      }
      frame.dirty = false;
      sentCount += 1;
      player.set({
        accel: frame.accel,
        gyro: frame.gyro,
        orientation: frame.orientation,
      });
    }, 1000 / rate);
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

  // ## touch surface
  let touchStartTime = 0;

  function onPointerDown(e) {
    e.preventDefault();
    touchStartTime = performance.now();
    onPointerMove(e);
  }

  function onPointerMove(e) {
    if (e.buttons === 0 && e.pointerType === 'mouse') {
      return;
    }
    const x = Math.min(1, Math.max(0, e.clientX / window.innerWidth));
    const y = Math.min(1, Math.max(0, e.clientY / window.innerHeight));
    player.set({ touch: [x, y] });
  }

  function onPointerUp() {
    if (performance.now() - touchStartTime < TAP_MAX_DURATION) {
      player.set({ tap: true });
    }
    player.set({ touch: null });
  }

  // ## rendering
  function renderApp() {
    const running = global.get('running');
    const scene = global.get('scene');
    const mode = global.get('interactionMode');
    const touchEnabled = running && (mode === 'sensors' || mode === 'touch');

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
    renderApp();
  });

  renderApp();
}

// The launcher allows to launch multiple clients in the same browser window
// e.g. `http://127.0.0.1:8000?emulate=10` to run 10 clients side-by-side
launcher.execute(main, {
  numClients: parseInt(new URLSearchParams(window.location.search).get('emulate') || '') || 1,
});
