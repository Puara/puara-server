// Prints the IPv4 address phones should use to reach this machine, or nothing
// (exit 1) when there is none. Shared by the install and start scripts on
// Linux, macOS and Windows, so all three pick the same interface the same way.
//
// Usage: node scripts/lan-ip.mjs

import { networkInterfaces } from 'node:os';

// Container, VM and VPN adapters carry addresses a phone on the venue Wi-Fi
// cannot reach. Names as Linux, macOS and Windows report them.
const VIRTUAL = /^(docker|br-|virbr|veth|tailscale|zt|utun|awdl|llw|bridge|vmnet|vboxnet|vethernet|virtualbox|vmware|hyper-v|zerotier|loopback)/i;

function isPrivate(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const candidates = [];
for (const [name, addresses] of Object.entries(networkInterfaces())) {
  if (VIRTUAL.test(name)) {
    continue;
  }
  for (const { family, internal, address } of addresses || []) {
    // 169.254.x.x is what Windows and macOS self-assign when DHCP failed
    if (family === 'IPv4' && !internal && !address.startsWith('169.254.')) {
      candidates.push(address);
    }
  }
}

// a venue LAN is a private range; a public address first in the list is more
// likely a tethered phone or a VPN the filter did not recognise
const best = candidates.find(isPrivate) || candidates[0];
if (best === undefined) {
  process.exit(1);
}
console.log(best);
