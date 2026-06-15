/* ===================================================================
   img2css — Web Worker
   Builds the heavy CSS string off the main thread so the terminal
   stays responsive. Receives raw RGBA pixel data + settings, emits
   progress, returns the assembled string for the chosen method.
   =================================================================== */

"use strict";

function hex2(n) {
  return n.toString(16).padStart(2, "0");
}

/* Format one pixel into a CSS color token. */
function formatColor(r, g, b, a, format) {
  if (format === "rgb") {
    return "rgb(" + r + "," + g + "," + b + ")";
  }
  if (format === "rgba") {
    // round alpha to 3 decimals, trim trailing zeros
    var av = a === 255 ? "1" : (a / 255).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    return "rgba(" + r + "," + g + "," + b + "," + av + ")";
  }
  // hex (default) — collapse to #rgb when each channel's nibbles match
  var rh = hex2(r), gh = hex2(g), bh = hex2(b);
  if (rh[0] === rh[1] && gh[0] === gh[1] && bh[0] === bh[1]) {
    return "#" + rh[0] + gh[0] + bh[0];
  }
  return "#" + rh + gh + bh;
}

/* Quantize a channel to `step` levels (reduce-colors option). */
function quant(v, step) {
  if (step <= 1) return v;
  var q = Math.round(v / step) * step;
  return q > 255 ? 255 : q;
}

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type !== "build") return;

  var px = new Uint8ClampedArray(msg.data); // RGBA bytes
  var width = msg.width;
  var height = msg.height;
  var blockSize = msg.blockSize || 1;
  var format = msg.format || "hex";
  var method = msg.method || "boxshadow";
  var step = msg.reduce && msg.reduce > 1 ? msg.reduce : 0;
  var alphaThreshold = msg.alphaThreshold || 0; // skip pixels with a <= threshold

  var total = height; // progress measured by rows
  var lastPct = -1;
  var kept = 0;

  function reportRow(y) {
    var pct = Math.floor(((y + 1) / total) * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      self.postMessage({ type: "progress", pct: pct });
    }
  }

  if (method === "grid") {
    /* one <div> per pixel; transparent pixels stay empty so the grid
       keeps its shape. Color is set inline (grid is the "less pure"
       secondary method, by design). */
    var cells = new Array(width * height);
    var ci = 0;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var i = (y * width + x) * 4;
        var a = px[i + 3];
        if (a <= alphaThreshold) {
          cells[ci++] = "<div></div>";
          continue;
        }
        var r = quant(px[i], step);
        var g = quant(px[i + 1], step);
        var b = quant(px[i + 2], step);
        cells[ci++] = '<div style="background:' + formatColor(r, g, b, a, format) + '"></div>';
        kept++;
      }
      reportRow(y);
    }
    self.postMessage({ type: "done", method: "grid", value: cells.join(""), count: kept });
    return;
  }

  /* default: single-element box-shadow */
  var parts = [];
  for (var yy = 0; yy < height; yy++) {
    for (var xx = 0; xx < width; xx++) {
      var idx = (yy * width + xx) * 4;
      var aa = px[idx + 3];
      if (aa <= alphaThreshold) continue; // transparent pixels add nothing
      var rr = quant(px[idx], step);
      var gg = quant(px[idx + 1], step);
      var bb = quant(px[idx + 2], step);
      var ox = xx * blockSize;
      var oy = yy * blockSize;
      parts.push(ox + "px " + oy + "px 0 0 " + formatColor(rr, gg, bb, aa, format));
      kept++;
    }
    reportRow(yy);
  }

  self.postMessage({
    type: "done",
    method: "boxshadow",
    value: parts.join(",\n    "),
    count: kept,
  });
};
