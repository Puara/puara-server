# Deployment — HTTPS, certificates, network

Phone sensors (`devicemotion`, wake lock) require a **secure context**: the
player page must be served over HTTPS, and the WebSocket goes over `wss://`.
Two tiers:

## Tier 1 — Dev / lab (mkcert) — implemented

[mkcert](https://github.com/FiloSottile/mkcert) creates a local certificate
authority, then issues certificates for your LAN IP / hostname. The CA is
installed on the test phones so certificates are fully trusted.

> **Why not a plain self-signed certificate?** On iOS, tapping through the
> page-level certificate warning does **not** cover `wss://` connections — the
> WebSocket silently fails. A trusted CA (mkcert) is the reliable path.

### Server side

```sh
mkcert -install
mkcert 10.10.30.152 my-workstation.local localhost 127.0.0.1
# → produces e.g. 10.10.30.152+3.pem / 10.10.30.152+3-key.pem
```

Create `config/env-dev.yaml` (gitignored):

```yaml
type: development
port: 8000
serverAddress: '10.10.30.152'
useHttps: true
httpsInfos:
  cert: /absolute/path/to/10.10.30.152+3.pem
  key: /absolute/path/to/10.10.30.152+3-key.pem
baseUrl: ''
auth:
  clients: []
  login: ''
  password: ''
```

Run with `ENV=dev npm run dev` (or `ENV=dev npm start` + `ENV=dev npm run bridge`).

### Phone side (once per test device)

1. Find the mkcert root CA: `mkcert -CAROOT` → `rootCA.pem`.
2. Get it onto the phone (AirDrop, email, or serve it from the LAN).
3. **iOS**: install the profile (Settings → General → VPN & Device
   Management), then **enable full trust**: Settings → General → About →
   Certificate Trust Settings.
4. **Android**: Settings → Security → Install a certificate → CA certificate.

Then scan the QR (controller dashboard → QR panel, printable) — no warnings.

## Tier 2 — Audience / production (documented, not blocking)

Goal: zero warnings, QR → instant join, on stock phones with no pre-installed
profile. That requires a **publicly valid certificate** for a real hostname:

1. Pick a hostname with SAT IT, e.g. `connect.sat.qc.ca` (TBD).
2. Obtain a Let's Encrypt certificate via **DNS-01 challenge** — validation
   happens through a DNS TXT record, so the show server never needs to be
   exposed to the public internet. Tooling: `certbot` or `lego` with the DNS
   provider's API, or a manual TXT record for one-offs.
3. Venue WiFi DNS resolves `connect.sat.qc.ca` to the LAN address of the
   server (split-horizon / local DNS override).
4. Point `httpsInfos` in a `config/env-prod.yaml` at the issued cert/key.

**Renewal**: Let's Encrypt certificates last 90 days. Either automate DNS-01
renewal (cron + API-capable DNS), or put a calendar reminder to renew before
each show run. An expired certificate = nobody can join.

## WiFi / network checklist (audience scale)

WiFi is the real bottleneck, not the server. For the SAT network team:

- Multiple APs sized for the expected headcount (rule of thumb: 50–100
  well-behaved clients per AP radio).
- **AP client isolation must not block phone → server traffic** (isolation
  between clients is fine; isolation from the wired LAN is not).
- 5 GHz preferred; dedicated SSID for the show recommended.
- DHCP pool large enough (350+ leases, short lease time).
- Multicast/broadcast throttling is fine — everything here is unicast.
- Bandwidth is modest: 300 phones × 20 Hz × ~200 B ≈ 1.2 MB/s upstream total.
  Message *rate* matters more than throughput; the operator lowers
  `sensorRate` from the dashboard or switches to `events-only` if needed.
- Design assumption: only ~60–80 % of a room connects successfully. The piece
  and the aggregates must stay meaningful regardless of N.

## Measured devicemotion rates (fill in during M1/M2)

| device | browser | requested (Hz) | delivered (Hz) |
|---|---|---|---|
| _iPhone …_ | Safari | 100 | _~60 expected_ |
| _Android …_ | Chrome | 100 | _measure_ |
