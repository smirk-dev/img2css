/* ===================================================================
   img2css — command registry + parsing
   Each command receives (args[], rawLine). Commands talk to the
   terminal via window.term and to the engine via window.Converter.
   Exposes window.Commands
   =================================================================== */

(function () {
  "use strict";

  var THEMES = ["green", "amber", "white", "matrix"];
  var FORMATS = ["hex", "rgb", "rgba"];
  var METHODS = ["boxshadow", "grid", "ascii", "gradient"];
  var DITHERS = ["off", "floyd", "ordered"];

  function term() {
    return window.term;
  }

  // ---- small formatting helpers --------------------------------------
  function commas(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  function humanBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "text/plain" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1500);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      /* fall through to legacy */
    }
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ---- the registry --------------------------------------------------
  var registry = {};

  function def(name, desc, usage, run) {
    registry[name] = { name: name, desc: desc, usage: usage, run: run };
  }

  // help -------------------------------------------------------------
  def("help", "list commands", "help", function () {
    var t = term();
    t.print("available commands:", "accent");
    var order = [
      "help", "upload", "open", "webcam", "info", "set", "convert",
      "preview", "copy", "export", "stats", "frame", "animate",
      "share", "theme", "clear",
    ];
    order.forEach(function (k) {
      var c = registry[k];
      if (!c) return;
      t.print("  " + pad(c.usage, 22) + c.desc, "muted");
    });
    t.print("");
    t.print("settings: set res <n|original> · set blocksize <n> · set format <hex|rgb|rgba>", "muted");
    t.print("          set method <boxshadow|grid|ascii|gradient> · set smoothing <on|off>", "muted");
    t.print("          set reduce <n> · set dither <off|floyd|ordered>", "muted");
    t.print("themes:   " + THEMES.join(" · "), "muted");
  });

  // upload / open ----------------------------------------------------
  function doUpload() {
    var picker = document.getElementById("filePicker");
    if (picker) picker.click();
    term().print("opening file picker… (or drag an image anywhere)", "muted");
  }
  def("upload", "load an image (file picker / drag-drop)", "upload", doUpload);
  def("open", "alias of upload", "open", doUpload);

  // info -------------------------------------------------------------
  def("info", "show loaded image + projected output", "info", function () {
    var t = term();
    var C = window.Converter;
    if (!C.hasImage()) {
      t.print("no image loaded. type 'upload' or drag one in.", "warn");
      return;
    }
    var i = C.info();
    t.print("file      : " + i.filename + "  (" + humanBytes(i.fileSize) + ")", "muted");
    t.print("original  : " + i.originalW + " × " + i.originalH + " px", "muted");
    t.print("target    : " + i.targetW + " × " + i.targetH + " px  (set res " + i.settings.res + ")", "muted");
    t.print("method    : " + i.settings.method + " · format " + i.settings.format +
      " · blocksize " + i.settings.blockSize +
      (i.settings.reduce ? " · reduce " + i.settings.reduce : "") +
      (i.settings.dither !== "off" ? " · dither " + i.settings.dither : "") +
      " · smoothing " + (i.settings.smoothing ? "on" : "off"), "muted");
    var shadows = "~" + commas(i.count) + " shadows";
    var size = "~" + humanBytes(i.bytes) + " css (est.)";
    var cls = i.count > C.limits.FORCE ? "err" : i.count > C.limits.WARN ? "warn" : "accent";
    t.print("projected : " + shadows + " · " + size, cls);
    if (i.count > C.limits.FORCE) {
      t.print("          ! above " + commas(C.limits.FORCE) + " — 'convert' will ask to confirm", "err");
    } else if (i.count > C.limits.WARN) {
      t.print("          ! above " + commas(C.limits.WARN) + " — may render slowly", "warn");
    }
  });

  // set --------------------------------------------------------------
  def("set", "change a setting", "set <opt> <val>", function (args) {
    var t = term();
    var C = window.Converter;
    var opt = (args[0] || "").toLowerCase();
    var val = args[1];

    if (!opt) {
      var s = C.settings;
      t.print("current settings:", "accent");
      t.print("  res        " + s.res, "muted");
      t.print("  blocksize  " + s.blockSize, "muted");
      t.print("  format     " + s.format, "muted");
      t.print("  method     " + s.method, "muted");
      t.print("  smoothing  " + (s.smoothing ? "on" : "off"), "muted");
      t.print("  reduce     " + s.reduce, "muted");
      t.print("  dither     " + s.dither, "muted");
      return;
    }

    switch (opt) {
      case "res":
        if (val === undefined) return t.print("usage: set res <n|original>", "warn");
        if (String(val).toLowerCase() === "original") {
          if (!C.hasImage()) return t.print("load an image first to use 'original'.", "warn");
          C.settings.res = C.originalW;
          t.print("res = original (" + C.originalW + " px wide)", "accent");
        } else {
          var n = parseInt(val, 10);
          if (!(n > 0)) return t.print("res must be a positive integer.", "warn");
          C.settings.res = n;
          t.print("res = " + n + " px", "accent");
        }
        reportProjection();
        break;
      case "blocksize":
        var bs = parseInt(val, 10);
        if (!(bs > 0)) return t.print("blocksize must be a positive integer.", "warn");
        C.settings.blockSize = bs;
        t.print("blocksize = " + bs + " (each pixel renders as " + bs + "×" + bs + "px)", "accent");
        break;
      case "format":
        if (FORMATS.indexOf(val) < 0) return t.print("format must be one of: " + FORMATS.join(", "), "warn");
        C.settings.format = val;
        t.print("format = " + val, "accent");
        break;
      case "method":
        if (METHODS.indexOf(val) < 0) return t.print("method must be one of: " + METHODS.join(", "), "warn");
        C.settings.method = val;
        t.print("method = " + val, "accent");
        break;
      case "smoothing":
        var on = /^(on|true|1|yes)$/i.test(val || "");
        var off = /^(off|false|0|no)$/i.test(val || "");
        if (!on && !off) return t.print("usage: set smoothing <on|off>", "warn");
        C.settings.smoothing = on;
        t.print("smoothing = " + (on ? "on" : "off"), "accent");
        break;
      case "reduce":
        var r = parseInt(val, 10);
        if (isNaN(r) || r < 0) return t.print("reduce must be 0 (off) or a positive step (e.g. 8, 16, 32).", "warn");
        C.settings.reduce = r;
        t.print("reduce = " + r + (r ? " (quantize channels to multiples of " + r + ")" : " (off)"), "accent");
        break;
      case "dither":
        if (DITHERS.indexOf(val) < 0) return t.print("dither must be one of: " + DITHERS.join(", "), "warn");
        C.settings.dither = val;
        t.print("dither = " + val + (val === "off" ? "" :
          " (quantizes to " + (C.settings.reduce > 1 ? "reduce step " + C.settings.reduce : "default step 64") + ")"), "accent");
        break;
      default:
        t.print("unknown setting: " + opt + " — see 'help'", "warn");
    }
  });

  function reportProjection() {
    var C = window.Converter;
    if (!C.hasImage()) return;
    var i = C.info();
    var cls = i.count > C.limits.FORCE ? "err" : i.count > C.limits.WARN ? "warn" : "muted";
    term().print(
      "  -> " + i.targetW + "×" + i.targetH + " = ~" + commas(i.count) +
        " shadows, ~" + humanBytes(i.bytes) + " css",
      cls
    );
  }

  // convert ----------------------------------------------------------
  def("convert", "build the CSS (Worker + progress)", "convert [--force]", async function (args) {
    var t = term();
    var C = window.Converter;
    if (!C.hasImage()) {
      t.print("no image loaded. type 'upload' or drag one in.", "warn");
      return;
    }
    var force = args.indexOf("--force") >= 0;
    var est = C.estimate();

    if (est.count > C.limits.FORCE && !force) {
      t.print(
        "! this will emit ~" + commas(est.count) + " shadows (~" + humanBytes(est.bytes) +
          ") and may lock the tab.",
        "err"
      );
      var ans = await t.ask("proceed? [y/N] ");
      if (!/^y(es)?$/i.test(ans.trim())) {
        t.print("aborted. tip: lower it with 'set res <n>' or pass 'convert --force'.", "muted");
        return;
      }
    } else if (est.count > C.limits.WARN) {
      t.print("note: ~" + commas(est.count) + " shadows — preview may render slowly.", "warn");
    }

    var prog = t.beginProgress("building css");
    try {
      var result = await C.convert({
        onProgress: function (p) {
          prog.update(p);
        },
      });
      prog.done();
      t.print(
        "✓ done — " + commas(result.count) + " " +
          (result.method === "grid" ? "cells" : "shadows") + " · " +
          humanBytes(result.sizeBytes) + " css · " + result.timeMs + " ms",
        "accent"
      );
      t.print(
        "next: 'preview' to render it · 'copy' to clipboard · 'export html' / 'export css'",
        "muted"
      );
      if (!result.previewSafe) {
        t.print(
          "heads-up: large output — live 'preview' is gated; use 'preview --force' to try anyway.",
          "warn"
        );
      }
    } catch (err) {
      prog.fail();
      t.print("conversion failed: " + err.message, "err");
    }
  });

  // preview ----------------------------------------------------------
  def("preview", "render the generated CSS in the preview pane", "preview [--force]", async function (args) {
    var t = term();
    var C = window.Converter;
    if (!C.hasImage()) {
      t.print("no image loaded. type 'upload' first.", "warn");
      return;
    }
    if (!C.result) {
      t.print("nothing converted yet — running 'convert' first…", "muted");
      await registry.convert.run([]);
      if (!C.result) return;
    }
    var force = args.indexOf("--force") >= 0;
    if (!C.result.previewSafe && !force) {
      t.print(
        "preview blocked: " + commas(C.result.count) +
          " elements could lock the tab. use 'preview --force' to render anyway,",
        "warn"
      );
      t.print("or 'export html' to open it in a fresh page instead.", "warn");
      return;
    }
    t.renderPreview(C.result, C.objectUrl);
    t.print("preview updated — original vs. CSS output shown in the pane →", "muted");
  });

  // copy -------------------------------------------------------------
  def("copy", "copy generated CSS to clipboard", "copy", async function () {
    var t = term();
    var C = window.Converter;
    if (!C.result) {
      t.print("nothing to copy — run 'convert' first.", "warn");
      return;
    }
    var ok = await copyText(C.result.fullCss);
    if (ok) {
      var label = C.result.method === "ascii" ? "ascii art" : "CSS";
      t.print("copied " + humanBytes(C.result.sizeBytes) + " of " + label + " to clipboard.", "accent");
      if (C.result.method === "ascii") {
        t.print("note: this is text art, not CSS — paste anywhere monospaced.", "muted");
      } else if (C.result.method === "grid") {
        t.print("note: grid mode also needs the <div> markup — use 'export html' for the full file.", "muted");
      } else {
        t.print('paste it, then add: <div class="img2css"></div>', "muted");
      }
    } else {
      t.print("clipboard blocked by the browser — use 'export css' instead.", "err");
    }
  });

  // export -----------------------------------------------------------
  def("export", "download .css or .html", "export <css|html>", function (args) {
    var t = term();
    var C = window.Converter;
    if (!C.result) {
      t.print("nothing to export — run 'convert' first.", "warn");
      return;
    }
    var kind = (args[0] || "").toLowerCase();
    var base = (C.filename || "image").replace(/\.[^.]+$/, "") || "img2css";
    if (kind === "css") {
      if (C.result.method === "ascii") {
        download(base + ".img2css.txt", C.result.fullCss, "text/plain");
        t.print("downloaded " + base + ".img2css.txt (" + humanBytes(C.result.sizeBytes) + ") — ascii art.", "accent");
      } else {
        download(base + ".img2css.css", C.result.fullCss, "text/css");
        t.print("downloaded " + base + ".img2css.css (" + humanBytes(C.result.sizeBytes) + ")", "accent");
      }
    } else if (kind === "html") {
      download(base + ".img2css.html", C.result.fullHtml, "text/html");
      t.print("downloaded " + base + ".img2css.html (" + humanBytes(C.result.htmlBytes) +
        ") — self-contained, no JS, no <img>.", "accent");
    } else {
      t.print("usage: export <css|html>", "warn");
    }
  });

  // theme ------------------------------------------------------------
  def("theme", "switch phosphor theme", "theme <name>", function (args) {
    var t = term();
    var name = (args[0] || "").toLowerCase();
    if (THEMES.indexOf(name) < 0) {
      t.print("themes: " + THEMES.join(", "), "warn");
      return;
    }
    THEMES.forEach(function (th) {
      document.body.classList.remove("theme-" + th);
    });
    document.body.classList.add("theme-" + name);
    t.print("theme = " + name, "accent");
  });

  // clear ------------------------------------------------------------
  def("clear", "clear the scrollback", "clear", function () {
    term().clear();
  });

  // stats ------------------------------------------------------------
  def("stats", "size/timing breakdown of the last conversion", "stats", async function () {
    var t = term();
    var C = window.Converter;
    var r = C.result;
    if (!r) {
      t.print("nothing converted yet — run 'convert' first.", "warn");
      return;
    }
    var unit = r.method === "grid" ? "cells" : r.method === "ascii" ? "chars" : "shadows";
    t.print("last conversion:", "accent");
    t.print("  method     " + r.method + " · " + r.format + " · blocksize " + r.blockSize, "muted");
    t.print("  dimensions " + r.width + " × " + r.height + " px  (" + commas(r.width * r.height) + " source px)", "muted");
    t.print("  painted    " + commas(r.count) + " " + unit +
      "  (" + (100 - Math.round((r.count / (r.width * r.height)) * 100)) + "% transparent/skipped)", "muted");
    t.print("  raw size   " + humanBytes(r.sizeBytes) + "  (" +
      (r.sizeBytes / Math.max(1, r.count)).toFixed(1) + " B/" + unit.replace(/s$/, "") + ")", "muted");
    t.print("  html size  " + humanBytes(r.htmlBytes), "muted");
    t.print("  build time " + r.timeMs + " ms", "muted");
    var gz = await C.gzipSize(r.fullCss);
    if (gz != null) {
      var ratio = (r.sizeBytes / Math.max(1, gz)).toFixed(1);
      t.print("  gzipped    " + humanBytes(gz) + "  (" + ratio + "× smaller — repetitive output compresses well)", "accent");
    } else {
      t.print("  gzipped    (CompressionStream unavailable in this browser)", "muted");
    }
  });

  // frame / animate --------------------------------------------------
  def("frame", "manage animation frames", "frame <add|list|clear>", async function (args) {
    var t = term();
    var C = window.Converter;
    var sub = (args[0] || "").toLowerCase();
    if (sub === "add") {
      if (!C.hasImage()) return t.print("load an image first, then 'frame add'.", "warn");
      if (C.settings.method !== "boxshadow") {
        t.print("frames use the box-shadow method — switching method to boxshadow.", "muted");
        C.settings.method = "boxshadow";
      }
      var prog = t.beginProgress("capturing frame");
      try {
        var r = await C.convert({ onProgress: function (p) { prog.update(p); } });
        prog.done();
        if (C.frames.length && (C.frames[0].width !== r.width || C.frames[0].height !== r.height)) {
          t.print("! frame size " + r.width + "×" + r.height + " differs from frame 1 (" +
            C.frames[0].width + "×" + C.frames[0].height + "). 'animate' uses frame 1's box.", "warn");
        }
        C.frames.push({ value: r.cssRule.match(/box-shadow:\n\s*([\s\S]*);\n}/)[1], width: r.width, height: r.height, blockSize: r.blockSize, count: r.count });
        t.print("frame " + C.frames.length + " captured (" + commas(r.count) + " shadows). 'animate <sec>' when ready.", "accent");
      } catch (err) {
        prog.fail();
        t.print("frame capture failed: " + err.message, "err");
      }
    } else if (sub === "clear") {
      C.frames = [];
      t.print("frames cleared.", "accent");
    } else {
      if (!C.frames.length) { t.print("no frames yet — 'frame add' captures the current image.", "muted"); return; }
      t.print(C.frames.length + " frame(s):", "accent");
      C.frames.forEach(function (f, n) {
        t.print("  " + (n + 1) + ": " + f.width + "×" + f.height + " · " + commas(f.count) + " shadows", "muted");
      });
    }
  });

  def("animate", "build a pure-CSS @keyframes animation from frames", "animate <seconds>", function (args) {
    var t = term();
    var C = window.Converter;
    if (C.frames.length < 2) {
      t.print("need at least 2 frames — use 'frame add' on each image first.", "warn");
      return;
    }
    var secs = parseFloat(args[0]);
    if (!(secs > 0)) secs = C.frames.length * 0.5;
    var f0 = C.frames[0];
    var bs = f0.blockSize;
    var n = C.frames.length;
    var keys = [];
    for (var k = 0; k < n; k++) {
      var startPct = (k / n) * 100;
      var endPct = ((k + 1) / n) * 100 - 0.001;
      var sh = "    box-shadow:\n      " + C.frames[k].value + ";";
      keys.push("  " + startPct.toFixed(3) + "% {\n" + sh + "\n  }");
      keys.push("  " + endPct.toFixed(3) + "% {\n" + sh + "\n  }");
    }
    var header = "/* img2css animation — " + n + " frames, " + secs + "s loop, " + f0.width + "×" + f0.height + " */";
    var cssRule =
      ".img2css {\n" +
      "  width: " + bs + "px; height: " + bs + "px; background: transparent;\n" +
      "  animation: img2css-anim " + secs + "s infinite;\n}\n" +
      "@keyframes img2css-anim {\n" + keys.join("\n") + "\n}";
    var fullCss = header + "\n" + cssRule + "\n";
    var htmlBody = '<div class="img2css"></div>';
    var fullHtml =
      "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n" +
      "<title>img2css animation</title>\n<style>\n" + header + "\n" +
      "html,body{margin:0;background:#fff;}\n.img2css-stage{padding:24px;display:inline-block;}\n" +
      cssRule + "\n</style>\n</head>\n<body>\n<div class=\"img2css-stage\">\n  " + htmlBody + "\n</div>\n</body>\n</html>\n";

    // stash as the active result so copy/export/preview all work
    C.result = {
      method: "boxshadow", width: f0.width, height: f0.height, blockSize: bs,
      format: C.settings.format, count: f0.count, cssRule: cssRule, htmlBody: htmlBody,
      fullCss: fullCss, fullHtml: fullHtml,
      sizeBytes: new Blob([fullCss]).size, htmlBytes: new Blob([fullHtml]).size,
      timeMs: 0, previewSafe: f0.count <= C.limits.PREVIEW,
    };
    t.print("✓ animation built — " + n + " frames · " + secs + "s loop · " +
      humanBytes(C.result.sizeBytes) + " css", "accent");
    t.print("'preview' to watch it · 'copy' / 'export html' to keep it. (pure CSS, no JS)", "muted");
  });

  // webcam -----------------------------------------------------------
  def("webcam", "capture a still from your camera", "webcam", async function () {
    var t = term();
    var C = window.Converter;
    t.print("requesting camera… (allow access in the browser prompt)", "muted");
    try {
      var info = await C.webcam();
      t.print("> captured webcam frame (" + info.originalW + "×" + info.originalH + ")", "accent");
      var cls = info.count > C.limits.WARN ? "warn" : "muted";
      t.print("suggested res " + info.targetW + "px → " + info.targetW + "×" + info.targetH +
        " (~" + commas(info.count) + " shadows). 'convert' to build.", cls);
      t.showOriginal(C.objectUrl);
    } catch (err) {
      t.print("webcam failed: " + err.message, "err");
    }
  });

  // share ------------------------------------------------------------
  def("share", "make a shareable link (settings + image in the URL)", "share", async function () {
    var t = term();
    var C = window.Converter;
    if (!C.hasImage()) {
      t.print("load an image first — 'share' embeds it in the link.", "warn");
      return;
    }
    var snap = C.snapshotDataUrl();
    if (!snap) { t.print("could not snapshot the image.", "err"); return; }
    var payload = { v: 1, s: C.settings, img: snap };
    var encoded;
    try {
      encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    } catch (e) {
      t.print("could not encode the link.", "err");
      return;
    }
    var base = location.origin && location.origin !== "null"
      ? location.origin + location.pathname
      : location.href.split("#")[0];
    var link = base + "#i=" + encoded;
    if (link.length > 1500000) {
      t.print("! link is very large (" + humanBytes(link.length) + ") — lower 'set res' before sharing.", "warn");
    }
    var ok = await copyText(link);
    t.print((ok ? "copied " : "") + "share link (" + humanBytes(link.length) + ", image embedded at " +
      C.targetDims().w + "×" + C.targetDims().h + "):", "accent");
    t.print(ok ? "  paste it anywhere — opening it restores the image + settings." :
      "  clipboard blocked; here it is:", "muted");
    if (!ok) t.print(link, "muted");
  });

  // ---- parsing + dispatch -------------------------------------------
  function parse(line) {
    // simple whitespace split; collapses multiple spaces
    var toks = line.trim().split(/\s+/).filter(Boolean);
    return toks;
  }

  function pad(s, n) {
    s = s || "";
    return s.length >= n ? s + " " : s + new Array(n - s.length + 1).join(" ");
  }

  var Commands = {
    registry: registry,

    async run(line) {
      var toks = parse(line);
      if (!toks.length) return;
      var name = toks[0].toLowerCase();
      var cmd = registry[name];
      if (!cmd) {
        term().print("command not found: " + name + " — type 'help'", "err");
        return;
      }
      try {
        await cmd.run(toks.slice(1), line);
      } catch (err) {
        term().print("error: " + (err && err.message ? err.message : err), "err");
      }
    },

    // names for Tab autocomplete (top-level + a few common two-word forms)
    completions() {
      var names = Object.keys(registry);
      var extra = [
        "set res ", "set res original", "set blocksize ", "set format ",
        "set method boxshadow", "set method grid", "set method ascii", "set method gradient",
        "set smoothing ", "set reduce ",
        "set dither off", "set dither floyd", "set dither ordered",
        "export css", "export html",
        "frame add", "frame list", "frame clear", "animate ",
        "theme green", "theme amber", "theme white", "theme matrix",
      ];
      return names.concat(extra);
    },
  };

  window.Commands = Commands;
})();
