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
    if (method === "ascii") {
      // luminance -> character ramp (dark .. bright) for a dark terminal
      var ramp = " .:-=+*#%@", rampN = ramp.length - 1, lines = [];
      for (y = 0; y < height; y++) {
        var line = "";
        for (x = 0; x < width; x++) {
          i = (y * width + x) * 4; a = px[i + 3];
          if (a <= alphaThreshold) { line += " "; continue; }
          var lum = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
          line += ramp.charAt(Math.round(lum * rampN));
          kept++;
        }
        lines.push(line);
        row(y);
      }
      return { value: lines.join("\n"), count: kept, method: "ascii" };
    }
    if (method === "gradient") {
      // one horizontal linear-gradient per row, hard stops at pixel edges;
      // layered as stacked background-images (single element, pure CSS).
      var grads = [];
      for (y = 0; y < height; y++) {
        var stops = [];
        for (x = 0; x < width; x++) {
          i = (y * width + x) * 4; a = px[i + 3];
          var col = a <= alphaThreshold ? "transparent" : fmt(q(px[i]), q(px[i + 1]), q(px[i + 2]), a);
          stops.push(col + " " + x * blockSize + "px", col + " " + (x + 1) * blockSize + "px");
          if (a > alphaThreshold) kept++;
        }
        grads.push("linear-gradient(90deg," + stops.join(",") + ")");
        row(y);
      }
      return { value: grads.join(",\n    "), count: kept, method: "gradient" };
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
      dither: "off", // off | floyd | ordered (error-diffusion / bayer)
    },

    // ---- last conversion result ----
    result: null,

    // ---- animation frames (each: {value,count,width,height,blockSize}) ----
    frames: [],

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
          self.adoptImage(img, url, file.name, file.size);
          resolve(self.info());
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error("could not decode image"));
        };
        img.src = url;
      });
    },

    /* Adopt a decoded <img> (from a file, the webcam, or a share link) as
       the active image, and pick a safe default resolution. Shared by
       loadFile / webcam / share-link restore. */
    adoptImage: function (img, url, name, size) {
      if (this.objectUrl && this.objectUrl !== url) URL.revokeObjectURL(this.objectUrl);
      this.image = img;
      this.objectUrl = url;
      this.filename = name || "image";
      this.fileSize = size || 0;
      this.originalW = img.naturalWidth || img.width;
      this.originalH = img.naturalHeight || img.height;
      this.result = null;

      // smart default: clamp longest side to DEFAULT_MAX_SIDE
      var longest = Math.max(this.originalW, this.originalH);
      if (longest <= DEFAULT_MAX_SIDE) {
        this.settings.res = this.originalW;
      } else {
        this.settings.res = Math.max(1, Math.round(this.originalW * (DEFAULT_MAX_SIDE / longest)));
      }
      return this.info();
    },

    /* Capture a single still from the webcam, adopt it as the image. */
    webcam: function () {
      var self = this;
      return new Promise(function (resolve, reject) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          return reject(new Error("camera API not available in this browser/context"));
        }
        navigator.mediaDevices.getUserMedia({ video: true, audio: false }).then(function (stream) {
          var video = document.createElement("video");
          video.muted = true;
          video.playsInline = true;
          video.srcObject = stream;
          function stop() { stream.getTracks().forEach(function (t) { t.stop(); }); }
          function grab() {
            var w = video.videoWidth, h = video.videoHeight;
            if (!w || !h) { stop(); return reject(new Error("could not read a camera frame")); }
            var c = document.createElement("canvas");
            c.width = w; c.height = h;
            c.getContext("2d").drawImage(video, 0, 0, w, h);
            stop();
            c.toBlob(function (blob) {
              var url = URL.createObjectURL(blob);
              var img = new Image();
              img.onload = function () {
                self.adoptImage(img, url, "webcam.png", blob ? blob.size : 0);
                resolve(self.info());
              };
              img.onerror = function () { reject(new Error("could not decode camera frame")); };
              img.src = url;
            }, "image/png");
          }
          video.onloadedmetadata = function () {
            video.play().then(function () {
              // let one frame settle, then grab
              requestAnimationFrame(function () { requestAnimationFrame(grab); });
            }, grab);
          };
        }, function (err) {
          reject(new Error(err && err.name === "NotAllowedError" ? "camera permission denied" : "could not open camera"));
        });
      });
    },

    /* A small PNG data URL of the current image at the target resolution —
       used to embed a recreatable snapshot inside a share link. */
    snapshotDataUrl: function () {
      if (!this.image) return null;
      var d = this.targetDims();
      var c = document.createElement("canvas");
      c.width = d.w; c.height = d.h;
      var ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = !!this.settings.smoothing;
      ctx.drawImage(this.image, 0, 0, d.w, d.h);
      return c.toDataURL("image/png");
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
       Dithering pre-pass (mutates the pixel buffer in place). Quantizes
       to multiples of `step` while diffusing the error so low-color /
       low-res output looks far better. step comes from `reduce`, or a
       sensible default when reduce is off.
       ----------------------------------------------------------------- */
    _dither: function (px, width, height) {
      var mode = this.settings.dither;
      if (mode !== "floyd" && mode !== "ordered") return;
      var step = this.settings.reduce > 1 ? this.settings.reduce : 64;
      function snap(v) {
        var x = Math.round(v / step) * step;
        return x < 0 ? 0 : x > 255 ? 255 : x;
      }
      var x, y, i, ch;
      if (mode === "ordered") {
        // 4x4 Bayer matrix, normalized to [-0.5, 0.5)
        var B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
        for (y = 0; y < height; y++) {
          for (x = 0; x < width; x++) {
            i = (y * width + x) * 4;
            var t = (B[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * step;
            for (ch = 0; ch < 3; ch++) px[i + ch] = snap(px[i + ch] + t);
          }
        }
        return;
      }
      // Floyd–Steinberg error diffusion
      for (y = 0; y < height; y++) {
        for (x = 0; x < width; x++) {
          i = (y * width + x) * 4;
          for (ch = 0; ch < 3; ch++) {
            var old = px[i + ch];
            var nu = snap(old);
            px[i + ch] = nu;
            var err = old - nu;
            if (x + 1 < width) px[i + 4 + ch] += (err * 7) / 16;
            if (y + 1 < height) {
              var down = i + width * 4;
              if (x > 0) px[down - 4 + ch] += (err * 3) / 16;
              px[down + ch] += (err * 5) / 16;
              if (x + 1 < width) px[down + 4 + ch] += (err * 1) / 16;
            }
          }
        }
      }
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
      this._dither(pixels.data, pixels.width, pixels.height);
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

      if (m.method === "ascii") {
        // not CSS — text art. fullCss carries the art so copy/export work.
        var artHeader = "/* img2css ascii — " + width + "×" + height + " chars */\n";
        cssRule =
          ".img2css-ascii {\n" +
          "  font-family: ui-monospace, monospace;\n" +
          "  font-size: 10px; line-height: 1; white-space: pre;\n" +
          "  letter-spacing: 0; background: #000; color: #fff;\n" +
          "  display: inline-block; padding: 8px;\n" +
          "}";
        htmlBody = '<pre class="img2css-ascii">' + escapeHtml(m.value) + "</pre>";
        var fullArt = artHeader + m.value + "\n";
        var fullHtmlA = this._buildHtmlDoc(artHeader.replace(/\n$/, ""), cssRule, htmlBody, width, height);
        return {
          method: "ascii", width: width, height: height, blockSize: bs, format: s.format,
          count: m.count, art: m.value, cssRule: cssRule, htmlBody: htmlBody,
          fullCss: fullArt, fullHtml: fullHtmlA,
          sizeBytes: byteLen(fullArt), htmlBytes: byteLen(fullHtmlA),
          timeMs: Math.round(timeMs), previewSafe: width * height <= PREVIEW_COUNT,
        };
      }

      if (m.method === "gradient") {
        var positions = [];
        for (var gy = 0; gy < height; gy++) positions.push("0 " + gy * bs + "px");
        cssRule =
          ".img2css {\n" +
          "  width: " + width * bs + "px;\n" +
          "  height: " + height * bs + "px;\n" +
          "  background-repeat: no-repeat;\n" +
          "  background-size: " + width * bs + "px " + bs + "px;\n" +
          "  background-position:\n    " + positions.join(",\n    ") + ";\n" +
          "  background-image:\n    " + m.value + ";\n}";
        htmlBody = '<div class="img2css"></div>';
        var fullCssG = header + "\n" + cssRule + "\n";
        var fullHtmlG = this._buildHtmlDoc(header, cssRule, htmlBody, width, height);
        return {
          method: "gradient", width: width, height: height, blockSize: bs, format: s.format,
          count: m.count, cssRule: cssRule, htmlBody: htmlBody,
          fullCss: fullCssG, fullHtml: fullHtmlG,
          sizeBytes: byteLen(fullCssG), htmlBytes: byteLen(fullHtmlG),
          timeMs: Math.round(timeMs), previewSafe: m.count <= PREVIEW_COUNT,
        };
      }

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

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Gzip a string and resolve with the compressed byte length. Uses the
  // browser's CompressionStream when available; resolves null otherwise.
  function gzipSize(str) {
    return new Promise(function (resolve) {
      try {
        if (typeof CompressionStream === "undefined") return resolve(null);
        var cs = new CompressionStream("gzip");
        var blob = new Blob([str]);
        var stream = blob.stream().pipeThrough(cs);
        new Response(stream).blob().then(function (out) {
          resolve(out.size);
        }, function () { resolve(null); });
      } catch (e) { resolve(null); }
    });
  }
  Converter.gzipSize = gzipSize;

  window.Converter = Converter;
})();
