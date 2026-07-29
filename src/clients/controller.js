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
  gridGeometry,
  normalizeRegions,
  regionCount,
} from '../shared/touch-layout.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api

const METER_REFRESH = 200; // ms — decimated, don't render at sensor rate
const RATE_WINDOW = 60; // s, join/leave rate window

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

  let bridgeStatus = null;
  const bridgeCollection = await client.stateManager.getCollection('bridge-status');
  bridgeCollection.onAttach(state => {
    bridgeStatus = state; renderApp(); 
  });
  bridgeCollection.onDetach(() => {
    bridgeStatus = null; renderApp(); 
  });
  bridgeStatus = bridgeCollection.size > 0 ? bridgeCollection.map(s => s)[0] : null;

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
    logEvent(joinLog); renderApp(); 
  });
  players.onDetach(() => {
    logEvent(leaveLog); renderApp(); 
  });

  // Per-zone QR codes built from `publicAddress`, NOT window.location.origin —
  // the dashboard is often open on localhost, which no phone can reach.
  // Regenerated whenever the operator edits the address.
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

  function zoneCounts() {
    const counts = {};
    players.forEach(p => {
      const zone = p.get('zone');
      counts[zone] = (counts[zone] || 0) + 1;
    });
    return counts;
  }

  // ## touch surface design
  // Only the cells the current split actually shows. `touchRegions` always
  // holds MAX_REGIONS entries, so switching split back and forth keeps the
  // colours the operator picked.
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

  // Phone-shaped preview, using the same geometry helper the players do, so
  // what the operator sees here is what the audience gets.
  function renderTouchPreview() {
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

  function renderApp() {
    const counts = zoneCounts();
    const bridge = bridgeStatus ? bridgeStatus.getValues() : null;

    render(html`
      <div class="controller-layout">
        <header>
          <h1>${client.config.app.name} | ${client.role}</h1>
          <sw-audit .client="${client}"></sw-audit>
        </header>

        <section class="panel">
          <h2>Audience</h2>
          <p class="big-number">${players.size} connected</p>
          <p>join: ${joinLog.length}/min · leave: ${leaveLog.length}/min</p>
          <ul class="zone-counts">
            ${Object.entries(counts).map(([zone, n]) => html`<li>${zone}: ${n}</li>`)}
          </ul>
        </section>

        <section class="panel">
          <h2>Global controls</h2>
          <div class="control-row">
            <sc-text>public address (QR)</sc-text>
            <sc-text
              editable
              value="${global.get('publicAddress')}"
              @change="${e => global.set({ publicAddress: e.detail.value.trim() })}"
            ></sc-text>
          </div>
          <div class="control-row">
            <sc-text>running</sc-text>
            <sc-toggle
              ?active="${global.get('running')}"
              @change="${e => global.set({ running: e.detail.value })}"
            ></sc-toggle>
          </div>
          <div class="control-row">
            <sc-text>scene</sc-text>
            <sc-text
              editable
              value="${global.get('scene')}"
              @change="${e => global.set({ scene: e.detail.value })}"
            ></sc-text>
          </div>
          <div class="control-row">
            <sc-text>sensorRate (Hz)</sc-text>
            <sc-slider
              min="1"
              max="120"
              value="${global.get('sensorRate')}"
              number-box
              @change="${e => global.set({ sensorRate: Math.round(e.detail.value) })}"
            ></sc-slider>
          </div>
          <div class="control-row">
            <sc-text>interactionMode</sc-text>
            <sc-select
              .options="${['sensors', 'touch', 'events-only']}"
              value="${global.get('interactionMode')}"
              @change="${e => global.set({ interactionMode: e.detail.value })}"
            ></sc-select>
          </div>
          <div class="control-row">
            <sc-text>emitRaw</sc-text>
            <sc-toggle
              ?active="${global.get('emitRaw')}"
              @change="${e => global.set({ emitRaw: e.detail.value })}"
            ></sc-toggle>
          </div>
          ${[
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
          ].map(([key, label]) => html`
            <div class="control-row">
              <sc-text>stream: ${label}</sc-text>
              <sc-toggle
                ?active="${global.get(key)}"
                @change="${e => global.set({ [key]: e.detail.value })}"
              ></sc-toggle>
            </div>`)}
          <div class="control-row">
            <sc-text>panic (pause all)</sc-text>
            <sc-bang
              @input="${() => global.set({ running: false })}"
            ></sc-bang>
          </div>
        </section>

        <section class="panel touch-panel">
          <h2>Touch surface</h2>
          <p class="hint">
            Applies live to every connected phone. Regions are numbered
            left-to-right then top-to-bottom, and that index is what the bridge
            sends as <code>/puara/audience/&lt;id&gt;/region</code> — enable the
            <code>region</code> stream above to emit it.
          </p>
          <div class="control-row">
            <sc-text>split</sc-text>
            <sc-select
              .options="${SPLITS}"
              value="${global.get('touchSplit')}"
              @change="${e => global.set({ touchSplit: e.detail.value })}"
            ></sc-select>
          </div>
          <div class="control-row">
            <sc-text>text (blank = FR/EN default)</sc-text>
            <sc-text
              editable
              value="${global.get('touchText')}"
              @change="${e => global.set({ touchText: e.detail.value })}"
            ></sc-text>
          </div>
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
        </section>

        <section class="panel">
          <h2>Gesture settings</h2>
          <p class="hint">
            puara-gestures constants. Editing one rebuilds that detector on
            every phone, so its accumulated state resets.
          </p>
          ${GESTURE_SETTINGS.map(({ key, label, min, max, step }) => html`
            <div class="control-row">
              <sc-text>${label}</sc-text>
              <sc-number
                min="${min}"
                max="${max}"
                step="${step}"
                value="${global.get(key)}"
                @change="${e => global.set({ [key]: e.detail.value })}"
              ></sc-number>
            </div>`)}
        </section>

        <section class="panel">
          <h2>Bridge</h2>
          ${bridge && bridge.online
            ? html`
              <p>online · ${Math.round(bridge.oscRate)} msg/s</p>
              <p>last send: ${bridge.lastSend ? `${((Date.now() - bridge.lastSend) / 1000).toFixed(1)}s ago` : 'never'}</p>
              <p>destinations: ${bridge.destinations.map(d => `${d.host}:${d.port}`).join(', ')}</p>`
            : html`<p class="error">bridge offline</p>`
          }
        </section>

        <section class="panel clients-panel">
          <h2>Clients</h2>
          <div class="client-list">
            ${players.map(p => {
              const accel = p.get('accel');
              const level = Math.min(1, Math.hypot(...accel) / 30);
              const battery = p.get('battery');
              // shake energy is the gesture worth watching while tuning
              const shake = Math.hypot(...p.get('shake'));
              const button = p.get('button');
              const touches = p.get('touches').length;
              const region = p.get('region');
              return html`
                <div class="client-row">
                  <span class="client-id">#${p.get('id')} ${p.get('zone')}</span>
                  <span class="meter"><span class="meter-fill" style="width: ${level * 100}%"></span></span>
                  <span title="shake energy">${shake.toFixed(1)}</span>
                  <span title="active touches">${touches > 0 ? `${touches}✱` : '–'}</span>
                  <span title="touch region">${region >= 0 ? `r${region}` : '–'}</span>
                  <span title="button">${button && button.hold ? 'hold' : button && button.press ? 'press' : '–'}</span>
                  <span>${p.get('effectiveRate').toFixed(0)} Hz</span>
                  <span>${battery >= 0 ? `${Math.round(battery * 100)}%` : '–'}</span>
                </div>`;
            })}
          </div>
        </section>

        <section class="panel qr-panel">
          <h2>QR codes <sc-button @input="${() => window.print()}">print</sc-button></h2>
          <div class="qr-grid">
            ${qrCodes.map(({ zone, url, dataUrl }) => html`
              <figure class="qr-item">
                <img src="${dataUrl}" alt="QR ${zone}" />
                <figcaption>${zone}<br /><small>${url}</small></figcaption>
              </figure>`)}
          </div>
        </section>
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
  // decimated refresh for activity meters instead of per-update rendering
  setInterval(renderApp, METER_REFRESH);

  renderApp();
}

launcher.execute(main, {
  numClients: parseInt(new URLSearchParams(window.location.search).get('emulate') || '') || 1,
  width: '50%',
});
