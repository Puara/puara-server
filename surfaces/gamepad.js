// gamepad — the touch surface drawn as a PlayStation- or Xbox-style controller,
// in the manner of an emulator's touchscreen overlay: d-pad and face buttons
// under the thumbs, two analogue sticks, L1/L2/R1/R2 at the top, Select/Start in
// the middle. Portrait or landscape, whichever way the phone is held.
//
// The shipped reference for a surface plugin (surfaces/README.md). The
// geometry and hit testing are in gamepad/geometry.js, the drawing in
// gamepad/view.js, the look in gamepad/gamepad.css.
//
// OSC (docs/NAMESPACE.md "Touch surfaces"), unchanged from before surfaces
// were plugins:
//   /puara/audience/<id>/gamepad/<button>      i   1 press, 0 release
//   /puara/audience/<id>/gamepad/stick/left    ff  -1..1, +y down
//   /puara/audience/<id>/gamepad/stick/right   ff
// Button names are positional (south is ✕ and A), so a patch survives a switch
// of `style`.

import {
  GAMEPAD_BUTTONS,
  GAMEPAD_STYLES,
  buttonLabel,
  createGamepadInput,
  gamepadLayout,
} from './gamepad/geometry.js';
import { createView } from './gamepad/view.js';

function formatNumber(value) {
  return value.toFixed(2);
}

export default {
  label: 'gamepad',
  description: 'A virtual game controller: d-pad, face buttons, two sticks, '
    + 'shoulders, select/start. Fingers slide from button to button; a thumb '
    + 'between two face buttons or d-pad arms presses both.',
  stylesheet: './gamepad/gamepad.css',

  params: {
    style: { type: 'enum', list: GAMEPAD_STYLES, default: 'playstation', label: 'gamepad style' },
  },

  // Declaration order is wire order: the buttons in GAMEPAD_BUTTONS order, so
  // the audience counts come out as they did before plugins.
  outputs: {
    ...Object.fromEntries(GAMEPAD_BUTTONS.map(({ name }) => [name, { type: 'button' }])),
    'stick/left': { type: 'value', size: 2 },
    'stick/right': { type: 'value', size: 2 },
  },

  // the Data tab's line: labels as drawn on this phone, then both sticks
  format({ outputs, params }) {
    const names = GAMEPAD_BUTTONS
      .filter(({ name }) => outputs[name])
      .map(({ name }) => buttonLabel(params.style, name));
    const [lx, ly] = outputs['stick/left'].map(formatNumber);
    const [rx, ry] = outputs['stick/right'].map(formatNumber);
    return `${names.join(' ') || '—'}  L[${lx} ${ly}] R[${rx} ${ry}]`;
  },

  create({ html, svg, nothing }) {
    const view = createView({ html, svg, nothing });
    const input = createGamepadInput();
    // memoized: hit-tested on every pointermove, recomputed only on resize
    let cache = { key: '', layout: null };

    function layoutFor(width, height) {
      const key = `${width}x${height}`;
      if (cache.key !== key) {
        cache = { key, layout: width > 0 && height > 0 ? gamepadLayout(width, height) : null };
      }
      return cache.layout;
    }

    return {
      render({ width, height, params, feedback }) {
        return view.renderGamepad(layoutFor(width, height), params.style, feedback ? input.buttons() : 0);
      },

      down(pointerId, x, y, width, height) {
        const layout = layoutFor(width, height);
        if (layout !== null) {
          input.down(layout, pointerId, x, y);
        }
      },

      move(pointerId, x, y, width, height) {
        const layout = layoutFor(width, height);
        if (layout !== null) {
          input.move(layout, pointerId, x, y);
        }
      },

      up(pointerId) {
        input.up(pointerId);
      },

      clear() {
        input.clear();
      },

      read() {
        const mask = input.buttons();
        const [lx, ly, rx, ry] = input.sticks();
        return {
          ...Object.fromEntries(GAMEPAD_BUTTONS.map(({ name, bit }) => [name, (mask >> bit) & 1])),
          'stick/left': [lx, ly],
          'stick/right': [rx, ry],
        };
      },

      // Knobs follow every pointermove straight through the DOM: a lit render
      // per move is what this hook exists to avoid.
      paint(root, { feedback }) {
        for (const $stick of root.querySelectorAll('.pad-stick')) {
          const [vx, vy] = feedback ? input.knob($stick.dataset.stick) : [0, 0];
          const r = Number($stick.dataset.r);
          $stick.firstElementChild.style.transform = `translate(${vx * r}px, ${vy * r}px)`;
        }
      },
    };
  },
};
