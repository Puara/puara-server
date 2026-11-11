// Touch surfaces as plugins — the contract between a surface file in
// `surfaces/` (or `surfaces/local/`) and the rest of puara-server.
//
// A surface file is an ES module whose default export describes what the
// surface is called, which settings the dashboard offers for it (`params`),
// what it sends (`outputs`), and how a phone draws it and reads fingers off it
// (`create`). surfaces/README.md is the guide for writing one; this file is the
// part every side shares: the server validates a module into a catalog entry,
// the dashboard builds controls from `params`, phones pack `outputs` onto the
// wire, and the bridge unpacks them into OSC. Pure data and functions — no DOM,
// no Node — so it runs in all four.
//
// `regions`, the coloured split, is not a plugin: it defines `region` and
// `/global/region/<n>/count`, which keep flowing whatever surface is drawn.

export const REGIONS_SURFACE = 'regions';

// Names a surface cannot take: it lands at /puara/audience/<id>/<surface>/...
// and /puara/audience/global/<surface>/..., so it must not shadow an address
// that already exists there (docs/NAMESPACE.md).
export const RESERVED_SURFACE_IDS = [
  REGIONS_SURFACE,
  'accel', 'gyro', 'orientation', 'touch', 'tap', 'status', 'region',
  'shake', 'jab', 'brush', 'rub', 'button',
  'energy', 'taps', 'touchcount', 'meta', 'zone', 'global',
];

export const PARAM_TYPES = ['enum', 'boolean', 'number', 'string', 'color'];
export const OUTPUT_TYPES = ['button', 'value'];

// Buttons travel as one integer bitmask (so a press costs a few bytes and
// soundworks can diff it), which caps them at 31 per surface.
export const MAX_BUTTONS = 31;
export const MAX_VALUE_SIZE = 16;

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const OUTPUT_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function validParamDefault(spec) {
  switch (spec.type) {
    case 'enum':
      return spec.list.includes(spec.default);
    case 'boolean':
      return typeof spec.default === 'boolean';
    case 'number':
      return typeof spec.default === 'number' && Number.isFinite(spec.default);
    case 'string':
      return typeof spec.default === 'string';
    case 'color':
      return typeof spec.default === 'string' && COLOR_PATTERN.test(spec.default);
    default:
      return false;
  }
}

// Module default export -> JSON-safe catalog entry (minus `id`, `url`,
// `source`, which the loader adds). Throws with every problem at once, so an
// artist fixing a file sees the whole list rather than one error per restart.
export function describeSurface(id, definition) {
  const errors = [];
  if (!ID_PATTERN.test(id)) {
    errors.push(`file name "${id}" must be lowercase letters, digits and dashes, starting with a letter`);
  }
  if (RESERVED_SURFACE_IDS.includes(id)) {
    errors.push(`"${id}" is reserved — it would collide with an existing OSC address`);
  }
  if (definition === null || typeof definition !== 'object') {
    throw new Error(`${id}: no default export object`);
  }
  if (typeof definition.create !== 'function') {
    errors.push('missing create(ctx)');
  }

  const params = {};
  for (const [key, spec] of Object.entries(definition.params || {})) {
    if (!OUTPUT_SEGMENT.test(key)) {
      errors.push(`param "${key}": use lowercase letters, digits, - and _`);
      continue;
    }
    if (!spec || !PARAM_TYPES.includes(spec.type)) {
      errors.push(`param "${key}": type must be one of ${PARAM_TYPES.join(', ')}`);
      continue;
    }
    if (spec.type === 'enum' && (!Array.isArray(spec.list) || spec.list.length === 0)) {
      errors.push(`param "${key}": an enum needs a non-empty list`);
      continue;
    }
    if (!validParamDefault(spec)) {
      errors.push(`param "${key}": default ${JSON.stringify(spec.default)} does not fit type ${spec.type}`);
      continue;
    }
    const clean = { type: spec.type, default: spec.default, label: spec.label || key };
    if (spec.type === 'enum') {
      clean.list = [...spec.list];
    }
    if (spec.type === 'number') {
      for (const bound of ['min', 'max', 'step']) {
        if (typeof spec[bound] === 'number') {
          clean[bound] = spec[bound];
        }
      }
    }
    params[key] = clean;
  }

  const outputs = [];
  for (const [name, spec] of Object.entries(definition.outputs || {})) {
    if (!name.split('/').every(segment => OUTPUT_SEGMENT.test(segment))) {
      errors.push(`output "${name}": use lowercase segments separated by /`);
      continue;
    }
    if (!spec || !OUTPUT_TYPES.includes(spec.type)) {
      errors.push(`output "${name}": type must be one of ${OUTPUT_TYPES.join(', ')}`);
      continue;
    }
    const size = spec.type === 'value' ? (spec.size ?? 1) : 1;
    if (!Number.isInteger(size) || size < 1 || size > MAX_VALUE_SIZE) {
      errors.push(`output "${name}": size must be an integer from 1 to ${MAX_VALUE_SIZE}`);
      continue;
    }
    outputs.push({ name, type: spec.type, size });
  }
  if (outputs.filter(output => output.type === 'button').length > MAX_BUTTONS) {
    errors.push(`more than ${MAX_BUTTONS} button outputs`);
  }

  if (errors.length > 0) {
    throw new Error(`${id}: ${errors.join('; ')}`);
  }

  return {
    label: typeof definition.label === 'string' ? definition.label : id,
    description: typeof definition.description === 'string' ? definition.description : '',
    params,
    outputs,
  };
}

// ## params — the dashboard's controls for one surface

export function defaultParams(entry) {
  return Object.fromEntries(Object.entries(entry.params).map(([key, spec]) => [key, spec.default]));
}

function validParam(spec, value) {
  switch (spec.type) {
    case 'enum':
      return spec.list.includes(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        && (spec.min === undefined || value >= spec.min)
        && (spec.max === undefined || value <= spec.max);
    case 'string':
      return typeof value === 'string';
    case 'color':
      return typeof value === 'string' && COLOR_PATTERN.test(value);
    default:
      return false;
  }
}

// Stored values -> one valid value per declared param. Anything missing, of the
// wrong type or out of range takes the default; keys the surface no longer
// declares are dropped. `warn(key, value)` hears about the bad ones, so a typo
// in the YAML costs a warning rather than a broken surface.
export function normalizeParams(entry, values, warn = () => {}) {
  const result = {};
  for (const [key, spec] of Object.entries(entry.params)) {
    const value = values ? values[key] : undefined;
    if (value === undefined) {
      result[key] = spec.default;
    } else if (validParam(spec, value)) {
      result[key] = value;
    } else {
      warn(key, value);
      result[key] = spec.default;
    }
  }
  return result;
}

// ## outputs — what a phone sends, packed for the wire
// Buttons: one integer, bit n = the n-th button output in declaration order.
// Values: one flat array of floats, each value output's `size` numbers in
// declaration order. Both are what the `player` state carries
// (`surfaceButtons`, `surfaceValues`); the bridge unpacks them with the same
// catalog entry the phone packed them with.

export function buttonOutputs(entry) {
  return entry.outputs.filter(output => output.type === 'button');
}

// [{ name, size, offset }] — offset into the flat values array
export function valueOutputs(entry) {
  let offset = 0;
  return entry.outputs
    .filter(output => output.type === 'value')
    .map(output => {
      const placed = { ...output, offset };
      offset += output.size;
      return placed;
    });
}

export function valueLength(entry) {
  return valueOutputs(entry).reduce((total, output) => total + output.size, 0);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// `read()` result from a surface instance -> { buttons, values }. Missing or
// malformed entries pack as released / 0, so a surface with a bug sends zeros
// rather than NaN into every patch downstream.
export function packOutputs(entry, outputs) {
  const read = outputs || {};
  let buttons = 0;
  buttonOutputs(entry).forEach(({ name }, bit) => {
    if (read[name]) {
      buttons |= 1 << bit;
    }
  });
  const values = [];
  for (const { name, size } of valueOutputs(entry)) {
    const value = read[name];
    for (let n = 0; n < size; n++) {
      values.push(finite(size === 1 && !Array.isArray(value) ? value : value?.[n]));
    }
  }
  return { buttons, values };
}

export function pressedButtonNames(entry, mask) {
  return buttonOutputs(entry).filter((_, bit) => mask & (1 << bit)).map(({ name }) => name);
}

// the slice of a flat values array that belongs to one value output
export function valueOf(output, values) {
  const slice = [];
  for (let n = 0; n < output.size; n++) {
    slice.push(finite(values?.[output.offset + n]));
  }
  return slice;
}
