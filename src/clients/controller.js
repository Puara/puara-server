import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/browser.js';
import { html, render } from 'lit';
import QRCode from 'qrcode';

import '@ircam/sc-components/sc-bang.js';
import '@ircam/sc-components/sc-button.js';
import '@ircam/sc-components/sc-number.js';
import '@ircam/sc-components/sc-select.js';
import '@ircam/sc-components/sc-slider.js';
import '@ircam/sc-components/sc-text.js';
import '@ircam/sc-components/sc-toggle.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api

const METER_REFRESH = 200; // ms — decimated, don't render at sensor rate
const RATE_WINDOW = 60; // s, join/leave rate window

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

  // per-zone QR codes, generated once from the page origin
  const origin = window.location.origin;
  const qrCodes = [];
  for (const zone of global.get('zones')) {
    const url = `${origin}/?zone=${zone}`;
    qrCodes.push({ zone, url, dataUrl: await QRCode.toDataURL(url, { margin: 1, width: 256 }) });
  }
  qrCodes.push({ zone: 'default', url: `${origin}/`, dataUrl: await QRCode.toDataURL(`${origin}/`, { margin: 1, width: 256 }) });

  function zoneCounts() {
    const counts = {};
    players.forEach(p => {
      const zone = p.get('zone');
      counts[zone] = (counts[zone] || 0) + 1;
    });
    return counts;
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
          <div class="control-row">
            <sc-text>panic (pause all)</sc-text>
            <sc-bang
              @input="${() => global.set({ running: false, interactionMode: 'events-only' })}"
            ></sc-bang>
          </div>
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
              return html`
                <div class="client-row">
                  <span class="client-id">#${p.get('id')} ${p.get('zone')}</span>
                  <span class="meter"><span class="meter-fill" style="width: ${level * 100}%"></span></span>
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

  global.onUpdate(() => renderApp());
  // decimated refresh for activity meters instead of per-update rendering
  setInterval(renderApp, METER_REFRESH);

  renderApp();
}

launcher.execute(main, {
  numClients: parseInt(new URLSearchParams(window.location.search).get('emulate') || '') || 1,
  width: '50%',
});
