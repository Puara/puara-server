# Creating a custom touch surface

A **touch surface** is what an audience member's phone shows on its *Jouer /
Play* tab, and what it sends when they touch it. puara-server ships three:
the coloured `regions`, a `gamepad` and an `xy-pad`. This guide walks you
through making your own, from a single button to a 2×2 pad grid with its own
dashboard settings, in about half an hour.

You need to know a little JavaScript: variables, functions, objects. You do not
need to know soundworks, lit or anything else inside puara-server.

The short reference for everything here is
[`surfaces/README.md`](../surfaces/README.md).

## How it fits together

```
 surfaces/local/pads.js            (your file)
        │
        ├── read by the server ──> the dashboard: "pads" in the surface list,
        │                          with the settings your file declares
        │
        └── loaded by each phone ─> draws the pads, turns fingers into outputs
                                         │
                                         ▼
                 bridge ──> OSC   /puara/audience/<id>/pads/pad/2   i 1
                                  /puara/audience/<id>/pads/height  f 0.8
                                  /puara/audience/global/pads/pad/2/count  i 37
```

A surface is **one JavaScript file**. It says three things:

- **what the dashboard offers** for it (`params`) — colours, toggles, lists;
- **what it sends** (`outputs`) — buttons that are pressed or not, and values
  that are numbers;
- **how a phone draws it and reads fingers off it** (`create`).

Everything else — getting touches from the phone, sending them to the server,
turning them into OSC, releasing held buttons when a phone drops out — is done
for you. The usual touch streams (`touch`, `tap`, `brush`, `region`…) keep
flowing whatever surface is drawn; yours adds its own addresses on top.

## Before you start

- puara-server installed and running: `./scripts/start.sh`
  (`scripts\start.cmd` on Windows).
- The dashboard open at `https://<server>:8000/controller`, with the big
  button at the top switched to **RUNNING** — phones send nothing while it is
  stopped.
- Something to touch:
  - a phone on the same network, as the audience would; or
  - a desktop browser at `https://<server>:8000/` — the mouse works as one
    finger, and the browser's developer tools show any error; or
  - the dashboard's preview, which shows the look without touch.
- Something to watch the OSC: `oscdump 9000`, ossia score, or the phone's own
  *Données / Data* tab, which has a row named after your surface showing what
  it sends.
- A text editor.

Your files go in **`surfaces/local/`**. That folder is ignored by git, so your
work in progress stays on your machine.

## Step 1 — the smallest surface: one big button

Create `surfaces/local/hello.js`:

```js
export default {
  label: 'Hello',

  outputs: {
    press: { type: 'button' },
  },

  create({ html }) {
    const fingers = new Set(); // the pointerIds currently on the screen

    return {
      render() {
        return html`<div style="position:absolute; inset:0; background:#1b3a6b;"></div>`;
      },
      down(pointerId) {
        fingers.add(pointerId);
      },
      move() {},
      up(pointerId) {
        fingers.delete(pointerId);
      },
      clear() {
        fingers.clear();
      },
      read() {
        return { press: fingers.size > 0 ? 1 : 0 };
      },
    };
  },
};
```

Save it. The server's terminal prints the new list:

```
Touch surfaces: regions (built in), gamepad, xy-pad, hello (local)
```

On the dashboard, pick **Hello — hello (local)** in the *Touch surface* panel.
Every phone switches to a blue screen. Touch it, and OSC shows:

```
/puara/audience/0/hello/press 1
/puara/audience/0/hello/press 0
```

What each part does:

- **The file name is the surface's name** — `hello.js` is `hello`, which is
  also the OSC address. Lowercase letters, digits and dashes, starting with a
  letter.
- **`label`** is how the dashboard lists it.
- **`outputs`** declares what the surface sends. `press` is a `button`: it is
  `1` or `0`, and it leaves the phone the instant it changes, so even a very
  short tap reaches OSC.
- **`create({ html })`** runs once on each phone and returns the functions the
  phone calls:
  - `render()` returns the drawing. `html` is a template tag: write HTML inside
    the backticks, and put values in with `${…}`. Use
    `position:absolute; inset:0` to fill the touch area.
  - `down`, `move` and `up` get each finger as it lands, moves and lifts. Every
    finger has its own `pointerId`, so two fingers are told apart.
  - `clear()` is called when every finger is gone at once — the phone changed
    tab, the operator paused the show, or switched surface. Afterwards `read()`
    must say "nothing pressed": whatever it returns is sent as the release.
  - `read()` returns the current value of every output, by name.

The `Set` of fingers is why lifting one of two fingers does not release the
button: it is pressed while *any* finger is down.

## Step 2 — four pads

Now a grid of four pads, each its own button, with a finger able to slide from
one to the next. Create `surfaces/local/pads.js`; the complete file is at the
end of this step-by-step, and the pieces are explained here.

Four buttons, named `pad/0` to `pad/3`. A `/` in an output name becomes a `/`
in the OSC address, so they arrive as `/puara/audience/<id>/pads/pad/2`:

```js
  outputs: {
    'pad/0': { type: 'button' },
    'pad/1': { type: 'button' },
    'pad/2': { type: 'button' },
    'pad/3': { type: 'button' },
```

Instead of a set of fingers, a map from each finger to the pad under it:

```js
    const fingers = new Map(); // pointerId -> the pad under that finger
```

`down` and `move` receive the finger's position in pixels, `x` from the left
and `y` from the top, together with the size of the touch area. A pad is
pressed while any finger is on it, and a finger that moves is re-checked, so it
can slide from pad 2 to pad 3 without lifting:

```js
    // which pad a point is on: 0 1 on top, 2 3 below
    function padAt(x, y, width, surfaceHeight) {
      return (y < surfaceHeight / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1);
    }
```

```js
      move(pointerId, x, y, width, surfaceHeight) {
        if (fingers.has(pointerId)) {
          fingers.set(pointerId, padAt(x, y, width, surfaceHeight));
          height = heightOn(y, surfaceHeight);
        }
      },
```

`read()` reports each pad by name:

```js
      read() {
        const outputs = { height };
        for (const pad of PADS) {
          outputs[`pad/${pad}`] = isPressed(pad) ? 1 : 0;
        }
        return outputs;
      },
```

**A pressed pad lights up without any extra work.** Whenever one of your
`button` outputs changes, the phone calls `render()` again, so drawing the
pressed state from the same `isPressed()` keeps the screen and the OSC in
agreement.

## Step 3 — settings on the dashboard

`params` declares the controls the dashboard shows for your surface. Here, two
colours and a toggle:

```js
  params: {
    color: { type: 'color', default: '#1b3a6b', label: 'pad colour' },
    lit: { type: 'color', default: '#2f5f9e', label: 'pressed colour' },
    numbers: { type: 'boolean', default: true, label: 'show numbers' },
  },
```

The values arrive in `render()` as `params`. Changing one on the dashboard
redraws every phone at once:

```js
      render({ params, feedback }) {
        return html`
          <div style="position:absolute; inset:0; display:grid; gap:4px;
                      grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr;">
            ${PADS.map(pad => html`
              <div style="display:flex; align-items:center; justify-content:center;
                          font-size:3rem; color:rgba(255,255,255,0.5);
                          background:${feedback && isPressed(pad) ? params.lit : params.color};">
                ${params.numbers ? pad : nothing}
              </div>`)}
          </div>`;
      },
```

- `PADS.map(pad => html\`…\`)` draws one pad per entry.
- `nothing` (from `create({ html, nothing })`) draws nothing at all — here,
  no number when the toggle is off.
- `feedback` is `false` when the operator has switched *touch feedback* off,
  for a cue that needs the seats dark: do not light anything up then.

The kinds of control:

| `type` | Extra | Dashboard control |
|---|---|---|
| `enum` | `list: ['a', 'b']` | dropdown |
| `boolean` | | toggle |
| `number` | `min`, `max`, `step` | number box |
| `string` | | text field |
| `color` | | colour picker, `#rrggbb` |

Each needs a `default`; `label` is what the dashboard shows. Outside `render()`,
read the current values with `ctx.params()` — `create({ html, params })`, then
`params().numbers`.

To start a show with other values than the defaults, put them in
`config/puara.yaml`:

```yaml
touch:
  surface: pads
  surfaces:
    pads:
      color: '#3a1b6b'
      numbers: false
```

## Step 4 — a continuous value

Buttons say *whether*; values say *how much*. The pads also send how high the
finger sits on its pad, from `0` at the bottom edge to `1` at the top:

```js
    height: { type: 'value' },
```

```js
    // 0 at the bottom edge of the pad, 1 at its top edge
    function heightOn(y, surfaceHeight) {
      const padHeight = surfaceHeight / 2;
      const top = y < padHeight ? 0 : padHeight;
      return Math.min(1, Math.max(0, 1 - (y - top) / padHeight));
    }
```

A value is sent with the phone's sensor tick (`sensorRate`, set on the
dashboard), and only when it changed. It can hold several numbers at once —
`{ type: 'value', size: 2 }` with `read()` returning `[x, y]`, as the
`xy-pad` does for its position.

When the last finger lifts, `up()` sets `height` back to `0`, so a patch
reading it does not stay on the last position. Decide what "at rest" means for
your own values, and return to it in `up()` and `clear()`.

## The complete file

`surfaces/local/pads.js`:

```js
// pads — four pads in a 2×2 grid. Each pad is a button; how high the finger
// sits on its pad is a value. Built step by step in docs/CUSTOM-SURFACES.md.

export default {
  label: 'Pads',
  description: 'Four pads in a 2×2 grid: each one a button, plus the finger height.',

  params: {
    color: { type: 'color', default: '#1b3a6b', label: 'pad colour' },
    lit: { type: 'color', default: '#2f5f9e', label: 'pressed colour' },
    numbers: { type: 'boolean', default: true, label: 'show numbers' },
  },

  outputs: {
    'pad/0': { type: 'button' },
    'pad/1': { type: 'button' },
    'pad/2': { type: 'button' },
    'pad/3': { type: 'button' },
    height: { type: 'value' },
  },

  create({ html, nothing }) {
    const PADS = [0, 1, 2, 3];
    const fingers = new Map(); // pointerId -> the pad under that finger
    let height = 0;

    // which pad a point is on: 0 1 on top, 2 3 below
    function padAt(x, y, width, surfaceHeight) {
      return (y < surfaceHeight / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1);
    }

    // 0 at the bottom edge of the pad, 1 at its top edge
    function heightOn(y, surfaceHeight) {
      const padHeight = surfaceHeight / 2;
      const top = y < padHeight ? 0 : padHeight;
      return Math.min(1, Math.max(0, 1 - (y - top) / padHeight));
    }

    function isPressed(pad) {
      return [...fingers.values()].includes(pad);
    }

    return {
      render({ params, feedback }) {
        return html`
          <div style="position:absolute; inset:0; display:grid; gap:4px;
                      grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr;">
            ${PADS.map(pad => html`
              <div style="display:flex; align-items:center; justify-content:center;
                          font-size:3rem; color:rgba(255,255,255,0.5);
                          background:${feedback && isPressed(pad) ? params.lit : params.color};">
                ${params.numbers ? pad : nothing}
              </div>`)}
          </div>`;
      },

      down(pointerId, x, y, width, surfaceHeight) {
        fingers.set(pointerId, padAt(x, y, width, surfaceHeight));
        height = heightOn(y, surfaceHeight);
      },

      move(pointerId, x, y, width, surfaceHeight) {
        if (fingers.has(pointerId)) {
          fingers.set(pointerId, padAt(x, y, width, surfaceHeight));
          height = heightOn(y, surfaceHeight);
        }
      },

      up(pointerId) {
        fingers.delete(pointerId);
        if (fingers.size === 0) {
          height = 0;
        }
      },

      clear() {
        fingers.clear();
        height = 0;
      },

      read() {
        const outputs = { height };
        for (const pad of PADS) {
          outputs[`pad/${pad}`] = isPressed(pad) ? 1 : 0;
        }
        return outputs;
      },
    };
  },
};
```

Touching low on pad 2, sliding up onto pad 3 and lifting sends:

```
/puara/audience/0/pads/pad/2 1
/puara/audience/0/pads/height 0.2
/puara/audience/0/pads/pad/2 0
/puara/audience/0/pads/pad/3 1
/puara/audience/0/pads/height 0.8
/puara/audience/0/pads/pad/3 0
/puara/audience/0/pads/height 0
```

## Using it in a patch

With the `surface` stream switched on (dashboard → *Global controls*), every
phone sends, under its own number `<id>`:

| Address | Type | Meaning |
|---|---|---|
| `/puara/audience/<id>/pads/pad/<n>` | `i` | `1` when pad `n` is pressed, `0` when released |
| `/puara/audience/<id>/pads/height` | `f` | finger height on its pad, `0`–`1` |

and, for the whole audience, at the bridge tick:

| Address | Type | Meaning |
|---|---|---|
| `/puara/audience/global/pads/pad/<n>/count` | `i` | how many phones are pressing pad `n` right now |
| `/puara/audience/global/pads/height` | `f` | the average height over the phones showing the pads |

The dashboard lists your surface's addresses under its controls. A phone that
disconnects, changes tab or is switched to another surface sends its releases,
so nothing in the patch stays held.

## Testing and fixing

**The server tells you what is wrong.** Save a file with a mistake and the
terminal says which, all at once — the other surfaces keep working:

```
[puara] surfaces: surfaces/local/pads.js left out: pads: param "lit": default "blue" does not fit type color; output "Pad 4": use lowercase segments separated by /
[puara] surfaces: surfaces/local/touch.js left out: touch: "touch" is reserved — it would collide with an existing OSC address
[puara] surfaces: surfaces/local/oops.js left out: Unexpected token ';'
```

**On the phone**, a surface that crashes is replaced by *"Cette surface n'a pas
pu s'afficher / This surface could not be shown"*, and the error goes to the
browser console. The quickest way to read it is a desktop browser at
`https://<server>:8000/` with its developer tools open. On an iPhone, use
Safari's Web Inspector over USB; on Android, `chrome://inspect`.

**The phone's Data tab** has a row named after your surface with what it is
sending, and a small copy of the surface to touch while watching it.

**Several phones at once** without the phones: open
`https://<server>:8000/?emulate=6` in a desktop browser.

**Edits are live.** Save the file and the phones showing it reload it. If your
surface imports helper files of its own (`import … from './pads/geometry.js'`),
phones keep their copy of those until the page is reloaded.

## Rules of thumb

- **Do not use `window` or `document` at the top of the file.** The server
  imports your file to read its name, settings and outputs, and the server has
  no browser. Inside `create()` and the functions it returns is fine.
- **Do not `import 'lit'`**, or anything from puara-server's own code: a
  surface is loaded by the phone at runtime. Use what `create()` hands you
  (`html`, `svg`, `nothing`, `params`). Importing your own files with a
  relative path (`./my-surface/helpers.js`) works.
- **Outputs are fixed.** Declare every output the surface can ever send; a
  setting can hide some of them on screen, but not remove them. At most 31
  buttons, and a value holds at most 16 numbers.
- **`render()` draws everything on its own** — the dashboard preview shows
  `render()` alone. For something that follows the finger on every move, like
  the `xy-pad`'s dot, add a `paint(root)` function that updates the drawing
  directly (see [`surfaces/xy-pad.js`](../surfaces/xy-pad.js)): re-rendering
  on every move is too slow on a phone.
- **Make targets big.** People play these without looking at the screen. Make
  the area that reacts larger than what is drawn, and leave no dead gaps
  between buttons — the `gamepad`'s face buttons are read by direction from
  their centre for exactly this reason.
- **Keep it dark.** A few hundred phones are a light source inside the dome.
  Dim colours, and darken rather than brighten what is pressed.
- **Position with `position:absolute`.** The touch area fills the phone above
  the tab bar, and your drawing should not catch touches itself — that is the
  default inside a surface.
- **A stylesheet** can live beside your file: `stylesheet: './pads/pads.css'`
  in the export, as the `gamepad` does.

## Sharing it

To make your surface part of puara-server, move it from `surfaces/local/` to
`surfaces/` (helpers in a subfolder of the same name), add its addresses to
[`docs/NAMESPACE.md`](NAMESPACE.md), and open a pull request.
