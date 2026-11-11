// CI smoke test: run the platform's real start script (start.sh, or start.cmd
// on Windows), wait until the server listens and the bridge reports on the
// addon, fetch the player and dashboard pages, then stop the whole tree.
//
// REQUIRE_ADDON=1 fails the run when the bridge says the addon is unavailable.
// On macOS, start.sh runs under /bin/bash — the 3.2 every Mac ships — rather
// than whichever newer bash the runner put first on the PATH.

import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';

const TIMEOUT_MS = 120_000;
const requireAddon = process.env.REQUIRE_ADDON === '1';
const windows = process.platform === 'win32';

const child = windows
  ? spawn('cmd.exe', ['/d', '/c', 'scripts\\start.cmd'], { stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(process.platform === 'darwin' ? '/bin/bash' : 'bash', ['scripts/start.sh'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // its own process group, so the whole tree can be signalled at once
      detached: true,
    });

let output = '';
let origin = null;
let addon = null; // 'loaded' | 'unavailable'

function scan(chunk) {
  const text = chunk.toString();
  process.stdout.write(text);
  output += text;
  if (origin === null) {
    const match = output.match(/(https?):\/\/127\.0\.0\.1:(\d+)/);
    if (match) {
      origin = `${match[1]}://127.0.0.1:${match[2]}`;
    }
  }
  if (addon === null) {
    if (/puara-gestures addon loaded/.test(output)) {
      addon = 'loaded';
    } else if (/puara-gestures addon unavailable/.test(output)) {
      addon = 'unavailable';
    }
  }
}
child.stdout.on('data', scan);
child.stderr.on('data', scan);

let exited = false;
child.on('exit', code => {
  exited = true;
  console.log(`\n[smoke] start script exited with ${code}`);
});

function stop() {
  if (exited) {
    return;
  }
  try {
    if (windows) {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    // already gone
  }
}

function get(url) {
  const client = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    // the mkcert CA is not trusted here; this checks serving, not trust
    const req = client.get(url, { rejectUnauthorized: false }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`timeout fetching ${url}`)));
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const deadline = Date.now() + TIMEOUT_MS;
  while ((origin === null || addon === null) && !exited && Date.now() < deadline) {
    await sleep(250);
  }
  if (origin === null) {
    throw new Error('server never reported a listening address');
  }
  if (addon === null) {
    throw new Error('bridge never reported on the puara-gestures addon');
  }
  if (addon !== 'loaded' && requireAddon) {
    throw new Error('bridge started without the puara-gestures addon');
  }
  console.log(`\n[smoke] server at ${origin}, addon ${addon}`);

  for (const path of ['/', '/controller', '/build/player.js']) {
    const { status, body } = await get(origin + path);
    console.log(`[smoke] GET ${path} -> ${status} (${body.length} bytes)`);
    if (status !== 200 || body.length === 0) {
      throw new Error(`GET ${path} returned ${status}`);
    }
  }
  if (exited) {
    throw new Error('start script exited while the server should be running');
  }
}

let failed = false;
try {
  await main();
  console.log('[smoke] ok');
} catch (err) {
  failed = true;
  console.error(`[smoke] FAILED: ${err.message}`);
} finally {
  stop();
  await sleep(1000);
}
process.exit(failed ? 1 : 0);
