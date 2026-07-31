// Loads the compiled puara-gestures addon. Node-only, so it stays out of
// src/shared/native-gestures.js, which the browser dashboard imports too.
//
// The addon is optional at runtime. A missing or unloadable build must not stop
// the server: an operator running only the audience system should not need a C++
// toolchain, and the bridge reports the reason instead of crashing.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// Resolved from this file rather than cwd: the bridge runs from `.build`, and
// the addon is built once at the repo root.
function addonPath() {
  const candidates = [
    path.resolve(here, '..', '..', 'native', 'build', 'Release', 'puara_gestures.node'),
    path.resolve(here, '..', '..', '..', 'native', 'build', 'Release', 'puara_gestures.node'),
  ];
  return candidates.find(existsSync) || candidates[0];
}

export function loadAddon() {
  const resolved = addonPath();

  if (!existsSync(resolved)) {
    return {
      Bank: null,
      reason: 'addon not built — run ./scripts/install.sh (or npm run build:native)',
    };
  }

  try {
    return { Bank: require(resolved).Bank, reason: null };
  } catch (err) {
    // Usually a .node built against another Node version, or a puara-gestures
    // checkout that moved after the build.
    return { Bank: null, reason: `addon failed to load: ${err.message}` };
  }
}
