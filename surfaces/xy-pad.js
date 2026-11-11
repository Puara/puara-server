// xy-pad — one big pad: where the finger is, and whether it is down.
//
// The smallest complete surface, written to be copied: start your own in
// surfaces/local/ from this file. Everything a surface can do is here once —
// params, outputs, drawing, input, a paint() hook — and nothing else.
// surfaces/README.md explains each part.
//
// OSC (with the `surface` stream on):
//   /puara/audience/<id>/xy-pad/position   ff  0..1, 0..1 (x right, y down)
//   /puara/audience/<id>/xy-pad/press      i   1 while a finger is down
// and the audience view:
//   /puara/audience/global/xy-pad/position ff  mean over every phone
//   /puara/audience/global/xy-pad/press/count i  phones pressing right now

export default {
  // what the dashboard's surface dropdown shows
  label: 'XY pad',
  description: 'One big pad: the finger position, and whether it is down.',

  // Dashboard controls for this surface, one row each. The values reach
  // render() and ctx.params() on every phone, live. Types: enum (with a list),
  // boolean, number (min/max/step), string, color.
  params: {
    color: { type: 'color', default: '#1b3a6b', label: 'pad colour' },
    label: { type: 'string', default: '', label: 'text on the pad' },
    hold: { type: 'boolean', default: false, label: 'hold position on release' },
  },

  // What the phone sends. `button` is 0/1 and leaves the phone the moment it
  // changes; `value` is `size` numbers and rides the sensor tick.
  outputs: {
    position: { type: 'value', size: 2 },
    press: { type: 'button' },
  },

  // Called once per phone (and once for the dashboard preview) with the tools
  // the host lends: lit's `html`, `svg` and `nothing`, and `params()` for the
  // current values. Surfaces are loaded at runtime, so they cannot `import`
  // lit themselves.
  create({ html, nothing, params }) {
    const CENTRE = [0.5, 0.5];
    let position = CENTRE;
    let finger = null; // the pointer that owns the pad; others are ignored

    // where the dot is drawn — by render() and, between renders, by paint()
    const dotStyle = feedback => `left:${position[0] * 100}%; top:${position[1] * 100}%; `
      + `opacity:${feedback && finger !== null ? 1 : 0.35};`;

    return {
      // The drawing, as a lit template, complete on its own: the dashboard
      // preview shows render() alone. Called whenever the phone re-renders —
      // not on every finger move (see paint()). `feedback` is false when the
      // operator has switched touch feedback off for a dark cue.
      render({ params: p, feedback }) {
        return html`
          <div class="xy-pad" style="position:absolute; inset:0; background:${p.color};">
            <div style="position:absolute; left:50%; top:0; bottom:0; border-left:1px solid rgba(255,255,255,0.15);"></div>
            <div style="position:absolute; top:50%; left:0; right:0; border-top:1px solid rgba(255,255,255,0.15);"></div>
            ${p.label
              ? html`<p style="position:absolute; top:12px; width:100%; margin:0; text-align:center; font-size:1.6rem; opacity:0.7;">${p.label}</p>`
              : nothing}
            <div class="xy-dot" style="position:absolute; width:56px; height:56px; margin:-28px 0 0 -28px; border-radius:50%; border:2px solid rgba(255,255,255,0.6); ${dotStyle(feedback)}"></div>
          </div>`;
      },

      // Fingers, in px inside the surface's own box, with that box's size.
      down(pointerId, x, y, width, height) {
        if (finger === null) {
          finger = pointerId;
          position = [x / width, y / height];
        }
      },

      move(pointerId, x, y, width, height) {
        if (pointerId === finger) {
          position = [Math.min(1, Math.max(0, x / width)), Math.min(1, Math.max(0, y / height))];
        }
      },

      up(pointerId) {
        if (pointerId === finger) {
          finger = null;
          if (!params().hold) {
            position = CENTRE;
          }
        }
      },

      // Every finger is gone at once (tab change, panic, surface switch). Must
      // leave read() at rest: whatever it returns next is sent as the release.
      clear() {
        finger = null;
        position = CENTRE;
      },

      // The current outputs, by name. Called after every finger event and on
      // every tick; the host sends only what changed.
      read() {
        return { position, press: finger === null ? 0 : 1 };
      },

      // Optional. Called after every finger event and render, with the
      // surface's root element: for drawing that follows the finger without a
      // full re-render.
      paint(root, { feedback }) {
        const dot = root.querySelector('.xy-dot');
        if (dot !== null) {
          dot.style.cssText += dotStyle(feedback);
        }
      },
    };
  },
};
