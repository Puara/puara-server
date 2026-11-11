// Prints the IPv4 address phones should use to reach this machine, or nothing
// (exit 1) when there is none. The choice itself is src/shared/lan-address.js,
// which the server and scripts/cert.mjs use too.
//
// Usage: node scripts/lan-ip.mjs

import { lanAddress } from '../src/shared/lan-address.js';

const address = lanAddress();
if (address === null) {
  process.exit(1);
}
console.log(address);
