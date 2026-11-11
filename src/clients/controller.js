import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/browser.js';
import { html, nothing, render } from 'lit';
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
import { REGIONS_SURFACE, normalizeParams } from '../shared/surfaces.js';
import { createSurface, loadSurfaceModule } from '../shared/surface-host.js';
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
  ['streamSurface', 'surface'],
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

  // plugin surface previews, see previewOf(); up here because the QR codes
  // below render the page before the rest of main() has run
  const previews = new Map(); // url -> { loading } | { instance } | { error }

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

  // ## plugin surfaces (surfaces/*.js)
  function catalogEntry(id) {
    return global.get('surfaces').find(entry => entry.id === id) || null;
  }

  function paramsOf(entry) {
    return normalizeParams(entry, global.get('surfaceParams')[entry.id]);
  }

  // `surfaceParams` is one `any` object — every edit is a read-modify-write.
  function setSurfaceParam(entry, key, value) {
    const all = { ...global.get('surfaceParams') };
    all[entry.id] = { ...paramsOf(entry), [key]: value };
    global.set({ surfaceParams: all });
  }

  // The surface's own controls, built from its `params` declaration.
  function renderSurfaceParam(entry, key, spec) {
    const value = paramsOf(entry)[key];
    const set = next => setSurfaceParam(entry, key, next);
    switch (spec.type) {
      case 'enum':
        // sc-select hands back strings; map them onto the declared values
        return controlRow(spec.label, html`
          <sc-select
            .options="${Object.fromEntries(spec.list.map(item => [String(item), String(item)]))}"
            value="${String(value)}"
            @change="${e => set(spec.list.find(item => String(item) === e.detail.value))}"
          ></sc-select>`);
      case 'boolean':
        return controlRow(spec.label, html`
          <sc-toggle ?active="${value}" @change="${e => set(e.detail.value)}"></sc-toggle>`);
      case 'number':
        return controlRow(spec.label, html`
          <sc-number
            min="${spec.min ?? -Infinity}"
            max="${spec.max ?? Infinity}"
            step="${spec.step ?? 0.01}"
            value="${value}"
            @change="${e => set(e.detail.value)}"
          ></sc-number>`);
      case 'color':
        return controlRow(spec.label, html`
          <sc-color-picker value="${value}" @change="${e => set(e.detail.value)}"></sc-color-picker>`);
      default:
        return controlRow(spec.label, html`
          <sc-text editable value="${value}" @change="${e => set(e.detail.value)}"></sc-text>`);
    }
  }

  // The preview draws the surface with the same module the phones load, so what
  // the operator sees is what the audience gets. One instance per file version
  // (`previews`, declared with the QR codes: both are read by the first render).
  function previewOf(entry) {
    const cached = previews.get(entry.url);
    if (cached !== undefined) {
      return cached;
    }
    const pending = { loading: true };
    previews.set(entry.url, pending);
    loadSurfaceModule(entry)
      .then(definition => {
        previews.set(entry.url, { instance: createSurface(definition, () => paramsOf(entry)) });
      })
      .catch(err => {
        previews.set(entry.url, { error: err.message });
      })
      .finally(renderApp);
    return pending;
  }

  function renderPluginPreview(entry) {
    const preview = previewOf(entry);
    let drawing = nothing;
    if (preview.error) {
      drawing = html`<p class="surface-message error">${preview.error}</p>`;
    } else if (preview.instance) {
      try {
        const [width, height] = PREVIEW_SIZE;
        drawing = preview.instance.render({ width, height, params: paramsOf(entry), feedback: false });
      } catch (err) {
        drawing = html`<p class="surface-message error">${err.message}</p>`;
      }
    }
    return html`<div class="touch-preview">${drawing}</div>`;
  }

  // the addresses the surface adds, so the operator can wire a patch from here
  function renderOutputs(entry) {
    if (entry.outputs.length === 0) {
      return nothing;
    }
    return html`
      <p class="hint">
        ${entry.outputs.map(({ name, type, size }) => html`
          <code>/puara/audience/&lt;id&gt;/${entry.id}/${name}</code>
          ${type === 'button' ? 'i (0/1)' : 'f'.repeat(size)}<br>`)}
        audience: <code>/puara/audience/global/${entry.id}/…</code>
        (<code>…/count</code> per button, the mean per value)
      </p>`;
  }

  // Phone-shaped preview of the regions, using the same geometry helper the
  // players do.
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

  // ## panels
  // First on the page and as wide as it, because the phones send nothing until
  // it is on and it is the one control an operator forgets. The colour says
  // the state, the label says what a click will do.
  function renderRunning() {
    const running = global.get('running');
    return html`
      <section class="panel run-panel">
        <button
          class="run-button ${running ? 'running' : 'stopped'}"
          aria-pressed="${running ? 'true' : 'false'}"
          @click="${() => global.set({ running: !running })}"
        >
          <span class="run-state">${running ? 'RUNNING' : 'STOPPED'}</span>
          <span class="run-action">${running
            ? 'phones are sending — click to pause them all'
            : 'phones send nothing — click to start'}</span>
        </button>
      </section>`;
  }

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

  // The dropdown lists the built-in regions and every plugin on disk
  // (surfaces/, surfaces/local/), refreshed live when a file there changes.
  function surfaceOptions() {
    const options = { [`${REGIONS_SURFACE} (built in)`]: REGIONS_SURFACE };
    for (const entry of global.get('surfaces')) {
      const name = entry.label === entry.id ? entry.id : `${entry.label} — ${entry.id}`;
      options[entry.source === 'local' ? `${name} (local)` : name] = entry.id;
    }
    return options;
  }

  function renderRegionControls() {
    return html`
      <p class="hint">
        Regions are numbered left-to-right then top-to-bottom, and that index
        is what the bridge sends as <code>/puara/audience/&lt;id&gt;/region</code>
        (the <code>region</code> stream). Touch feedback (a ring under the
        finger, the pressed region dimmed) happens on the phones only; the
        preview shows the design, not the interaction.
      </p>
      ${selectRow('split', 'touchSplit', SPLITS)}
      ${textRow('text (blank = FR/EN default)', 'touchText')}
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
      ${renderTouchPreview()}`;
  }

  function renderPluginControls(entry) {
    return html`
      ${entry.description ? html`<p class="hint">${entry.description}</p>` : nothing}
      ${renderOutputs(entry)}
      ${Object.entries(entry.params).map(([key, spec]) => renderSurfaceParam(entry, key, spec))}
      ${toggleRow('touch feedback', 'touchFeedback')}
      ${renderPluginPreview(entry)}`;
  }

  function renderTouchPanel() {
    const surface = global.get('touchSurface');
    const entry = surface === REGIONS_SURFACE ? null : catalogEntry(surface);
    return html`
      <section class="panel touch-panel">
        <h2>Touch surface</h2>
        <p class="hint">
          Applies live to every connected phone. Whatever is drawn, the touch
          streams above keep flowing (<code>touch</code>, <code>tap</code>,
          brush/rub, <code>button</code>, and <code>region</code>, which
          follows the split last chosen for the regions). A plugin surface adds
          its own addresses under the <code>surface</code> stream. Surfaces are
          the files in <code>surfaces/</code> and <code>surfaces/local/</code>
          on the server — add one there and it appears in this list
          (<code>surfaces/README.md</code>).
        </p>
        ${controlRow('surface', html`
          <sc-select
            .options="${surfaceOptions()}"
            value="${surface}"
            @change="${e => global.set({ touchSurface: e.detail.value })}"
          ></sc-select>`)}
        ${entry === null ? renderRegionControls() : renderPluginControls(entry)}
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
        ${renderRunning()}
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
