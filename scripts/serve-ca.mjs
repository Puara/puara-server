// Serves the mkcert root CA's public certificate over plain HTTP, so a test
// phone can download and install it. Plain HTTP on purpose: a phone that does
// not trust the CA yet cannot fetch it over a certificate signed by that CA.
// Only the public certificate is served, never the CA private key.
//
// Node rather than `python3 -m http.server`, so it works on every OS the
// scripts support without another runtime.
//
// Usage: node scripts/serve-ca.mjs <rootCA.pem> <bind-address> <port>

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const [file, host, port] = process.argv.slice(2);
if (!file || !host || !port) {
  console.error('usage: node scripts/serve-ca.mjs <rootCA.pem> <bind-address> <port>');
  process.exit(2);
}

const certificate = readFileSync(file);

createServer((req, res) => {
  // .crt with this type is what both iOS and Android recognise on download
  if (req.url === '/rootCA.crt') {
    res.writeHead(200, {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': 'attachment; filename="rootCA.crt"',
    });
    res.end(certificate);
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta name="viewport" content="width=device-width">'
      + '<p style="font:1.4em sans-serif"><a href="/rootCA.crt">rootCA.crt</a></p>');
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(Number(port), host);
