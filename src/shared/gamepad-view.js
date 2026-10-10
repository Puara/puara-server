// Draws a gamepadLayout() with lit. Shared by the player, which touches it, and
// the dashboard, which previews it — the same reason renderRegionGrid() is
// shared within the player: a preview is only honest if it is the same drawing.
//
// Browser-only (lit). Every element is `pointer-events: none`; the pointer
// handlers stay on the surface the gamepad is drawn inside, exactly as with the
// region grid, so multi-touch is tracked in one place.

import { html, svg, nothing } from 'lit';

import { GAMEPAD_BIT, buttonLabel } from './gamepad.js';

// PlayStation glyphs as strokes rather than text: ✕○□△ come out of every phone
// font at a different weight and baseline. Drawn in a -1..1 box.
const PS_GLYPHS = {
  south: svg`<path d="M-0.42 -0.42 L0.42 0.42 M0.42 -0.42 L-0.42 0.42" />`,
  east: svg`<circle r="0.44" />`,
  west: svg`<rect x="-0.4" y="-0.4" width="0.8" height="0.8" />`,
  north: svg`<path d="M0 -0.48 L0.46 0.34 L-0.46 0.34 Z" />`,
};

function px(value) {
  return `${value.toFixed(1)}px`;
}

function box(x, y, w, h) {
  return `left:${px(x - w / 2)};top:${px(y - h / 2)};width:${px(w)};height:${px(h)};`;
}

function renderFace(control, style, pressed) {
  const glyph = style === 'xbox'
    ? html`<span style="font-size:${px(control.h * 0.5)}">${buttonLabel(style, control.name)}</span>`
    : html`<svg viewBox="-1 -1 2 2">${PS_GLYPHS[control.name]}</svg>`;
  return html`
    <div class="pad-face pad-${control.name} ${pressed ? 'pressed' : ''}"
      style="${box(control.x, control.y, control.w, control.h)}"
    >${glyph}</div>`;
}

function renderRect(control, style, pressed) {
  return html`
    <div class="pad-${control.shape} ${pressed ? 'pressed' : ''}"
      style="${box(control.x, control.y, control.w, control.h)}"
    ><span style="font-size:${px(control.h * (control.shape === 'pill' ? 0.42 : 0.5))}"
      >${buttonLabel(style, control.name)}</span></div>`;
}

// A plus drawn as one outline, so no seams cross the hub, over four arms filled
// separately so each can show pressed on its own — a diagonal shows as the two
// arms it presses. Each arm carries a small arrow pointing outward.
const DPAD_ARMS = [
  ['dpad/up', 'M-0.32 -0.98 H0.32 V-0.32 H-0.32 Z', 'M0 -0.82 L0.15 -0.6 L-0.15 -0.6 Z'],
  ['dpad/down', 'M-0.32 0.32 H0.32 V0.98 H-0.32 Z', 'M0 0.82 L0.15 0.6 L-0.15 0.6 Z'],
  ['dpad/left', 'M-0.98 -0.32 H-0.32 V0.32 H-0.98 Z', 'M-0.82 0 L-0.6 0.15 L-0.6 -0.15 Z'],
  ['dpad/right', 'M0.32 -0.32 H0.98 V0.32 H0.32 Z', 'M0.82 0 L0.6 0.15 L0.6 -0.15 Z'],
];
const DPAD_OUTLINE = 'M-0.32 -0.98 H0.32 V-0.32 H0.98 V0.32 H0.32 V0.98 H-0.32 V0.32 H-0.98 V-0.32 H-0.32 Z';

function renderDpad(control, mask) {
  return html`
    <div class="pad-dpad" style="${box(control.x, control.y, control.r * 2, control.r * 2)}">
      <svg viewBox="-1 -1 2 2">
        <rect class="pad-dpad-hub" x="-0.32" y="-0.32" width="0.64" height="0.64" />
        ${DPAD_ARMS.map(([name, arm, arrow]) => svg`
          <g class="${mask & (1 << GAMEPAD_BIT[name]) ? 'pressed' : ''}">
            <path class="pad-dpad-arm" d="${arm}" />
            <path class="pad-dpad-arrow" d="${arrow}" />
          </g>`)}
        <path class="pad-dpad-outline" d="${DPAD_OUTLINE}" />
      </svg>
    </div>`;
}

// The knob is positioned by the player straight through the DOM (see
// `data-r`), never through this template: it moves on every pointermove, and a
// lit render per move is the cost the rings already avoid. Nothing here binds
// its transform, so a re-render leaves it where the thumb put it.
function renderStick(control) {
  const knob = control.r * 1.1;
  return html`
    <div class="pad-stick" data-stick="${control.name}" data-r="${control.r.toFixed(1)}"
      style="${box(control.x, control.y, control.r * 2, control.r * 2)}"
    >
      <div class="pad-knob" style="${box(control.r, control.r, knob, knob)}"></div>
    </div>`;
}

// `mask` is the pressed-button bitmask to draw; pass 0 to draw it at rest.
export function renderGamepad(layout, style, mask) {
  if (layout === null) {
    return nothing;
  }
  return html`
    <div class="gamepad gamepad-${style} gamepad-${layout.orientation}">
      ${layout.controls.map(control => {
        switch (control.kind) {
          case 'dpad':
            return renderDpad(control, mask);
          case 'stick':
            return renderStick(control);
          default:
            return control.shape === 'face'
              ? renderFace(control, style, mask & (1 << control.bit))
              : renderRect(control, style, mask & (1 << control.bit));
        }
      })}
    </div>`;
}
