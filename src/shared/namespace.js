// Single source of truth for the OSC namespace — the contract lives in
// docs/NAMESPACE.md and must match this file exactly.

export const NAMESPACE_VERSION = '0.1.0';

const ROOT = '/puara/audience';

export const meta = {
  version: () => `${ROOT}/meta/version`,
  connected: () => `${ROOT}/meta/connected`,
  zones: () => `${ROOT}/meta/zones`,
};

export const device = {
  accel: id => `${ROOT}/${id}/accel`,
  gyro: id => `${ROOT}/${id}/gyro`,
  orientation: id => `${ROOT}/${id}/orientation`,
  touch: id => `${ROOT}/${id}/touch`,
  tap: id => `${ROOT}/${id}/tap`,
  shake: id => `${ROOT}/${id}/shake`,
  status: id => `${ROOT}/${id}/status`,
};

export const zone = {
  energy: name => `${ROOT}/zone/${name}/energy`,
  count: name => `${ROOT}/zone/${name}/count`,
  taps: name => `${ROOT}/zone/${name}/taps`,
};

export const global = {
  energy: () => `${ROOT}/global/energy`,
  taps: () => `${ROOT}/global/taps`,
  touchcount: () => `${ROOT}/global/touchcount`,
};
