// Browser-only: loads a surface plugin (surfaces/*.js) at runtime and creates
// an instance of it. Shared by the player, which plays it, and the dashboard,
// which previews it.
//
// Surfaces are fetched from the server as plain ES modules, not bundled: an
// artist drops a file in surfaces/local/ and the phones pick it up without a
// rebuild. The price is that a surface cannot `import 'lit'` — the copy bundled
// here is lent to it through `create(ctx)` instead.

import { html, svg, nothing } from 'lit';

// The browser's own import(), out of the bundler's sight: soundworks-build's
// dynamic-import plugin reports any import() of a runtime URL as "invalid"
// on every build, though it leaves it working. The body is this constant
// string, never data.
const importModule = new Function('url', 'return import(url)');

const modules = new Map(); // absolute url -> Promise<definition>
const stylesheets = new Set(); // hrefs already linked

// `entry.url` is relative to the page ("surfaces/gamepad.js?v=..."), so a
// server mounted under a base path still resolves it.
function absolute(url) {
  return new URL(url, document.baseURI).href;
}

function linkStylesheet(definition, moduleUrl) {
  if (typeof definition.stylesheet !== 'string') {
    return;
  }
  const href = new URL(definition.stylesheet, moduleUrl);
  // the module's version, so an edited stylesheet is fetched again too
  href.search = new URL(moduleUrl).search;
  if (stylesheets.has(href.href)) {
    return;
  }
  stylesheets.add(href.href);
  const $link = document.createElement('link');
  $link.rel = 'stylesheet';
  $link.href = href.href;
  document.head.appendChild($link);
}

// catalog entry -> the module's default export. A failed import is not cached,
// so a fixed file loads on the next try.
export function loadSurfaceModule(entry) {
  const url = absolute(entry.url);
  let pending = modules.get(url);
  if (pending === undefined) {
    pending = importModule(url).then(module => {
      linkStylesheet(module.default, url);
      return module.default;
    });
    pending.catch(() => modules.delete(url));
    modules.set(url, pending);
  }
  return pending;
}

// `params` is a function returning the surface's current values.
export function createSurface(definition, params) {
  return definition.create({ html, svg, nothing, params });
}
