import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/browser.js';
import ClientPluginPlatformInit from '@soundworks/plugin-platform-init/client.js';
import ClientPluginCheckin from '@soundworks/plugin-checkin/client.js';
import devicemotion from '@ircam/devicemotion';
import { html, render, nothing } from 'lit';

import { tt } from '../shared/strings.js';
import { createDetectors, GESTURE_PARAM_KEYS } from '../shared/gestures.js';
import {
  gridGeometry,
  normalizeRegions,
  regionAt,
  regionCount,
} from '../shared/touch-layout.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api

const TAP_MAX_DURATION = 250; // ms
// low-pass coefficient for the gravity estimate; ~0.5 s time constant at 60 Hz
const GRAVITY_ALPHA = 0.03;
// Hz the data tab re-renders at. Deliberately far below `sensorRate`: the panel
// is for the audience to see itself in the stream, not a measurement tool, and
// re-rendering at 100 Hz on a phone costs more than the sensors do.
const DATA_REFRESH_RATE = 10;
// ms a released ring takes to fade out. Long enough to be seen on a phone held
// at arm's length, short enough that a fast tap sequence does not pile up rings.
const MARK_FADE_DURATION = 400;

// Rows of the data tab, in the order they are shown. `stream` names the global
// per-stream toggle, `modes` the interaction modes in which the field is sent
// at all (null = every mode). Both must match the gating in `tick()`, otherwise
// the panel claims to send something the phone is dropping.
const DATA_ROWS = [
  { key: 'accel', label: 'accel', unit: 'm/s²', stream: 'streamAccel', modes: ['sensors'] },
  { key: 'gyro', label: 'gyro', unit: '°/s', stream: 'streamGyro', modes: ['sensors'] },
  { key: 'orientation', label: 'orientation', unit: '°', stream: 'streamOrientation', modes: ['sensors'] },
  { key: 'touch', label: 'touch', unit: '0-1', stream: 'streamTouch', modes: ['sensors', 'touch'] },
  { key: 'touches', label: 'touches', unit: '0-1', stream: 'streamTouch', modes: ['sensors', 'touch'] },
  { key: 'shake', label: 'shake', unit: '', stream: 'streamShake', modes: null },
  { key: 'jab', label: 'jab', unit: '', stream: 'streamJab', modes: null },
  { key: 'brush', label: 'brush', unit: '', stream: 'streamBrush', modes: null },
  { key: 'rub', label: 'rub', unit: '', stream: 'streamRub', modes: null },
  { key: 'button', label: 'button', unit: '', stream: 'streamButton', modes: null },
  { key: 'region', label: 'region', unit: '', stream: 'streamRegion', modes: null },
];

function formatNumber(value) {
  return typeof value === 'number' ? value.toFixed(2) : String(value);
}

// Renders whatever a descriptor holds — scalar, [x, y, z], [[x, y], ...] or the
// button object — as one short monospace line.
function formatValue(value) {
  if (value === null || value === undefined) {
    return '—';
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '—';
    }
    if (Array.isArray(value[0])) {
      return value.map(inner => `[${inner.map(formatNumber).join(' ')}]`).join(' ');
    }
    return value.map(formatNumber).join('  ');
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entry]) => `${key}:${formatNumber(entry)}`)
      .join(' ');
  }
  return formatNumber(value);
}

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
    // Region rides with the descriptors, not with `touch`: it is the cheap
    // "which panel" signal a piece uses when raw coordinates are switched off.
    // Derived from `primary`, not `lastTouchPos`, so it returns to -1 on release
    // instead of latching on the last cell.
    if (global.get('streamRegion')) {
      addIfChanged(payload, 'region', regionAt(primary, global.get('touchSplit')));
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

    // Confirm the rings only here: reaching this line is the phone's own proof
    // that a touch produced something to send.
    if (pendingMarks.length > 0) {
      confirmMarks();
    }
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

  // Cached because `pointerPosition` reads it on every pointermove and a layout
  // read there is the one place this file can stall the frame. Keyed by element,
  // since the full-screen surface and the Data tab's pad are both valid targets
  // and each normalizes against its own box. Invalidated whenever the viewport
  // changes or a render (re)mounts the element.
  let cachedTarget = null;
  let cachedRect = null;

  function surfaceGeometry(target) {
    if (cachedRect === null || cachedTarget !== target) {
      cachedTarget = target;
      cachedRect = target.getBoundingClientRect();
    }
    return cachedRect;
  }

  function invalidateGeometry() {
    cachedTarget = null;
    cachedRect = null;
  }

  window.addEventListener('resize', invalidateGeometry);
  window.addEventListener('orientationchange', invalidateGeometry);
  // The Data tab scrolls, which moves the pad without resizing anything.
  window.addEventListener('scroll', invalidateGeometry, true);

  // Normalized against the element the pointer landed on, not the viewport. The
  // surface stops above the tab bar, so viewport-relative coordinates put the
  // seam of a `quad` half a tab bar away from where the audience sees it —
  // tolerable while nothing on screen reacted to a touch, wrong now that the
  // pressed region lights up and would disagree with the reported `region`.
  function pointerPosition(e) {
    const rect = surfaceGeometry(e.currentTarget);
    // A zero-area rect would divide to NaN and put NaN on the wire, which is
    // worse than a slightly wrong number in every downstream patch.
    if (rect.width === 0 || rect.height === 0) {
      return [0, 0];
    }
    return [
      Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    ];
  }

  function onPointerDown(e) {
    e.preventDefault();
    if (pointers.size === 0) {
      touchStartTime = performance.now();
    }
    pointers.set(e.pointerId, pointerPosition(e));
    addMark(e.pointerId, pointers.get(e.pointerId));
    refreshPressedRegion();
  }

  function onPointerMove(e) {
    // no entry means this pointer is hovering, not pressed
    if (!pointers.has(e.pointerId)) {
      return;
    }
    pointers.set(e.pointerId, pointerPosition(e));
    moveMark(e.pointerId, pointers.get(e.pointerId));
    refreshPressedRegion();
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    // tap stays an immediate event rather than waiting for the next tick
    if (pointers.size === 0 && performance.now() - touchStartTime < TAP_MAX_DURATION) {
      player.set({ tap: true });
      // `tap` is an event descriptor, so it has no readable current value —
      // count locally for the data tab
      tapCount += 1;
      // That write is a send like any other, and it beats the tick whenever
      // `sensorRate` is low — confirm here or a tap on a 2 Hz phone fades out
      // having never brightened.
      if (pendingMarks.length > 0) {
        confirmMarks();
      }
    }
    // after the tap, so a confirmed ring is what fades out
    releaseMark(e.pointerId);
    refreshPressedRegion();
  }

  // ## touch feedback
  // What the audience gets back for touching the glass. Two separate signals,
  // because they answer two different questions:
  //
  // - a ring under each finger, and the pressed region dimmed: *the phone saw
  //   you*. Immediate, from the pointer handler.
  // - the ring brightening: *that touch left the phone*. Driven from `tick()`
  //   after `player.set()`, so a phone whose streams are all switched off shows
  //   contact without ever claiming to transmit.
  //
  // Sized and coloured to subtract light rather than add it (hairline ring, the
  // region gets darker) because a few hundred of these screens are a light
  // source inside the dome. `touchFeedback` switches the whole thing off.
  const marks = new Map(); // pointerId -> ring element
  // rings still waiting for a send to confirm them; an array so `tick()` can
  // check for pending work with a length test instead of a DOM query
  const pendingMarks = [];

  function marksLayer() {
    return $container.querySelector('.touch-marks');
  }

  function positionMark($mark, [x, y]) {
    // left/top are the fingertip; the ring is pulled back onto it with negative
    // margins in CSS, which leaves `transform` free for the confirm animation
    $mark.style.left = `${x * 100}%`;
    $mark.style.top = `${y * 100}%`;
  }

  function addMark(pointerId, position) {
    const layer = global.get('touchFeedback') ? marksLayer() : null;
    if (layer === null) {
      return;
    }
    const $mark = document.createElement('div');
    $mark.className = 'touch-mark';
    positionMark($mark, position);
    layer.appendChild($mark);
    marks.set(pointerId, $mark);
    pendingMarks.push($mark);
  }

  function moveMark(pointerId, position) {
    const $mark = marks.get(pointerId);
    if ($mark !== undefined) {
      positionMark($mark, position);
    }
  }

  function releaseMark(pointerId) {
    const $mark = marks.get(pointerId);
    if ($mark === undefined) {
      return;
    }
    marks.delete(pointerId);
    $mark.classList.add('released');
    setTimeout(() => $mark.remove(), MARK_FADE_DURATION);
  }

  // Called from `tick()` once a payload has actually gone out.
  function confirmMarks() {
    for (const $mark of pendingMarks) {
      $mark.classList.add('sent');
    }
    pendingMarks.length = 0;
  }

  function clearMarks() {
    for (const $mark of marks.values()) {
      $mark.remove();
    }
    marks.clear();
    pendingMarks.length = 0;
  }

  // The pressed region goes through lit rather than the DOM: it changes on press
  // and on crossing a seam, not on every pointermove, so a render is affordable
  // here in a way it is not for the rings.
  let pressedRegion = -1;

  function refreshPressedRegion() {
    const touches = activeTouches();
    const next = regionAt(touches.length > 0 ? touches[0] : null, global.get('touchSplit'));
    if (next !== pressedRegion) {
      pressedRegion = next;
      renderApp();
    }
  }

  // ## rendering
  let activeTab = 'play';
  let tapCount = 0;
  let dataTimer = null;

  // The data panel is the only thing that needs to follow the stream, so it
  // drives its own repaint and nothing repaints while the Play tab is up.
  function startDataRefresh() {
    clearInterval(dataTimer);
    dataTimer = null;
    if (activeTab === 'data') {
      dataTimer = setInterval(renderApp, 1000 / DATA_REFRESH_RATE);
    }
  }

  function selectTab(tab) {
    if (activeTab === tab) {
      return;
    }
    activeTab = tab;
    startDataRefresh();
    renderApp();
  }

  // `region` is an integer, but a bare index means nothing to the person
  // holding the phone — show the label they can see on the surface too.
  function formatRegion(index) {
    if (index < 0) {
      return '—';
    }
    const label = normalizeRegions(global.get('touchRegions'))[index].label;
    return label ? `${index} · ${label}` : String(index);
  }

  function renderDataPanel() {
    const running = global.get('running');
    const mode = global.get('interactionMode');
    const battery = player.get('battery');

    return html`
      <section class="data-panel">
        <p class="data-hint">${tt('dataHint')}</p>
        ${running ? nothing : html`<p class="data-warning">${tt('dataPaused')}</p>`}
        <ul class="data-summary">
          <li>${tt('dataRate')}: ${player.get('effectiveRate').toFixed(0)}</li>
          <li>${tt('dataBattery')}: ${battery < 0 ? '—' : `${Math.round(battery * 100)}%`}</li>
          <li>mode: ${mode}</li>
          <li>tap: ${tapCount}</li>
        </ul>
        <ul class="data-rows">
          ${DATA_ROWS.map(row => {
            // "sending" mirrors tick(): the toggle, the mode gate and the panic
            // switch all have to be open for the field to leave the phone
            const sending = running
              && global.get(row.stream)
              && (row.modes === null || row.modes.includes(mode));

            return html`
              <li class="data-row ${sending ? '' : 'muted'}">
                <span class="data-label">${row.label}</span>
                <span class="data-value">
                  ${!sending
                    ? tt('dataOff')
                    : row.key === 'region'
                      ? formatRegion(player.get('region'))
                      : formatValue(player.get(row.key))
                  }
                </span>
                <span class="data-unit">${sending ? row.unit : ''}</span>
              </li>`;
          })}
        </ul>
        ${running
          // Only while the show is running: `tick()` is gated on it, so a pad
          // offered here while paused would register touches the phone never
          // sends. The `dataPaused` warning above already says so.
          ? html`
            <p class="data-note">${tt('dataTouchPad')}</p>
            ${renderDataTouchpad()}`
          : nothing
        }
      </section>`;
  }

  // The painted sub-areas, shared by the full-screen surface and the Data tab's
  // touchpad. One renderer on purpose: the pad exists to show what the surface
  // sends, which it can only do honestly if both lay their regions out
  // identically. `highlight` is the pressed-region dim, which the surface gates
  // on `touchFeedback` and the pad does not — the pad *is* an inspection view,
  // and a dim subtracts light from the dome rather than adding it.
  function renderRegionGrid(split, highlight) {
    const { cols, rows } = gridGeometry(split);
    const regions = normalizeRegions(global.get('touchRegions'))
      .slice(0, regionCount(split));

    return html`
      <div class="touch-regions"
        style="grid-template-columns: repeat(${cols}, 1fr);
               grid-template-rows: repeat(${rows}, 1fr);"
      >
        ${regions.map((region, index) => html`
          <div
            class="touch-region ${highlight && index === pressedRegion ? 'pressed' : ''}"
            style="background-color: ${region.color}"
          >
            ${region.label ? html`<span>${region.label}</span>` : nothing}
          </div>`)}
      </div>`;
  }

  // The surface the audience actually touches, as designed on the dashboard.
  // The sub-areas are painted by a grid *behind* the surface with
  // `pointer-events: none`, so the pointer handlers stay on the one parent
  // element and multi-touch tracking does not have to be split per cell.
  function renderTouchSurface() {
    const text = global.get('touchText').trim();

    return html`
      <div class="touch-surface"
        @pointerdown="${onPointerDown}"
        @pointermove="${onPointerMove}"
        @pointerup="${onPointerUp}"
        @pointercancel="${onPointerUp}"
      >
        ${renderRegionGrid(global.get('touchSplit'), global.get('touchFeedback'))}
        <div class="touch-marks"></div>
        <p class="touch-hint">${text || tt('touchHint')}</p>
      </div>`;
  }

  // A miniature of the surface at the foot of the Data tab, so the values above
  // can be watched while something is actually touching. The same handlers, so
  // this sends for real — that is the point: what the rows show is what left the
  // phone, whichever surface produced it. Coordinates normalize to whichever
  // element the pointer landed on, so a corner of the pad reads as that corner
  // of the full surface and `region` agrees with the cell under the finger.
  function renderDataTouchpad() {
    return html`
      <div class="data-touchpad"
        @pointerdown="${onPointerDown}"
        @pointermove="${onPointerMove}"
        @pointerup="${onPointerUp}"
        @pointercancel="${onPointerUp}"
      >
        ${renderRegionGrid(global.get('touchSplit'), true)}
      </div>`;
  }

  // Which element is taking touches, so a swap can be noticed: changing tab or a
  // panic mid-touch removes the element without a pointerup, which would
  // otherwise leave the phone reporting a finger it can no longer see. Both tabs
  // accept touches now — the Play tab through the full surface, the Data tab
  // through its pad — so this tracks which one rather than whether.
  let lastTouchTarget = 'none';

  function renderApp() {
    const running = global.get('running');
    const scene = global.get('scene');
    // the surface is needed in every mode: tap is an event, emitted always
    const touchEnabled = running && activeTab === 'play';
    let touchTarget = 'none';
    if (running) {
      touchTarget = activeTab === 'play' ? 'surface' : 'pad';
    }

    if (touchTarget !== lastTouchTarget) {
      pointers.clear();
      clearMarks();
      pressedRegion = -1;
      // whatever the pointers were measured against is gone or replaced
      invalidateGeometry();
      lastTouchTarget = touchTarget;
    }

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
        ${touchEnabled ? renderTouchSurface() : nothing}
        <main class="tab-${activeTab}">
          ${activeTab === 'data'
            ? renderDataPanel()
            : touchEnabled
              // The surface covers this message completely, so rendering it puts
              // text nobody can read behind an opaque overlay — except for the
              // sliver a region seam exposes, which is how a stray glyph ended
              // up in the middle of the screen. The surface carries its own
              // headline (`touchHint`); this one is for when there is no surface.
              ? nothing
              : html`<p class="status-message">${tt(statusKey)}</p>`
          }
        </main>
        <nav class="tab-bar">
          <button
            class="${activeTab === 'play' ? 'active' : ''}"
            @click="${() => selectTab('play')}"
          >${tt('tabPlay')}</button>
          <button
            class="${activeTab === 'data' ? 'active' : ''}"
            @click="${() => selectTab('data')}"
          >${tt('tabData')}</button>
        </nav>
      </div>
    `, $container);
  }

  // ## haptic cue
  //
  // A cue forwarded from a recording tool (docs/NAMESPACE.md, "Inbound
  // control"). Delivering it at the instrument rather than on screen is the
  // point: a visual cue adds display and eye-to-hand latency to the error term
  // that already dominates the measurement it feeds.
  //
  // CUE_MS is short on purpose. The motor drives the accelerometer this phone is
  // streaming, so the buzz appears in the very signal being recorded, at the
  // instant the label is anchored to. A gesture follows a cue by 150–400 ms, so
  // a 40 ms artefact does not overlap it, but it is a large energy spike near
  // the start of the labelling window and a shorter one is a smaller lie.
  // iOS Safari implements no Vibration API at all, so an iPhone cannot receive a
  // haptic cue and the session has to fall back to an audible one for it. That is
  // a fact about the room, decided before anyone starts recording, so say it once
  // at startup rather than on every cue.
  const CUE_MS = 40;
  const canVibrate = typeof navigator.vibrate === 'function';
  if (!canVibrate) {
    console.warn('no Vibration API on this device — haptic cues will not be felt here');
  }

  function deliverCue() {
    if (canVibrate) {
      navigator.vibrate(CUE_MS);
    }
  }

  global.onUpdate(updates => {
    // First, and outside the render batching below: this is a stimulus whose
    // arrival time is the measurement.
    if ('cue' in updates && updates.cue !== null) {
      deliverCue();
    }
    if ('sensorRate' in updates) {
      startSensorLoop();
    }
    // a gesture setting changed on the dashboard: rebuild the detectors with
    // the new constants (their state does not survive, by design)
    if (GESTURE_PARAM_KEYS.some(key => key in updates)) {
      detectors = createDetectors(gestureParams());
    }
    // Switched off from the dashboard mid-touch: drop the rings on screen now
    // instead of leaving them frozen under a finger. Switching it back on takes
    // effect on the next touch, which is soon enough.
    if (updates.touchFeedback === false) {
      clearMarks();
    }
    // A narrower split can leave `pressedRegion` on a cell that no longer
    // exists, and the seams move under the fingers that are already down.
    if ('touchSplit' in updates) {
      refreshPressedRegion();
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
