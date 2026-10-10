// Virtual gamepad — the touch surface drawn as a PlayStation- or Xbox-style
// controller, in the manner of an emulator's touchscreen overlay (DuckStation's
// is the reference). Layout and hit-testing live together for the same reason
// the region math and grid geometry do in touch-layout.js: the button a phone
// reports must be the one the finger visually landed on, which only holds if
// the renderer and the hit test read the same geometry.
//
// Pure functions and plain data — no DOM — so the dashboard preview, the player
// and a node test can all drive it.

export const GAMEPAD_STYLES = ['playstation', 'xbox'];

// `bit` is the button's index in the W3C Standard Gamepad mapping, so bit n of
// the mask a phone sends means what `navigator.getGamepads()[0].buttons[n]`
// means. 10/11 (stick clicks) and 16 (home) have no touch control and stay 0.
// `name` is position-based, not style-based, so a patch keeps working when the
// operator switches the look from PlayStation to Xbox.
export const GAMEPAD_BUTTONS = [
  { name: 'south', bit: 0 },
  { name: 'east', bit: 1 },
  { name: 'west', bit: 2 },
  { name: 'north', bit: 3 },
  { name: 'l1', bit: 4 },
  { name: 'r1', bit: 5 },
  { name: 'l2', bit: 6 },
  { name: 'r2', bit: 7 },
  { name: 'select', bit: 8 },
  { name: 'start', bit: 9 },
  { name: 'dpad/up', bit: 12 },
  { name: 'dpad/down', bit: 13 },
  { name: 'dpad/left', bit: 14 },
  { name: 'dpad/right', bit: 15 },
];

export const GAMEPAD_STICKS = ['left', 'right'];

// name -> bit
export const GAMEPAD_BIT = Object.fromEntries(GAMEPAD_BUTTONS.map(({ name, bit }) => [name, bit]));

const LABELS = {
  playstation: {
    south: '✕', east: '○', west: '□', north: '△',
    l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2', select: 'SELECT', start: 'START',
  },
  xbox: {
    south: 'A', east: 'B', west: 'X', north: 'Y',
    l1: 'LB', r1: 'RB', l2: 'LT', r2: 'RT', select: 'VIEW', start: 'MENU',
  },
};

export function buttonLabel(style, name) {
  if (name.startsWith('dpad/')) {
    return { 'dpad/up': '↑', 'dpad/down': '↓', 'dpad/left': '←', 'dpad/right': '→' }[name];
  }
  return (LABELS[style] || LABELS.playstation)[name] || name;
}

// Names of the buttons set in `mask`, in GAMEPAD_BUTTONS order.
export function pressedButtons(mask) {
  return GAMEPAD_BUTTONS.filter(({ bit }) => mask & (1 << bit)).map(({ name }) => name);
}

// ## layout
// Two design canvases in abstract units. A canvas is scaled uniformly to fit
// the element, so controls can never overlap, then every control is pinned to
// the edge it belongs to (`pin: [x, y]`, each 'start' | 'center' | 'end'): on a
// screen wider or taller than the canvas, the d-pad stays under the left thumb
// and the sticks stay at the bottom instead of drifting toward the middle.
// Pinning only ever moves controls apart, never together.
//
// `face` is the four-button diamond, `spacing` from its centre to each button.
const LANDSCAPE = {
  width: 200,
  height: 100,
  controls: [
    { kind: 'shoulder', name: 'l2', x: 18, y: 9, w: 28, h: 10, pin: ['start', 'start'] },
    { kind: 'shoulder', name: 'l1', x: 18, y: 22, w: 28, h: 10, pin: ['start', 'start'] },
    { kind: 'shoulder', name: 'r2', x: 182, y: 9, w: 28, h: 10, pin: ['end', 'start'] },
    { kind: 'shoulder', name: 'r1', x: 182, y: 22, w: 28, h: 10, pin: ['end', 'start'] },
    { kind: 'dpad', x: 28, y: 52, r: 20, pin: ['start', 'center'] },
    { kind: 'face', x: 172, y: 52, spacing: 13, r: 8, pin: ['end', 'center'] },
    { kind: 'pill', name: 'select', x: 88, y: 52, w: 17, h: 7, pin: ['center', 'center'] },
    { kind: 'pill', name: 'start', x: 112, y: 52, w: 17, h: 7, pin: ['center', 'center'] },
    { kind: 'stick', name: 'left', x: 66, y: 80, r: 15, pin: ['start', 'end'] },
    { kind: 'stick', name: 'right', x: 134, y: 80, r: 15, pin: ['end', 'end'] },
  ],
};

const PORTRAIT = {
  width: 100,
  height: 180,
  controls: [
    { kind: 'shoulder', name: 'l2', x: 16, y: 8, w: 26, h: 9, pin: ['start', 'start'] },
    { kind: 'shoulder', name: 'l1', x: 16, y: 20, w: 26, h: 9, pin: ['start', 'start'] },
    { kind: 'shoulder', name: 'r2', x: 84, y: 8, w: 26, h: 9, pin: ['end', 'start'] },
    { kind: 'shoulder', name: 'r1', x: 84, y: 20, w: 26, h: 9, pin: ['end', 'start'] },
    { kind: 'dpad', x: 27, y: 64, r: 19, pin: ['start', 'center'] },
    { kind: 'face', x: 73, y: 64, spacing: 12.5, r: 7.5, pin: ['end', 'center'] },
    { kind: 'pill', name: 'select', x: 38, y: 96, w: 17, h: 7, pin: ['center', 'center'] },
    { kind: 'pill', name: 'start', x: 62, y: 96, w: 17, h: 7, pin: ['center', 'center'] },
    { kind: 'stick', name: 'left', x: 27, y: 148, r: 17, pin: ['start', 'end'] },
    { kind: 'stick', name: 'right', x: 73, y: 148, r: 17, pin: ['end', 'end'] },
  ],
};

function place(value, pin, size, canvasSize, scale) {
  switch (pin) {
    case 'end':
      return size - (canvasSize - value) * scale;
    case 'center':
      return size / 2 + (value - canvasSize / 2) * scale;
    default:
      return value * scale;
  }
}

// Element size in px → controls in px, origin at the element's top-left.
// Whichever canvas fills the element better wins, so a phone gets the portrait
// layout held upright and the landscape one turned sideways, and the short,
// wide pad on the Data tab gets the landscape one.
export function gamepadLayout(width, height) {
  const fit = canvas => Math.min(width / canvas.width, height / canvas.height);
  const canvas = fit(LANDSCAPE) >= fit(PORTRAIT) ? LANDSCAPE : PORTRAIT;
  const scale = fit(canvas);
  const controls = [];

  for (const spec of canvas.controls) {
    const x = place(spec.x, spec.pin[0], width, canvas.width, scale);
    const y = place(spec.y, spec.pin[1], height, canvas.height, scale);

    switch (spec.kind) {
      case 'face': {
        const s = spec.spacing * scale;
        const r = spec.r * scale;
        for (const [name, dx, dy] of [['north', 0, -s], ['east', s, 0], ['south', 0, s], ['west', -s, 0]]) {
          controls.push({ kind: 'button', shape: 'face', name, bit: GAMEPAD_BIT[name], x: x + dx, y: y + dy, w: 2 * r, h: 2 * r });
        }
        break;
      }
      case 'shoulder':
      case 'pill':
        controls.push({
          kind: 'button',
          shape: spec.kind,
          name: spec.name,
          bit: GAMEPAD_BIT[spec.name],
          x,
          y,
          w: spec.w * scale,
          h: spec.h * scale,
        });
        break;
      default:
        controls.push({ kind: spec.kind, name: spec.name, x, y, r: spec.r * scale });
    }
  }

  return {
    width,
    height,
    scale,
    orientation: canvas === LANDSCAPE ? 'landscape' : 'portrait',
    controls,
  };
}

// ## hit testing
// Targets are a little larger than what is drawn: a thumb lands off-centre, and
// on glass there is no edge to feel for. Adjacent face buttons overlap by a
// sliver, so a thumb between ✕ and □ presses both, as on a real pad.
const FACE_SLOP = 1.2;
const RECT_SLOP = 1.15;
const DPAD_SLOP = 1.2;
// a finger resting on the d-pad's centre is not pushing any direction
const DPAD_DEAD = 0.18;
// Each direction claims ±67.5° around its axis, so the 45° between two arms
// presses both — the diagonal.
const DPAD_HALF_ANGLE = (67.5 * Math.PI) / 180;
// a stick is grabbed from a little outside its base, then held wherever the
// finger goes until it lifts
const STICK_CAPTURE = 1.5;
// radial dead zone, rescaled so the output still reaches 1 at the rim
const STICK_DEAD = 0.12;

function hitButton(control, x, y) {
  const dx = Math.abs(x - control.x);
  const dy = Math.abs(y - control.y);
  if (control.shape === 'face') {
    return Math.hypot(dx, dy) <= (control.w / 2) * FACE_SLOP;
  }
  return dx <= (control.w / 2) * RECT_SLOP && dy <= (control.h / 2) * RECT_SLOP;
}

function dpadMask(control, x, y) {
  const dx = x - control.x;
  const dy = y - control.y;
  const distance = Math.hypot(dx, dy);
  if (distance > control.r * DPAD_SLOP || distance < control.r * DPAD_DEAD) {
    return 0;
  }
  const angle = Math.atan2(dy, dx); // screen coordinates: +y is down
  let mask = 0;
  for (const [name, axis] of [['dpad/right', 0], ['dpad/down', Math.PI / 2], ['dpad/left', Math.PI], ['dpad/up', -Math.PI / 2]]) {
    let delta = Math.abs(angle - axis);
    if (delta > Math.PI) {
      delta = 2 * Math.PI - delta;
    }
    if (delta < DPAD_HALF_ANGLE) {
      mask |= 1 << GAMEPAD_BIT[name];
    }
  }
  return mask;
}

// Mask of every button under a point. Exported for tests and for the
// dashboard; the player goes through createGamepadInput().
export function buttonsAt(layout, x, y) {
  let mask = 0;
  for (const control of layout.controls) {
    if (control.kind === 'button' && hitButton(control, x, y)) {
      mask |= 1 << control.bit;
    } else if (control.kind === 'dpad') {
      mask |= dpadMask(control, x, y);
    }
  }
  return mask;
}

function stickControl(layout, name) {
  return layout.controls.find(control => control.kind === 'stick' && control.name === name);
}

// Finger offset from the stick's centre in base radii, clamped to the rim.
// +y is down, as in the W3C Gamepad API.
function stickOffset(control, x, y) {
  let vx = (x - control.x) / control.r;
  let vy = (y - control.y) / control.r;
  const magnitude = Math.hypot(vx, vy);
  if (magnitude > 1) {
    vx /= magnitude;
    vy /= magnitude;
  }
  return [vx, vy];
}

function withDeadZone([vx, vy]) {
  const magnitude = Math.hypot(vx, vy);
  if (magnitude < STICK_DEAD) {
    return [0, 0];
  }
  const gain = (magnitude - STICK_DEAD) / (1 - STICK_DEAD) / magnitude;
  // three decimals: finer than a thumb, and coarse enough that the jitter of a
  // resting finger does not re-send the value every tick
  return [vx * gain, vy * gain].map(v => Math.round(v * 1000) / 1000 + 0);
}

// Multi-touch state for one gamepad. Each pointer is either holding a stick —
// decided once, on pointerdown — or pressing buttons, re-tested on every move
// so a thumb can slide from one button to the next without lifting, as on an
// emulator overlay. Coordinates are px in the layout's frame.
export function createGamepadInput() {
  const pointers = new Map(); // pointerId -> { stick: name | null, x, y }
  const offsets = { left: [0, 0], right: [0, 0] };
  let layout = null;

  function holder(name) {
    for (const pointer of pointers.values()) {
      if (pointer.stick === name) {
        return pointer;
      }
    }
    return null;
  }

  function track(pointer) {
    if (pointer.stick === null) {
      return;
    }
    const control = stickControl(layout, pointer.stick);
    offsets[pointer.stick] = control ? stickOffset(control, pointer.x, pointer.y) : [0, 0];
  }

  return {
    down(nextLayout, id, x, y) {
      layout = nextLayout;
      const stick = layout.controls.find(control => control.kind === 'stick'
        && holder(control.name) === null
        && Math.hypot(x - control.x, y - control.y) <= control.r * STICK_CAPTURE);
      const pointer = { stick: stick ? stick.name : null, x, y };
      pointers.set(id, pointer);
      track(pointer);
    },

    move(nextLayout, id, x, y) {
      const pointer = pointers.get(id);
      if (pointer === undefined) {
        return;
      }
      layout = nextLayout;
      pointer.x = x;
      pointer.y = y;
      track(pointer);
    },

    up(id) {
      const pointer = pointers.get(id);
      if (pointer === undefined) {
        return;
      }
      pointers.delete(id);
      if (pointer.stick !== null) {
        offsets[pointer.stick] = [0, 0];
      }
    },

    clear() {
      pointers.clear();
      offsets.left = [0, 0];
      offsets.right = [0, 0];
    },

    // bitmask over GAMEPAD_BUTTONS[].bit
    buttons() {
      if (layout === null) {
        return 0;
      }
      let mask = 0;
      for (const pointer of pointers.values()) {
        if (pointer.stick === null) {
          mask |= buttonsAt(layout, pointer.x, pointer.y);
        }
      }
      return mask;
    },

    // [leftX, leftY, rightX, rightY] in -1..1, dead zone applied — what is sent
    sticks() {
      return [...withDeadZone(offsets.left), ...withDeadZone(offsets.right)];
    },

    // raw offset under the finger, for drawing the knob where the thumb is
    knob(name) {
      return offsets[name];
    },
  };
}
