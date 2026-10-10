import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/browser.js';
import { html, render } from 'lit';
import QRCode from 'qrcode';

import '@ircam/sc-components/sc-bang.js';
import '@ircam/sc-components/sc-button.js';
import '@ircam/sc-components/sc-color-picker.js';
import '@ircam/sc-components/sc-number.js';
import '@ircam/sc-components/sc-select.js';
import '@ircam/sc-components/sc-slider.js';
import '@ircam/sc-components/sc-text.js';
import '@ircam/sc-components/sc-toggle.js';

import { tt } from '../shared/strings.js';
import {
  SPLITS,
  SURFACES,
  gridGeometry,
  normalizeRegions,
  regionCount,
} from '../shared/touch-layout.js';
import { GAMEPAD_STYLES, gamepadLayout } from '../shared/gamepad.js';
import { renderGamepad } from '../shared/gamepad-view.js';
import { NATIVE_PARAMS, NATIVE_ROOT } from '../shared/native-gestures.js';
import { TIMESTAMP_LEVELS } from '../shared/namespace.js';

const METER_REFRESH = 200; // ms — decimated, don't render at sensor rate
const RATE_WINDOW = 60; // s, join/leave rate window

const INTERACTION_MODES = ['sensors', 'touch', 'events-only'];

const STREAM_TOGGLES = [
  ['streamAccel', 'accel'],
  ['streamGyro', 'gyro'],
  ['streamOrientation', 'orientation'],
  ['streamTouch', 'touch'],
  ['streamShake', 'shake'],
  ['streamJab', 'jab'],
  ['streamBrush', 'brush'],
  ['streamRub', 'rub'],
  ['streamButton', 'button'],
  ['streamRegion', 'region'],
  ['streamGamepad', 'gamepad'],
];

// inside of the phone-shaped preview: .touch-preview in app.scss, less its border
const PREVIEW_SIZE = [178, 318];

// Gesture settings panel. Ranges mirror the min/max in shared/schemas.js —
// soundworks rejects out-of-range writes, so keep the two in step.
const GESTURE_SETTINGS = [
  { key: 'shakeThreshold', label: 'shake: threshold (m/s²)', min: 0, max: 50, step: 0.1 },
  { key: 'shakeEmitThreshold', label: 'shake: emit floor', min: 0, max: 50, step: 0.01 },
  { key: 'shakeFastLeak', label: 'shake: fast leak', min: 0, max: 1, step: 0.05 },
  { key: 'shakeSlowLeak', label: 'shake: slow leak', min: 0, max: 1, step: 0.05 },
  { key: 'shakeFrequency', label: 'shake: leak rate (Hz)', min: 1, max: 200, step: 1 },
  { key: 'jabThreshold', label: 'jab: threshold (m/s²)', min: 0, max: 100, step: 0.5 },
  { key: 'jabWindow', label: 'jab: window (samples)', min: 2, max: 100, step: 1 },
  { key: 'brushLeak', label: 'brush/rub: leak', min: 0, max: 1, step: 0.05 },
  { key: 'brushFrequency', label: 'brush/rub: leak rate (Hz)', min: 1, max: 200, step: 1 },
  { key: 'brushScale', label: 'brush/rub: scale', min: 0, max: 10, step: 0.05 },
  { key: 'buttonCountInterval', label: 'button: count window (ms)', min: 50, max: 2000, step: 10 },
  { key: 'buttonHoldInterval', label: 'button: hold time (ms)', min: 100, max: 20000, step: 100 },
  { key: 'maxTouches', label: 'max simultaneous touches', min: 1, max: 10, step: 1 },
];

// `bridge-status` and `native-gestures` are owned by the bridge, which can come
// and go under a dashboard that stays open — so they are tracked through their
// collection rather than attached once.
async function attachSingleton(client, className, onChange) {
  const collection = await client.stateManager.getCollection(className);
  const holder = { state: collection.size > 0 ? collection.map(s => s)[0] : null };

  collection.onAttach(state => {
    holder.state = state;
    onChange();
  });
  collection.onDetach(() => {
    holder.state = null;
    onChange();
  });

  return holder;
}

// One row per leaf, addressed the way the bridge emits it, so a value read on
// the dashboard can be grepped straight out of `oscdump`.
function nativeRows(outputs, prefix = []) {
  const rows = [];
  for (const [key, value] of Object.entries(outputs)) {
    const trail = [...prefix, key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      rows.push(...nativeRows(value, trail));
    } else {
      rows.push({ address: trail.join('/'), value });
    }
  }
  return rows;
}

// Formats whatever the addon reported, without a table of expected keys — the
// set follows the library under test, and a missing entry here would quietly
// hide a new descriptor.
function formatNative(value) {
  if (Array.isArray(value)) {
    return value.map(v => (typeof v === 'number' ? v.toFixed(3) : String(v))).join('  ');
  }
  if (typeof value === 'number') {
    return value.toFixed(3);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : '—';
  }
  return String(value);
}

async function main($container) {
  const config = loadConfig();
  const client = new Client(config);

  launcher.register(client, {
    initScreensContainer: $container,
    reloadOnVisibilityChange: false,
  });

  await client.start();

  const global = await client.stateManager.attach('global');
  const players = await client.stateManager.getCollection('player');
  const bridge = await attachSingleton(client, 'bridge-status', () => renderApp());
  const native = await attachSingleton(client, 'native-gestures', () => renderApp());

  // join/leave events within the last RATE_WINDOW seconds
  const joinLog = [];
  const leaveLog = [];

  function logEvent(log) {
    const now = Date.now();
    log.push(now);
    while (log.length && log[0] < now - RATE_WINDOW * 1000) {
      log.shift();
    }
  }

  players.onAttach(() => {
    logEvent(joinLog);
    renderApp();
  });
  players.onDetach(() => {
    logEvent(leaveLog);
    renderApp();
  });

  // ## control rows
  const controlRow = (label, control) => html`
    <div class="control-row">
      <sc-text>${label}</sc-text>
      ${control}
    </div>`;

  const toggleRow = (label, key) => controlRow(label, html`
    <sc-toggle
      ?active="${global.get(key)}"
      @change="${e => global.set({ [key]: e.detail.value })}"
    ></sc-toggle>`);

  const textRow = (label, key, transform = value => value) => controlRow(label, html`
    <sc-text
      editable
      value="${global.get(key)}"
      @change="${e => global.set({ [key]: transform(e.detail.value) })}"
    ></sc-text>`);

  const selectRow = (label, key, options) => controlRow(label, html`
    <sc-select
      .options="${options}"
      value="${global.get(key)}"
      @change="${e => global.set({ [key]: e.detail.value })}"
    ></sc-select>`);

  // `write` rather than a state key: the C++ constants live inside one `any`
  // object, so setting one is a read-modify-write of the whole thing.
  const numberRows = (params, read, write) => params.map(({ key, label, min, max, step }) =>
    controlRow(label, html`
      <sc-number
        min="${min}"
        max="${max}"
        step="${step}"
        value="${read(key)}"
        @change="${e => write(key, e.detail.value)}"
      ></sc-number>`));

  // ## per-zone QR codes
  // Built from `publicAddress`, NOT window.location.origin — the dashboard is
  // often open on localhost, which no phone can reach. Rebuilt whenever the
  // operator edits the address.
  let qrCodes = [];

  async function buildQrCodes() {
    const base = (global.get('publicAddress') || window.location.origin).replace(/\/+$/, '');
    const targets = [
      ...global.get('zones').map(zone => ({ zone, url: `${base}/?zone=${zone}` })),
      { zone: 'default', url: `${base}/` },
    ];
    qrCodes = await Promise.all(targets.map(async ({ zone, url }) => ({
      zone,
      url,
      dataUrl: await QRCode.toDataURL(url, { margin: 1, width: 256 }),
    })));
    renderApp();
  }
  await buildQrCodes();

  // ## touch surface design
  // Only the cells the current split shows. `touchRegions` always holds
  // MAX_REGIONS entries, so switching split back and forth keeps the colours the
  // operator picked.
  function visibleRegions() {
    return normalizeRegions(global.get('touchRegions'))
      .slice(0, regionCount(global.get('touchSplit')));
  }

  // `touchRegions` is an `any` array, so soundworks cannot diff it for us —
  // every edit is a read-modify-write of the whole thing.
  function setRegion(index, patch) {
    const regions = normalizeRegions(global.get('touchRegions'));
    regions[index] = { ...regions[index], ...patch };
    global.set({ touchRegions: regions });
  }

  // Phone-shaped preview, using the same geometry helper the players do, so what
  // the operator sees here is what the audience gets.
  function renderTouchPreview() {
    if (global.get('touchSurface') === 'gamepad') {
      return html`
        <div class="touch-preview">
          ${renderGamepad(gamepadLayout(...PREVIEW_SIZE), global.get('gamepadStyle'), 0)}
        </div>`;
    }

    const { cols, rows } = gridGeometry(global.get('touchSplit'));
    const text = global.get('touchText').trim();

    return html`
      <div class="touch-preview">
        <div class="touch-preview-grid"
          style="grid-template-columns: repeat(${cols}, 1fr);
                 grid-template-rows: repeat(${rows}, 1fr);"
        >
          ${visibleRegions().map((region, index) => html`
            <div style="background-color: ${region.color}">
              <span>${region.label || `#${index}`}</span>
            </div>`)}
        </div>
        <p class="touch-preview-hint">${text || tt('touchHint')}</p>
      </div>`;
  }

  // ## panels
  function renderAudience() {
    const counts = {};
    players.forEach(p => {
      const zone = p.get('zone');
      counts[zone] = (counts[zone] || 0) + 1;
    });

    return html`
      <section class="panel">
        <h2>Audience</h2>
        <p class="big-number">${players.size} connected</p>
        <p>join: ${joinLog.length}/min · leave: ${leaveLog.length}/min</p>
        <ul class="zone-counts">
          ${Object.entries(counts).map(([zone, n]) => html`<li>${zone}: ${n}</li>`)}
        </ul>
      </section>`;
  }

  function renderGlobalControls() {
    return html`
      <section class="panel">
        <h2>Global controls</h2>
        ${textRow('public address (QR)', 'publicAddress', value => value.trim())}
        ${toggleRow('running', 'running')}
        ${textRow('scene', 'scene')}
        ${controlRow('sensorRate (Hz)', html`
          <sc-slider
            min="1"
            max="120"
            value="${global.get('sensorRate')}"
            number-box
            @change="${e => global.set({ sensorRate: Math.round(e.detail.value) })}"
          ></sc-slider>`)}
        ${selectRow('interactionMode', 'interactionMode', INTERACTION_MODES)}
        ${toggleRow('emitRaw', 'emitRaw')}
        ${selectRow('timestamps', 'timestamps', TIMESTAMP_LEVELS)}
        ${STREAM_TOGGLES.map(([key, label]) => toggleRow(`stream: ${label}`, key))}
        ${controlRow('panic (pause all)', html`
          <sc-bang @input="${() => global.set({ running: false })}"></sc-bang>`)}
      </section>`;
  }

  function renderTouchPanel() {
    return html`
      <section class="panel touch-panel">
        <h2>Touch surface</h2>
        <p class="hint">
          Applies live to every connected phone. Regions are numbered
          left-to-right then top-to-bottom, and that index is what the bridge
          sends as <code>/puara/audience/&lt;id&gt;/region</code> — enable the
          <code>region</code> stream above to emit it. Touch feedback (a ring
          under the finger, the pressed region dimmed) happens on the phones
          only; the preview below shows the design, not the interaction.
        </p>
        <p class="hint">
          <code>gamepad</code> draws a virtual controller instead of the regions.
          Every touch stream above keeps flowing unchanged (<code>region</code>
          still follows the split, though it is not drawn); the controller adds
          <code>/puara/audience/&lt;id&gt;/gamepad/…</code> on top, under the
          <code>gamepad</code> stream. The style is the look only — OSC names
          are positional, so a patch survives a switch.
        </p>
        ${selectRow('surface', 'touchSurface', SURFACES)}
        ${global.get('touchSurface') === 'gamepad'
          ? selectRow('gamepad style', 'gamepadStyle', GAMEPAD_STYLES)
          : ''}
        ${selectRow('split', 'touchSplit', SPLITS)}
        ${global.get('touchSurface') === 'gamepad'
          ? ''
          : textRow('text (blank = FR/EN default)', 'touchText')}
        ${toggleRow('touch feedback', 'touchFeedback')}
        ${visibleRegions().map((region, index) => html`
          <div class="control-row">
            <sc-text>region ${index}</sc-text>
            <sc-text
              editable
              value="${region.label}"
              @change="${e => setRegion(index, { label: e.detail.value })}"
            ></sc-text>
            <sc-color-picker
              value="${region.color}"
              @change="${e => setRegion(index, { color: e.detail.value })}"
            ></sc-color-picker>
          </div>`)}
        ${renderTouchPreview()}
      </section>`;
  }

  function renderGestureSettings() {
    return html`
      <section class="panel">
        <h2>Gesture settings</h2>
        <p class="hint">
          puara-gestures constants. Editing one rebuilds that detector on
          every phone, so its accumulated state resets.
        </p>
        ${numberRows(
          GESTURE_SETTINGS,
          key => global.get(key),
          (key, value) => global.set({ [key]: value }),
        )}
      </section>`;
  }

  function renderBridgePanel() {
    const status = bridge.state ? bridge.state.getValues() : null;

    if (status === null || !status.online) {
      return html`
        <section class="panel">
          <h2>Bridge</h2>
          <p class="error">bridge offline</p>
        </section>`;
    }

    const lastSend = status.lastSend
      ? `${((Date.now() - status.lastSend) / 1000).toFixed(1)}s ago`
      : 'never';

    return html`
      <section class="panel">
        <h2>Bridge</h2>
        <p>online · ${Math.round(status.oscRate)} msg/s</p>
        <p>last send: ${lastSend}</p>
        <p>destinations: ${status.destinations.map(d => `${d.host}:${d.port}`).join(', ')}</p>
      </section>`;
  }

  // gesture-tester branch: what the C++ descriptors are reporting, per phone.
  function renderNativeReadout() {
    const state = native.state ? native.state.getValues() : null;

    if (state === null) {
      return html`<p class="error">bridge offline — no descriptor readout</p>`;
    }
    if (!state.available) {
      return html`
        <p class="error">addon unavailable</p>
        <p class="hint">${state.reason}</p>`;
    }

    const entries = Object.entries(state.values);
    if (entries.length === 0) {
      return html`<p class="hint">no phones connected — join one to see the descriptors move</p>`;
    }

    return html`
      ${entries.map(([id, outputs]) => html`
        <div class="native-device">
          <h3>#${id} <span class="hint">${NATIVE_ROOT}/${id}/…</span></h3>
          <ul class="data-rows">
            ${nativeRows(outputs).map(row => html`
              <li class="data-row">
                <span class="data-label">${row.address}</span>
                <span class="data-value">${formatNative(row.value)}</span>
              </li>`)}
          </ul>
        </div>`)}`;
  }

  function renderNativePanels() {
    return html`
      <section class="panel native-panel">
        <h2>puara-gestures (C++)</h2>
        <p class="hint">
          The real library, running in the bridge on the raw streams from each
          phone, emitted under <code>${NATIVE_ROOT}/&lt;id&gt;/…</code>. The JS
          ports the phones compute still go out under
          <code>/puara/audience/…</code> — same gesture, both implementations,
          so they can be compared.
        </p>
        ${renderNativeReadout()}
      </section>

      <section class="panel">
        <h2>puara-gestures constants (C++)</h2>
        <p class="hint">
          Applied live to every phone's descriptor bank. These do not touch the
          JS ports in the <em>Gesture settings</em> panel above.
        </p>
        ${numberRows(
          NATIVE_PARAMS,
          key => global.get('nativeParams')[key],
          (key, value) => global.set({
            nativeParams: { ...global.get('nativeParams'), [key]: value },
          }),
        )}
      </section>`;
  }

  function renderClients() {
    return html`
      <section class="panel clients-panel">
        <h2>Clients</h2>
        <div class="client-list">
          ${players.map(p => {
            const level = Math.min(1, Math.hypot(...p.get('accel')) / 30);
            const battery = p.get('battery');
            // shake energy is the gesture worth watching while tuning
            const shake = Math.hypot(...p.get('shake'));
            const button = p.get('button');
            const touches = p.get('touches').length;
            const region = p.get('region');
            let buttonLabel = '–';
            if (button && button.hold) {
              buttonLabel = 'hold';
            } else if (button && button.press) {
              buttonLabel = 'press';
            }

            return html`
              <div class="client-row">
                <span class="client-id">#${p.get('id')} ${p.get('zone')}</span>
                <span class="meter"><span class="meter-fill" style="width: ${level * 100}%"></span></span>
                <span title="shake energy">${shake.toFixed(1)}</span>
                <span title="active touches">${touches > 0 ? `${touches}✱` : '–'}</span>
                <span title="touch region">${region >= 0 ? `r${region}` : '–'}</span>
                <span title="button">${buttonLabel}</span>
                <span>${p.get('effectiveRate').toFixed(0)} Hz</span>
                <span>${battery >= 0 ? `${Math.round(battery * 100)}%` : '–'}</span>
              </div>`;
          })}
        </div>
      </section>`;
  }

  function renderQrCodes() {
    return html`
      <section class="panel qr-panel">
        <h2>QR codes <sc-button @input="${() => window.print()}">print</sc-button></h2>
        <div class="qr-grid">
          ${qrCodes.map(({ zone, url, dataUrl }) => html`
            <figure class="qr-item">
              <img src="${dataUrl}" alt="QR ${zone}" />
              <figcaption>${zone}<br /><small>${url}</small></figcaption>
            </figure>`)}
        </div>
      </section>`;
  }

  function renderApp() {
    render(html`
      <div class="controller-layout">
        <header>
          <h1>${client.config.app.name} | ${client.role}</h1>
          <sw-audit .client="${client}"></sw-audit>
        </header>
        ${renderAudience()}
        ${renderGlobalControls()}
        ${renderTouchPanel()}
        ${renderGestureSettings()}
        ${renderBridgePanel()}
        ${renderNativePanels()}
        ${renderClients()}
        ${renderQrCodes()}
      </div>
    `, $container);
  }

  global.onUpdate(updates => {
    // the QR targets changed — rebuild them (buildQrCodes re-renders itself)
    if ('publicAddress' in updates || 'zones' in updates) {
      buildQrCodes();
      return;
    }
    renderApp();
  });

  // Decimated refresh for the activity meters and the descriptor readout, both
  // of which move faster than a dashboard needs to repaint.
  setInterval(renderApp, METER_REFRESH);

  renderApp();
}

launcher.execute(main, {
  numClients: parseInt(new URLSearchParams(window.location.search).get('emulate') || '') || 1,
  width: '50%',
});
