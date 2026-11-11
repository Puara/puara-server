// Node-side only (server): finds the surface plugins on disk and turns them
// into the catalog the `global` state carries to the dashboard, the phones and
// the bridge. See src/shared/surfaces.js for the contract and surfaces/README.md
// for writing one.
//
// Two folders, both scanned for top-level *.js (subfolders are for a surface's
// own helpers, imported relatively):
//   surfaces/        ships with puara-server
//   surfaces/local/  the operator's and artists' own, ignored by git — a file
//                    here replaces a shipped one of the same name
//
// A surface module is imported here, in Node, to read its label, params and
// outputs: its top level must not touch the DOM (create() is only ever called
// in a browser). A file that fails to import or validate is left out with a
// warning; the others still load.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describeSurface } from './surfaces.js';

export const SURFACES_DIR = 'surfaces';
export const LOCAL_SURFACES_DIR = path.join(SURFACES_DIR, 'local');

function moduleFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => path.join(dir, entry.name))
    .sort();
}

// -> { catalog: [entry, ...], problems: [message, ...] }. `version` busts the
// module caches of both Node and the browsers, so an edited file is re-imported
// rather than served from memory.
export async function loadSurfaces(root = process.cwd(), version = Date.now()) {
  const byId = new Map();
  const problems = [];

  const sources = [
    ...moduleFiles(path.join(root, SURFACES_DIR)).map(file => ({ file, source: 'builtin' })),
    ...moduleFiles(path.join(root, LOCAL_SURFACES_DIR)).map(file => ({ file, source: 'local' })),
  ];

  for (const { file, source } of sources) {
    const id = path.basename(file, '.js');
    try {
      const module = await import(`${pathToFileURL(file).href}?v=${version}`);
      const entry = describeSurface(id, module.default);
      if (byId.has(id)) {
        problems.push(`${id}: surfaces/local/${id}.js replaces the shipped surfaces/${id}.js`);
      }
      // the URL phones import: relative to the page, so a server mounted under
      // a base path still resolves it, and always with `/`
      const relative = path.relative(path.join(root, SURFACES_DIR), file).split(path.sep).join('/');
      byId.set(id, { id, source, url: `surfaces/${relative}?v=${version}`, ...entry });
    } catch (err) {
      problems.push(`${path.relative(root, file)} left out: ${err.message}`);
    }
  }

  return { catalog: [...byId.values()], problems };
}

// Calls `onChange()` (debounced) whenever anything under surfaces/ changes, so
// an artist can save a file and see it on the phones without a restart.
export function watchSurfaces(onChange, root = process.cwd()) {
  const dir = path.join(root, SURFACES_DIR);
  if (!fs.existsSync(dir)) {
    return () => {};
  }
  let timer = null;
  const watcher = fs.watch(dir, { recursive: true }, () => {
    clearTimeout(timer);
    // editors write a file in several steps; wait for the last
    timer = setTimeout(onChange, 300);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
