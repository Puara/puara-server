# Touch surfaces

What the audience's phone draws, and what it sends when touched. Each surface
is one JavaScript file here; the dashboard's **surface** dropdown lists them
all, and switching applies live to every phone.

| Folder | What goes there |
|---|---|
| `surfaces/` | the surfaces shipped with puara-server: `gamepad.js`, `xy-pad.js` |
| `surfaces/local/` | **your own.** Ignored by git, so a work in progress stays on your machine until you contribute it. A file here with the same name as a shipped one replaces it. |

`regions`, the coloured split, is built in rather than a file: it defines
`/puara/audience/<id>/region`, which keeps flowing whatever surface is drawn.

## Making one

1. Copy [`xy-pad.js`](xy-pad.js) to `surfaces/local/my-surface.js`. The file
   name is the surface's name and its OSC address: lowercase letters, digits
   and dashes, starting with a letter.
2. Edit and save. The server notices, checks the file and refreshes the
   dropdown; phones already on that surface reload it. No restart, no build.
   (Helper files a surface imports are cached by each phone until its page
   reloads; the surface file itself is always fetched fresh.)
3. Pick it on the dashboard. If it does not appear, the server's terminal says
   why (every problem in the file at once).

The touch streams (`touch`, `tap`, brush/rub, `button`, `region`) keep flowing
whatever is drawn. A surface adds its own outputs on top.

New to this? [`docs/CUSTOM-SURFACES.md`](../docs/CUSTOM-SURFACES.md) builds one
step by step, from a single button to a pad grid with dashboard settings. This
page is the reference.

## The file

A surface is an ES module whose default export is an object:

```js
export default {
  label: 'XY pad',                 // shown in the dropdown (default: file name)
  description: 'One big pad…',     // shown on the dashboard
  stylesheet: './my-surface/style.css',  // optional, relative to this file

  params: { … },                   // the dashboard's controls for it
  outputs: { … },                  // what it sends
  format({ outputs, params }) { }, // optional: its line in the phone's Data tab

  create(ctx) { return { … }; },   // the phone side
};
```

The server imports the file in Node to read `label`, `params` and `outputs`, so
**the top level must not touch the browser** (`window`, `document`): do that
inside `create()` and the functions it returns.

### `params` — the dashboard's controls

One row each on the dashboard, editable live; every phone gets the new values
at once. Starting values can go in `config/puara.yaml` under
`touch.surfaces.<name>`.

| `type` | Extra fields | Control |
|---|---|---|
| `enum` | `list: [...]` | dropdown |
| `boolean` | | toggle |
| `number` | `min`, `max`, `step` | number box |
| `string` | | text field |
| `color` | | colour picker (`#rrggbb`) |

Every param needs a `default` of its type; `label` is optional (default: the
key). Keys are lowercase letters, digits, `-` and `_`.

```js
params: {
  style: { type: 'enum', list: ['round', 'square'], default: 'round' },
  color: { type: 'color', default: '#1b3a6b', label: 'pad colour' },
},
```

### `outputs` — what it sends

| `type` | Value | Sent |
|---|---|---|
| `button` | `0` / `1` | the moment it changes, from the touch itself, so a tap shorter than a sensor tick is not lost. Up to 31 per surface. |
| `value` | `size` numbers (1–16, default 1) | with the sensor tick (`sensorRate`), only when changed |

Names are lowercase segments, `/` allowed: `press`, `stick/left`. With the
`surface` stream on (dashboard, Global controls), each becomes:

```
/puara/audience/<id>/<surface>/<output>       i  (button)  or  f…  (value)
/puara/audience/global/<surface>/<output>/count   phones holding a button
/puara/audience/global/<surface>/<output>         mean of a value over phones
```

A phone that disconnects, changes tab or switches surface sends its releases
(buttons to 0, values to wherever `clear()` leaves them), so nothing
downstream stays held.

Some names are taken because the address already exists (`touch`, `tap`,
`region`, `shake`, `button`, …); the server says so if you pick one.

### `create(ctx)` — the phone side

Called once per phone (and once for the dashboard preview). `ctx` lends what a
surface cannot import itself — it is loaded at runtime, not bundled:

- `ctx.html`, `ctx.svg`, `ctx.nothing` — [lit](https://lit.dev)'s templates
- `ctx.params()` — this surface's current param values

It returns an object:

| Function | Called | Does |
|---|---|---|
| `render({ width, height, params, feedback })` | on every re-render | returns the drawing as an `html` template, **complete on its own** — the dashboard preview shows `render()` alone. `width`/`height` in px; `feedback` false while the operator has touch feedback off (draw no pressed state then). |
| `down(pointerId, x, y, width, height)` | finger lands | `x`, `y` in px inside the surface |
| `move(pointerId, x, y, width, height)` | finger moves | |
| `up(pointerId)` | finger lifts | |
| `clear()` | every finger gone at once (tab change, panic, switch) | must leave `read()` at rest: what it returns next is sent as the release |
| `read()` | after every finger event and every tick | `{ <output>: value }`: `0`/`1` (or true/false) for a button, a number or an array of `size` numbers for a value. Missing or broken entries go out as 0. |
| `paint(root, { params, feedback })` *(optional)* | after every finger event and render | direct DOM updates between renders — e.g. moving a dot — which is cheaper than re-rendering on every move. `root` is the surface's container. |

Several fingers arrive with distinct `pointerId`s. The surface is
re-rendered whenever a button output changes and whenever the operator edits
a param; between those, use `paint()`.

The drawing sits inside the touch area, which is black, fills the phone above
the tab bar, and catches every finger: give your elements
`pointer-events: none` (the default inside the surface) and position them with
`position: absolute`. Keep it dark — a few hundred phones are a light source
inside the dome.

If a surface throws, the phone shows "This surface could not be shown" in its
place and logs the error to the browser console; the rest of the phone keeps
working.

## Examples

- [`xy-pad.js`](xy-pad.js) — the smallest complete surface: two params, a
  value and a button, `paint()` for the dot. Start here.
- [`gamepad.js`](gamepad.js) — a full controller: helpers in
  [`gamepad/`](gamepad/) imported relatively, its own stylesheet, a custom
  `format()` for the Data tab, multi-touch with fingers sliding between
  buttons.

## Contributing one back

Move it from `surfaces/local/` to `surfaces/`, add any helpers in a subfolder
of its own name, and open a pull request. Note its OSC addresses in
[`docs/NAMESPACE.md`](../docs/NAMESPACE.md).
