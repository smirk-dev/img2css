# img2css

An in-browser **terminal** that converts an image into **pure CSS** — the whole
image is rendered by a single `<div>` whose `box-shadow` paints one entry per
pixel. No `<img>`, no `<canvas>`, no JavaScript in the *output*: just one element
styled by CSS.

100% client-side. No backend, no build step, no runtime dependencies. Open
`index.html` directly, or deploy the folder to any static host (GitHub Pages,
Netlify, …).

```
/index.html
/css/terminal.css     terminal look + phosphor themes
/js/terminal.js       scrollback, input loop, history, autocomplete, drag-drop, preview
/js/commands.js       command registry + parsing
/js/converter.js      image → pixels → CSS orchestration + guardrails (+ inline worker)
/js/worker.js         standalone off-thread string builder (used when served)
```

## Use it

Open `index.html` and type `help`. Drag an image anywhere onto the window (or
`upload`), then `convert`, then `preview` / `copy` / `export html`.

### Commands

| Command | What it does |
|---|---|
| `help` | list commands |
| `upload` / `open` | open the file picker (drag-drop works too) |
| `info` | loaded image, target resolution, projected shadow count + size |
| `set res <n\|original>` | output **width** in px (height auto-scales) |
| `set blocksize <n>` | render each pixel as an `n×n` block |
| `set format <hex\|rgb\|rgba>` | color format (`rgba` preserves partial transparency) |
| `set method <boxshadow\|grid>` | conversion method (box-shadow is the pure default) |
| `set smoothing <on\|off>` | canvas smoothing when scaling (off = crisp pixels) |
| `set reduce <n>` | quantize color channels to multiples of `n` (smaller output) |
| `convert [--force]` | build the CSS off-thread; `--force` skips the big-count confirm |
| `preview [--force]` | render the generated CSS next to the original |
| `copy` | copy the CSS to the clipboard |
| `export css` / `export html` | download a `.css`, or a self-contained `.html` |
| `theme <green\|amber\|white\|matrix>` | switch phosphor theme |
| `clear` | clear the scrollback |

History with ↑/↓, `Tab` autocompletes command names.

## Guardrails

Shadow count = `width × height`, so it grows quadratically. The tool:

- suggests a safe resolution on upload (longest side clamped to ~150px),
- shows the live projected shadow count + estimated CSS size,
- warns above ~50,000 shadows and **requires confirmation** above ~250,000,
- builds the string in a **Web Worker** so the terminal stays responsive,
- gates the live `preview` for very large outputs (export still works).

## How the conversion works

The image is drawn to an offscreen canvas scaled to the target resolution, then
`getImageData()` is iterated. Each non-transparent pixel `(x, y)` becomes a
shadow `x*blockSize px  y*blockSize px  0 0  color`. The element is
`background: transparent` so the `0 0` shadow shows; fully transparent pixels are
skipped. The result:

```css
.img2css {
  width: 1px; height: 1px; background: transparent;
  box-shadow: 0px 0px 0 0 #f00, 1px 0px 0 0 #1b1b1d, /* …one per pixel… */ ;
}
```
```html
<div class="img2css"></div>
```

> The off-thread builder lives in `js/worker.js` and is loaded directly when the
> app is served over http(s). When `index.html` is opened straight from
> `file://` (where browsers block external worker scripts), the identical builder
> is run from an inline Blob worker instead, with a main-thread fallback — so
> conversion works in every context.

## Verification

`_test/` holds the harness used to verify the build (not needed at runtime):

```bash
node _test/harness.js                       # core conversion logic (Node)
node _test/cdp-run.js <url>?worker=1         # full end-to-end in headless Chrome
```
