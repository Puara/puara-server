// The bridge between puara-server and the real puara-gestures C++ library.
//
// The phones keep computing the JS ports of src/shared/gestures.js and emitting
// them under `/puara/audience/...`; the C++ descriptors go out in parallel under
// `/puara/gestures/...` from the same input. Two implementations of one gesture,
// side by side in `oscdump` — the comparison is the point of this branch, so
// neither replaces the other.
//
// Imported by the browser dashboard as well as the node bridge, so no node
// builtins here. Loading the addon lives in src/shared/native-addon.js.

export const NATIVE_ROOT = '/puara/gestures';

// Tunables surfaced to the dashboard. `key` is what the addon's setParams()
// reads. Ranges are wider than the useful range on purpose — finding the useful
// range is what this branch is for.
export const NATIVE_PARAMS = [
  { key: 'impactThreshold', label: 'impact: threshold (m/s²)', min: 0, max: 60, step: 0.5, default: 18 },
  { key: 'impactReleaseThreshold', label: 'impact: release', min: 0, max: 60, step: 0.5, default: 12 },
  { key: 'impactMinInterval', label: 'impact: refractory (ms)', min: 0, max: 2000, step: 10, default: 120 },
  { key: 'envelopeAttack', label: 'envelope: attack', min: 0, max: 1, step: 0.01, default: 0.5 },
  { key: 'envelopeRelease', label: 'envelope: release', min: 0, max: 1, step: 0.01, default: 0.05 },
  { key: 'stillnessThreshold', label: 'stillness: threshold', min: 0, max: 10, step: 0.05, default: 0.4 },
  { key: 'stillnessSettleTime', label: 'stillness: settle (ms)', min: 0, max: 5000, step: 50, default: 700 },
  { key: 'segmenterOnThreshold', label: 'segmenter: on', min: 0, max: 20, step: 0.1, default: 1.2 },
  { key: 'segmenterOffThreshold', label: 'segmenter: off', min: 0, max: 20, step: 0.1, default: 0.6 },
  { key: 'freefallThreshold', label: 'freefall: threshold', min: 0, max: 10, step: 0.1, default: 3 },
  { key: 'spinDeadzone', label: 'spin: deadzone (°/s)', min: 0, max: 100, step: 1, default: 5 },
  { key: 'rhythmSmoothing', label: 'rhythm: smoothing', min: 0, max: 0.99, step: 0.01, default: 0.5 },
  { key: 'rhythmTimeout', label: 'rhythm: timeout (ms)', min: 100, max: 10000, step: 100, default: 3000 },
  { key: 'ribbonTapMaxTime', label: 'ribbon: tap window (ms)', min: 10, max: 2000, step: 10, default: 250 },
  { key: 'ribbonTapMaxTravel', label: 'ribbon: tap travel', min: 0, max: 1, step: 0.01, default: 0.05 },
  { key: 'shakeThreshold', label: 'shake: threshold (m/s²)', min: 0, max: 50, step: 0.1, default: 0.1 },
  { key: 'jabThreshold', label: 'jab: threshold (m/s²)', min: 0, max: 100, step: 0.5, default: 5 },
  { key: 'buttonCountInterval', label: 'button: count window (ms)', min: 50, max: 2000, step: 10, default: 200 },
  { key: 'buttonHoldInterval', label: 'button: hold (ms)', min: 100, max: 20000, step: 100, default: 5000 },
];

export const NATIVE_PARAM_DEFAULTS = Object.fromEntries(
  NATIVE_PARAMS.map(({ key, default: value }) => [key, value]),
);

// Momentary flags: true for exactly one update() of the descriptor that owns
// them. Emitted as a bang when they fire instead of being diffed like a level,
// because the interesting event is the transition and a 30 Hz tick can carry a
// true and its own false inside one frame.
const MOMENTARY = new Set(['strike', 'onset', 'offset', 'landed', 'tap', 'doubleTap', 'tripleTap']);

// Walks whatever the addon returned into flat OSC-ready entries. Deliberately
// generic: a descriptor added to the C++ side shows up as soon as the addon
// reports it, with no table here to keep in step.
export function flatten(outputs, prefix = []) {
  const entries = [];

  for (const [key, value] of Object.entries(outputs)) {
    const trail = [...prefix, key];
    const address = trail.join('/');

    if (Array.isArray(value)) {
      entries.push({ address, values: value, type: 'float', momentary: false });
    } else if (typeof value === 'boolean') {
      entries.push({
        address,
        values: [value ? 1 : 0],
        type: 'integer',
        momentary: MOMENTARY.has(key),
      });
    } else if (typeof value === 'number') {
      entries.push({ address, values: [value], type: 'float', momentary: false });
    } else if (value !== null && typeof value === 'object') {
      entries.push(...flatten(value, trail));
    }
  }

  return entries;
}

export const nativeAddress = (id, address) => `${NATIVE_ROOT}/${id}/${address}`;
