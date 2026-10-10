// Touch surface layout — authored on the dashboard, rendered on every phone,
// resolved back to a region index that reaches OSC.
//
// The region math and the CSS grid geometry live together on purpose: the index
// a phone reports must be the cell the finger visually landed on, and that only
// holds if `regionAt()` and `gridGeometry()` agree on the ordering.

// Reading order in every split: left-to-right, then top-to-bottom. That is also
// the order a CSS grid flows children in, so region 2 of a quad is bottom-left
// both here and on screen.
export const SPLITS = ['single', 'columns', 'rows', 'quad'];

// What the surface draws. `regions` is the coloured split above; `gamepad` is a
// virtual controller (src/shared/gamepad.js). The touch data is identical in
// both — `touch`, `touches`, `tap`, brush/rub/button and `region` are computed
// from the same pointers whatever is drawn — and `gamepad` adds its own
// buttons and sticks on top.
export const SURFACES = ['regions', 'gamepad'];

// Kept deliberately dark: the audience holds these screens inside the
// Satosphère, and four bright panels would light the dome from the seats.
export const DEFAULT_REGIONS = [
  { label: '', color: '#1b3a6b' },
  { label: '', color: '#6b1b3a' },
  { label: '', color: '#1b6b4a' },
  { label: '', color: '#6b5a1b' },
];

// Always store MAX_REGIONS entries whatever the split is in use, so switching
// quad → columns → quad gives the operator their colours back instead of
// silently truncating them.
export const MAX_REGIONS = 4;

export function regionCount(split) {
  switch (split) {
    case 'columns':
    case 'rows':
      return 2;
    case 'quad':
      return 4;
    default:
      return 1;
  }
}

export function gridGeometry(split) {
  switch (split) {
    case 'columns':
      return { cols: 2, rows: 1 };
    case 'rows':
      return { cols: 1, rows: 2 };
    case 'quad':
      return { cols: 2, rows: 2 };
    default:
      return { cols: 1, rows: 1 };
  }
}

// Normalized [x, y] in 0-1 → region index. Returns -1 for no position, so the
// caller can tell "not touching" from "touching region 0".
export function regionAt(position, split) {
  if (!Array.isArray(position)) {
    return -1;
  }
  const [x, y] = position;
  switch (split) {
    case 'columns':
      return x < 0.5 ? 0 : 1;
    case 'rows':
      return y < 0.5 ? 0 : 1;
    case 'quad':
      return (y < 0.5 ? 0 : 2) + (x < 0.5 ? 0 : 1);
    default:
      return 0;
  }
}

// Fills gaps and drops junk, so a hand-edited config/puara.yaml or a partial
// dashboard write cannot leave a phone rendering `undefined` as a colour.
export function normalizeRegions(regions) {
  const source = Array.isArray(regions) ? regions : [];
  return DEFAULT_REGIONS.map((fallback, index) => {
    const entry = source[index] || {};
    return {
      label: typeof entry.label === 'string' ? entry.label : fallback.label,
      color: /^#[0-9a-fA-F]{6}$/.test(entry.color) ? entry.color : fallback.color,
    };
  });
}
