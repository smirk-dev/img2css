/* ===================================================================
   img2css — converter / orchestration
   Holds image + settings state, reads pixels via Canvas, and drives
   the Web Worker that builds the CSS. Exposes a singleton: window.Converter
   =================================================================== */

(function () {
  "use strict";

  // performance guardrails (shadow counts)
  var WARN_COUNT = 50000; // "may render slowly"
  var FORCE_COUNT = 250000; // require explicit confirmation / --force
  var PREVIEW_COUNT = 150000; // above this, don't auto-render live preview
  var DEFAULT_MAX_SIDE = 150; // smart default clamps longest side to this

  /* -------------------------------------------------------------------
     coreBuild — the heavy string builder. Single source of truth.
     It is (a) serialized into an inline Blob Worker (so the app works
     even when index.html is opened directly via file://, where loading
     an external worker script is blocked), and (b) called directly on
     the main thread as a last-resort fallback. The standalone
     js/worker.js mirrors this and is used when the app is served.
     Must stay self-contained (no closure refs) so .toString() works.
     ------------------------------------------------------------------- */
  function coreBuild(px, width, height, blockSize, format, method, reduce, alphaThreshold, post) {
    function hex2(n) { return n.toString(16).padStart(2, "0"); }
    function fmt(r, g, b, a) {
      if (format === "rgb") return "rgb(" + r + "," + g + "," + b + ")";
      if (format === "rgba") {
        var av = a === 255 ? "1" : (a / 255).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
        return "rgba(" + r + "," + g + "," + b + "," + av + ")";
      }
      var rh = hex2(r), gh = hex2(g), bh = hex2(b);
      if (rh[0] === rh[1] && gh[0] === gh[1] && bh[0] === bh[1]) return "#" + rh[0] + gh[0] + bh[0];
      return "#" + rh + gh + bh;
    }
    function q(v) {
      if (!reduce || reduce <= 1) return v;
      var x = Math.round(v / reduce) * reduce;
      return x > 255 ? 255 : x;
    }
    var lastPct = -1, kept = 0, x, y, i, a;
    function row(yy) {
      var pct = Math.floor(((yy + 1) / height) * 100);
      if (pct !== lastPct) { lastPct = pct; if (post) post(pct); }
    }
    if (method === "grid") {
      var cells = new Array(width * height), ci = 0;
      for (y = 0; y < height; y++) {
        for (x = 0; x < width; x++) {
          i = (y * width + x) * 4; a = px[i + 3];
          if (a <= alphaThreshold) { cells[ci++] = "<div></div>"; continue; }
          cells[ci++] = '<div style="background:' + fmt(q(px[i]), q(px[i + 1]), q(px[i + 2]), a) + '"></div>';
          kept++;
        }
        row(y);
      }
      return { value: cells.join(""), count: kept, method: "grid" };
    }
    var parts = [];
    for (y = 0; y < height; y++) {
      for (x = 0; x < width; x++) {
        i = (y * width + x) * 4; a = px[i + 3];
        if (a <= alphaThreshold) continue;
        parts.push(x * blockSize + "px " + y * blockSize + "px 0 0 " + fmt(q(px[i]), q(px[i + 1]), q(px[i + 2]), a));
        kept++;
      }
      row(y);
    }
    return { value: parts.join(",\n    "), count: kept, method: "boxshadow" };
  }

  // Worker source assembled from coreBuild — used for the inline Blob worker.
  var WORKER_SRC =
    'self.onmessage=function(e){var d=e.data;var build=' + coreBuild.toString() + ";" +
    "var r=build(new Uint8ClampedArray(d.data),d.width,d.height,d.blockSize,d.format,d.method,d.reduce,d.alphaThreshold," +
    'function(p){self.postMessage({type:"progress",pct:p});});' +
    'self.postMessage({type:"done",method:r.method,value:r.value,count:r.count});};';

  function makeWorker() {
    if (typeof Worker === "undefined") return null;
    var served = typeof location !== "undefined" && location.protocol !== "file:";
    // When served over http(s), use the standalone js/worker.js as written.
    if (served) {
      try { return new Worker("js/worker.js"); } catch (e) { /* fall back to blob */ }
    }
    // file:// (or external load failed) -> inline blob worker.
    try {
      var url = URL.createObjectURL(new Blob([WORKER_SRC], { type: "application/javascript" }));
      var w = new Worker(url);
      w._blobUrl = url;
      return w;
    } catch (e) {
      return null;
    }
  }

  var Converter = {
    // ---- loaded image ----
    image: null, // HTMLImageElement
    filename: null,
    fileSize: 0,
    originalW: 0,
    originalH: 0,
    objectUrl: null,

    // ---- settings ----
    settings: {
      res: 150, // target output WIDTH in px (height auto)
      blockSize: 1,
      format: "hex", // hex | rgb | rgba
      method: "boxshadow", // boxshadow | grid
      smoothing: false, // imageSmoothingEnabled when scaling
      reduce: 0, // color quantization step (0 = off)
    },

    // ---- last conversion result ----
    result: null,

    // expose thresholds for the UI
    limits: {
      WARN: WARN_COUNT,
      FORCE: FORCE_COUNT,
      PREVIEW: PREVIEW_COUNT,
    },

    hasImage: function () {
      return !!this.image;
    },

    /* -----------------------------------------------------------------
       Load a File (from picker or drag-drop). Resolves with info.
       Also picks a safe default resolution.
       ----------------------------------------------------------------- */
    loadFile: function (file) {
      var self = this;
      return new Promise(function (resolve, reject) {
        if (!file || !/^image\//.test(file.type)) {
          reject(new Error("not an image file"));
          return;
        }
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          if (self.objectUrl) URL.revokeObjectURL(self.objectUrl);
          self.image = img;
          self.objectUrl = url;
          self.filename = file.name;
          self.fileSize = file.size;
          self.originalW = img.naturalWidth;
          self.originalH = img.naturalHeight;
          self.result = null;

          // smart default: clamp longest side to DEFAULT_MAX_SIDE
          var longest = Math.max(img.naturalWidth, img.naturalHeight);
          if (longest <= DEFAULT_MAX_SIDE) {
            self.settings.res = img.naturalWidth;
          } else {
            var scale = DEFAULT_MAX_SIDE / longest;
            self.settings.res = Math.max(1, Math.round(img.naturalWidth * scale));
          }
          resolve(self.info());
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error("could not decode image"));
        };
        img.src = url;
      });
    },

    /* Target dimensions for the current resolution setting. */
    targetDims: function () {
      if (!this.image) return { w: 0, h: 0 };
      var w = Math.max(1, Math.round(this.settings.res));
      var ratio = this.originalH / this.originalW;
      var h = Math.max(1, Math.round(w * ratio));
      return { w: w, h: h };
    },

    /* Projected pixel/shadow count + rough byte estimate. */
    estimate: function () {
      var d = this.targetDims();
      var count = d.w * d.h; // upper bound (before transparent skips)
      // rough bytes per box-shadow entry by format
      var per = this.settings.format === "rgba" ? 30 : this.settings.format === "rgb" ? 24 : 20;
      var bytes = count * per;
      return { w: d.w, h: d.h, count: count, bytes: bytes };
    },

    info: function () {
      var est = this.estimate();
      return {
        filename: this.filename,
        fileSize: this.fileSize,
        originalW: this.originalW,
        originalH: this.originalH,
        targetW: est.w,
        targetH: est.h,
        count: est.count,
        bytes: est.bytes,
        settings: Object.assign({}, this.settings),
      };
    },

    /* -----------------------------------------------------------------
       Read pixels at target resolution via an offscreen canvas.
       Returns { data: Uint8ClampedArray, width, height }.
       ----------------------------------------------------------------- */
    readPixels: function () {
      var d = this.targetDims();
      var canvas = document.createElement("canvas");
      canvas.width = d.w;
      canvas.height = d.h;
      var ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingEnabled = !!this.settings.smoothing;
      ctx.clearRect(0, 0, d.w, d.h);
      ctx.drawImage(this.image, 0, 0, d.w, d.h);
      var imgData = ctx.getImageData(0, 0, d.w, d.h);
      return { data: imgData.data, width: d.w, height: d.h };
    },

    /* -----------------------------------------------------------------
       Run a conversion. opts: { onProgress(pct), onStart(meta) }
       Resolves with the full result object.
       ----------------------------------------------------------------- */
    convert: function (opts) {
      opts = opts || {};
      var self = this;
      if (!this.image) return Promise.reject(new Error("no image loaded"));

      var pixels = this.readPixels();
      var s = this.settings;
      var started = performance.now();
      if (opts.onStart) opts.onStart({ width: pixels.width, height: pixels.height });

      function elapsed() {
        return (typeof performance !== "undefined" ? performance.now() : 0) - started;
      }

      return new Promise(function (resolve, reject) {
        var settled = false;

        function finish(m) {
          if (settled) return;
          settled = true;
          var result = self._assemble(m, pixels.width, pixels.height, elapsed());
          self.result = result;
          resolve(result);
        }

        // Last-resort: build on the main thread (deferred so the progress
        // line paints first). Bounded by the resolution guardrails.
        function mainThread() {
          try {
            var r = coreBuild(
              pixels.data, pixels.width, pixels.height,
              s.blockSize, s.format, s.method, s.reduce, 0,
              function (p) { if (opts.onProgress) opts.onProgress(p); }
            );
            finish(r);
          } catch (err) {
            if (!settled) { settled = true; reject(err); }
          }
        }

        var worker = makeWorker();
        if (!worker) {
          setTimeout(mainThread, 0);
          return;
        }

        worker.onmessage = function (ev) {
          var m = ev.data;
          if (m.type === "progress") {
            if (opts.onProgress) opts.onProgress(m.pct);
          } else if (m.type === "done") {
            if (worker._blobUrl) URL.revokeObjectURL(worker._blobUrl);
            worker.terminate();
            finish(m);
          }
        };
        worker.onerror = function () {
          if (settled) return;
          if (worker._blobUrl) URL.revokeObjectURL(worker._blobUrl);
          worker.terminate();
          setTimeout(mainThread, 0); // degrade gracefully to main thread
        };

        // Structured-clone (no transfer) so the buffer survives for the
        // main-thread fallback if the worker errors out.
        worker.postMessage({
          type: "build",
          data: pixels.data.buffer,
          width: pixels.width,
          height: pixels.height,
          blockSize: s.blockSize,
          format: s.format,
          method: s.method,
          reduce: s.reduce,
          alphaThreshold: 0,
        });
      });
    },

    // exposed for the test harness (parity check vs js/worker.js)
    _coreBuild: coreBuild,

    /* Assemble worker output into CSS / HTML artifacts + stats. */
    _assemble: function (m, width, height, timeMs) {
      var s = this.settings;
      var bs = s.blockSize;
      var header =
        "/* Generated by img2css — " +
        width +
        "×" +
        height +
        " px, " +
        m.count +
        " pixels, " +
        m.method +
        " method, " +
        s.format +
        " color */";

      var cssRule, htmlBody;

      if (m.method === "grid") {
        cssRule =
          ".img2css-grid {\n" +
          "  display: grid;\n" +
          "  grid-template-columns: repeat(" + width + ", " + bs + "px);\n" +
          "  grid-template-rows: repeat(" + height + ", " + bs + "px);\n" +
          "  width: " + width * bs + "px;\n" +
          "  height: " + height * bs + "px;\n" +
          "  line-height: 0;\n" +
          "}\n" +
          ".img2css-grid > div { width: " + bs + "px; height: " + bs + "px; }";
        htmlBody = '<div class="img2css-grid">' + m.value + "</div>";
      } else {
        cssRule =
          ".img2css {\n" +
          "  width: " + bs + "px;\n" +
          "  height: " + bs + "px;\n" +
          "  background: transparent;\n" +
          "  box-shadow:\n    " +
          m.value +
          ";\n}";
        htmlBody = '<div class="img2css"></div>';
      }

      var fullCss = header + "\n" + cssRule + "\n";
      var fullHtml = this._buildHtmlDoc(header, cssRule, htmlBody, width, height);
      var sizeBytes = byteLen(fullCss);

      return {
        method: m.method,
        width: width,
        height: height,
        blockSize: bs,
        format: s.format,
        count: m.count,
        cssRule: cssRule,
        htmlBody: htmlBody,
        fullCss: fullCss,
        fullHtml: fullHtml,
        sizeBytes: sizeBytes,
        htmlBytes: byteLen(fullHtml),
        timeMs: Math.round(timeMs),
        previewSafe: m.count <= PREVIEW_COUNT,
      };
    },

    _buildHtmlDoc: function (header, cssRule, htmlBody, width, height) {
      return (
        "<!DOCTYPE html>\n" +
        '<html lang="en">\n' +
        "<head>\n" +
        '<meta charset="utf-8">\n' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        "<title>img2css output (" + width + "×" + height + ")</title>\n" +
        "<style>\n" +
        header + "\n" +
        "html,body{margin:0;background:#ffffff;}\n" +
        ".img2css-stage{padding:24px;display:inline-block;}\n" +
        cssRule + "\n" +
        "</style>\n" +
        "</head>\n" +
        "<body>\n" +
        '<div class="img2css-stage">\n  ' + htmlBody + "\n</div>\n" +
        "</body>\n" +
        "</html>\n"
      );
    },
  };

  function byteLen(str) {
    // accurate UTF-8 byte length
    return new Blob([str]).size;
  }

  window.Converter = Converter;
})();
