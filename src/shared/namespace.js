// Single source of truth for the OSC namespace — the contract lives in
// docs/NAMESPACE.md and must match this file exactly.

// 0.2.0 — `shake` changed from an event float to a continuous 3-axis energy
// signal (puara-gestures semantics) and `jab` took over the old behaviour;
// jab/brush/rub/button and multi-touch addresses added.
export const NAMESPACE_VERSION = '0.2.0';

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
  // multi-touch: count, then one address per pointer index
  touchCount: id => `${ROOT}/${id}/touch/count`,
  touchPoint: (id, n) => `${ROOT}/${id}/touch/${n}`,
  tap: id => `${ROOT}/${id}/tap`,
  status: id => `${ROOT}/${id}/status`,
  // puara-gestures descriptors
  shake: id => `${ROOT}/${id}/shake`,
  jab: id => `${ROOT}/${id}/jab`,
  brush: id => `${ROOT}/${id}/brush`,
  rub: id => `${ROOT}/${id}/rub`,
  buttonCount: id => `${ROOT}/${id}/button/count`,
  buttonTap: id => `${ROOT}/${id}/button/tap`,
  buttonDtap: id => `${ROOT}/${id}/button/dtap`,
  buttonTtap: id => `${ROOT}/${id}/button/ttap`,
  buttonPress: id => `${ROOT}/${id}/button/press`,
  buttonHold: id => `${ROOT}/${id}/button/hold`,
  buttonPressTime: id => `${ROOT}/${id}/button/presstime`,
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
