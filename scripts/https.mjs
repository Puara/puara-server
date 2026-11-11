// Keeps the HTTPS setup valid for wherever this machine is now. The install
// scripts run it once and the start scripts before every start, on Linux,
// macOS and Windows alike, so a new network, a new machine or a copied folder
// needs nothing but a restart.
//
//  - A fixed IP in `serverAddress` is cleared: with it blank, phones open their
//    WebSocket to whatever address they loaded the page from, and the bridge
//    to 127.0.0.1. A fixed IP goes stale with the network.
//  - The certificate in certs/ is reissued, with this machine's mkcert CA,
//    when it is missing, does not cover the LAN address (or the host of
//    `publicAddress` in config/puara.yaml), expires within 30 days, or was
//    signed by another CA. Same CA, so phones that trusted it still do.
//  - With --init (the installers), config/env-dev.yaml is written first if it
//    does not exist.
//
// A certificate kept outside certs/ is yours: it is checked and reported on,
// never replaced. An env file without useHttps is left alone apart from
// serverAddress.
//
// Usage: node scripts/https.mjs [--env dev] [--init] [--mkcert <path>] [--ip <address>]
//   --ip   the address phones use, when the detected one is wrong (and for tests)
//
// Exit 1 when the certificate needed reissuing and could not be. Prints ASCII
// only: Windows consoles may not be UTF-8.

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import { isIP, isIPv4 } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import YAML from 'yaml';

import { lanAddress } from '../src/shared/lan-address.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = path.join(REPO_ROOT, 'certs');
const CERT_FILE = path.join(CERT_DIR, 'server.pem');
const KEY_FILE = path.join(CERT_DIR, 'server-key.pem');
const RENEW_DAYS = 30;

const { values: args } = parseArgs({
  options: {
    env: { type: 'string', default: 'dev' },
    init: { type: 'boolean', default: false },
    mkcert: { type: 'string' },
    ip: { type: 'string' },
  },
});

// the installers indent their own lines; the start scripts do not
const say = message => console.log(`${args.init ? '    ' : ''}${message}`);

function relative(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

// forward slashes: Node accepts them on Windows, and YAML needs no escaping
function yamlPath(file) {
  return file.split(path.sep).join('/');
}

function samePath(a, b) {
  const fold = file => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));
  return fold(a) === fold(b);
}

function insideCertDir(file) {
  const from = path.relative(CERT_DIR, path.resolve(REPO_ROOT, file));
  return from !== '' && !from.startsWith('..') && !path.isAbsolute(from);
}

function findMkcert() {
  if (args.mkcert) {
    return args.mkcert;
  }
  const windows = process.platform === 'win32';
  const exe = windows ? 'mkcert.exe' : 'mkcert';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) {
      return path.join(dir, exe);
    }
  }
  // where the installers put it
  const local = windows
    ? path.join(process.env.LOCALAPPDATA || '', 'puara-server', 'bin', exe)
    : path.join(os.homedir(), '.local', 'bin', exe);
  return fs.existsSync(local) ? local : null;
}

// The bare host name; the certificate also gets <name>.local. macOS answers
// with the .local name already, so ask it for the Bonjour name.
function hostName() {
  if (process.platform === 'darwin') {
    try {
      return execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // fall through to the generic name
    }
  }
  return os.hostname().replace(/\.local$/i, '').toLowerCase();
}

// the host the QR codes point at, when config/puara.yaml sets one
function publicHost() {
  try {
    const puara = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'puara.yaml'), 'utf8'));
    if (puara && typeof puara.publicAddress === 'string' && puara.publicAddress.trim() !== '') {
      return new URL(puara.publicAddress.trim()).hostname.replace(/^\[|\]$/g, '');
    }
  } catch {
    // no file, or an address that is not a URL: the server reports that one
  }
  return null;
}

function covers(cert, name) {
  return (isIP(name) ? cert.checkIP(name) : cert.checkHost(name)) !== undefined;
}

function readCert(file) {
  try {
    return new X509Certificate(fs.readFileSync(file));
  } catch {
    return null;
  }
}

// ----------------------------------------------------------- env file
const envFile = path.join(REPO_ROOT, 'config', `env-${args.env}.yaml`);

if (args.init && !fs.existsSync(envFile)) {
  const yaml = [
    'type: development',
    'port: 8000',
    "# blank: phones connect back to the address they opened the page from",
    "serverAddress: ''",
    'useHttps: true',
    'httpsInfos:',
    `  cert: '${yamlPath(CERT_FILE).replace(/'/g, "''")}'`,
    `  key: '${yamlPath(KEY_FILE).replace(/'/g, "''")}'`,
    "baseUrl: ''",
    'auth:',
    '  clients: []',
    "  login: ''",
    "  password: ''",
    '',
  ].join('\n');
  fs.writeFileSync(envFile, yaml);
  say(`${relative(envFile)} written (gitignored)`);
} else if (args.init) {
  say(`${relative(envFile)} exists - kept`);
}

if (!fs.existsSync(envFile)) {
  console.error(`${relative(envFile)} not found`);
  process.exit(1);
}

const doc = YAML.parseDocument(fs.readFileSync(envFile, 'utf8'));
const env = doc.toJS() || {};
let envChanged = false;

if (typeof env.serverAddress === 'string' && isIPv4(env.serverAddress)) {
  doc.set('serverAddress', '');
  envChanged = true;
  say(`serverAddress ${env.serverAddress} cleared in ${relative(envFile)}: phones now connect back`);
  say('  to the address they opened the page from, whatever the network');
}

function saveEnv() {
  if (envChanged) {
    fs.writeFileSync(envFile, doc.toString());
  }
}

const infos = env.httpsInfos;
if (env.useHttps !== true || !infos || typeof infos !== 'object' || (infos.cert == null && infos.key == null)) {
  // plain HTTP, or soundworks' own self-signed certificate: nothing to keep
  saveEnv();
  process.exit(0);
}

// ---------------------------------------------------------- certificate
const ip = args.ip || lanAddress();
const host = publicHost();
const wanted = [...new Set([ip, host].filter(Boolean))];

const certPath = typeof infos.cert === 'string' ? path.resolve(REPO_ROOT, infos.cert) : '';
const keyPath = typeof infos.key === 'string' ? path.resolve(REPO_ROOT, infos.key) : '';
const present = certPath !== '' && keyPath !== '' && fs.existsSync(certPath) && fs.existsSync(keyPath);
const cert = present ? readCert(certPath) : null;
// A certificate outside certs/ came from someone, not from this script — a
// real one for a hostname, say (docs/DEPLOYMENT.md tier 2). Phones then reach
// the server by that name, so it only has to cover publicAddress when set.
const managed = !present || insideCertDir(certPath);
const required = managed || host === null ? wanted : [host];

const problems = [];
if (!present) {
  problems.push('is missing');
} else if (cert === null) {
  problems.push('cannot be read');
} else {
  const missing = required.filter(name => !covers(cert, name));
  if (missing.length > 0) {
    problems.push(`does not cover ${missing.join(', ')}`);
  }
  const daysLeft = (new Date(cert.validTo).getTime() - Date.now()) / 86_400_000;
  if (daysLeft < RENEW_DAYS) {
    problems.push(daysLeft < 0 ? 'has expired' : `expires in ${Math.floor(daysLeft)} days`);
  }
}

if (!managed) {
  saveEnv();
  if (problems.length > 0) {
    say(`! certificate ${relative(certPath)} ${problems.join(' and ')}.`);
    say('  It is kept outside certs/, so it is left as it is: phones may refuse it.');
  } else {
    say(`Certificate ok for ${required.join(', ') || 'localhost'} (${relative(certPath)}, your own)`);
  }
  process.exit(0);
}

const mkcert = findMkcert();
let caFile = null;
if (mkcert !== null) {
  try {
    const caRoot = execFileSync(mkcert, ['-CAROOT'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    caFile = path.join(caRoot, 'rootCA.pem');
  } catch {
    caFile = null;
  }
}
const ca = caFile !== null && fs.existsSync(caFile) ? readCert(caFile) : null;
const foreignCa = cert !== null && ca !== null && !(cert.checkIssued(ca) && cert.verify(ca.publicKey));
if (foreignCa) {
  problems.push("was signed by another machine's CA");
}

function noLanWarning() {
  if (ip === null) {
    say('! No LAN address found: phones cannot reach this machine. Connect it to the');
    say('  network and start again; the certificate follows.');
  }
}

if (problems.length === 0) {
  saveEnv();
  say(`Certificate ok for ${wanted.join(', ') || 'localhost'} (${relative(certPath)})`);
  noLanWarning();
  process.exit(0);
}

const shown = present ? relative(certPath) : 'certificate';
if (mkcert === null) {
  saveEnv();
  say(`! ${shown} ${problems.join(' and ')}, and mkcert is not installed to reissue it.`);
  say('  Phones will refuse the connection: run the install script.');
  process.exit(1);
}

const names = [...new Set([...wanted, `${hostName()}.local`, hostName(), 'localhost', '127.0.0.1'])];
fs.mkdirSync(CERT_DIR, { recursive: true });
try {
  execFileSync(mkcert, ['-cert-file', CERT_FILE, '-key-file', KEY_FILE, ...names], { stdio: 'pipe' });
} catch (error) {
  saveEnv();
  say(`! ${shown} ${problems.join(' and ')}, and mkcert could not reissue it:`);
  process.stderr.write(String(error.stderr || error.message));
  process.exit(1);
}

say(present ? `Certificate reissued: ${shown} ${problems.join(' and ')}.` : 'Certificate issued.');
say(`  Now valid for ${names.join(', ')} (${relative(CERT_FILE)}).`);
if (ca !== null && !foreignCa) {
  say("  Signed by this machine's CA: phones that trust it accept it as they are.");
} else if (ca !== null) {
  say("  Signed with this machine's CA: phones need it installed once (start script");
  say('  with --serve-ca, or -ServeCa on Windows).');
} else {
  say(`  mkcert created a new root CA in ${path.dirname(caFile || '')}: each test phone must`);
  say('  install it once (start script with --serve-ca, or -ServeCa on Windows).');
}

// Point the env file at certs/server.pem, and drop the pair it replaces when
// that was one this script or an older installer wrote into certs/.
if (!samePath(certPath || CERT_FILE, CERT_FILE) || !samePath(keyPath || KEY_FILE, KEY_FILE)) {
  doc.setIn(['httpsInfos', 'cert'], yamlPath(CERT_FILE));
  doc.setIn(['httpsInfos', 'key'], yamlPath(KEY_FILE));
  envChanged = true;
  for (const old of [certPath, keyPath]) {
    const current = samePath(old || CERT_FILE, CERT_FILE) || samePath(old || KEY_FILE, KEY_FILE);
    if (old !== '' && !current && insideCertDir(old) && fs.existsSync(old)) {
      fs.rmSync(old);
      say(`  Removed the old ${relative(old)}.`);
    }
  }
}
saveEnv();
noLanWarning();
