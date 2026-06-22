/* ===================================================================
   img2css — terminal shell
   Scrollback + typewriter reveal, command input loop, history,
   Tab autocomplete, drag-and-drop, confirmation prompts, progress
   bars, and the preview renderer. Exposes window.term
   =================================================================== */

(function () {
  "use strict";

  // ---- tiny shared helpers ------------------------------------------
  function commas(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  function humanBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  }

  var BANNER = [
    "██╗███╗   ███╗ ██████╗ ██████╗  ██████╗███████╗███████╗",
    "██║████╗ ████║██╔════╝ ╚════██╗██╔════╝██╔════╝██╔════╝",
    "██║██╔████╔██║██║  ███╗ █████╔╝██║     ███████╗███████╗",
    "██║██║╚██╔╝██║██║   ██║██╔═══╝ ██║     ╚════██║╚════██║",
    "██║██║ ╚═╝ ██║╚██████╔╝███████╗╚██████╗███████║███████║",
    "╚═╝╚═╝     ╚═╝ ╚═════╝ ╚══════╝ ╚═════╝╚══════╝╚══════╝",
  ];

  class Terminal {
    constructor(els) {
      this.output = els.output;
      this.input = els.input;
      this.mirror = els.mirror;
      this.cursor = els.cursor;
      this.inputLine = els.inputLine;

      this.history = [];
      this.histIdx = 0;
      this.draftBeforeHistory = "";

      this._revealQueue = [];
      this._revealing = false;
      this.flush = false; // skip typewriter when true
      this._ask = null; // pending confirmation resolver

      this._wireInput();
    }

    // ---- output ------------------------------------------------------
    _scroll() {
      this.output.scrollTop = this.output.scrollHeight;
    }

    _makeLine(cls) {
      var line = document.createElement("span");
      line.className = "line" + (cls ? " " + cls : "");
      this.output.appendChild(line);
      return line;
    }

    print(text, cls) {
      var line = this._makeLine(cls);
      line.dataset.full = text == null ? "" : String(text);
      line.textContent = "";
      this._revealQueue.push(line);
      this._scroll();
      this._revealKick();
      return line;
    }

    printInstant(text, cls) {
      var line = this._makeLine(cls);
      line.textContent = text == null ? "" : String(text);
      this._scroll();
      return line;
    }

    _revealKick() {
      if (this._revealing) return;
      this._revealing = true;
      this._revealNext();
    }

    _revealNext() {
      var self = this;
      if (!this._revealQueue.length) {
        this._revealing = false;
        this.flush = false;
        return;
      }
      var node = this._revealQueue.shift();
      var text = node.dataset.full || "";
      this._typeInto(node, text, function () {
        self._revealNext();
      });
    }

    _typeInto(node, text, done) {
      var self = this;
      var dur = Math.min(text.length * 3, 90);
      if (this.flush || dur < 16 || text.length === 0) {
        node.textContent = text;
        this._scroll();
        done();
        return;
      }
      var start = null;
      function step(ts) {
        if (self.flush) {
          node.textContent = text;
          self._scroll();
          done();
          return;
        }
        if (start === null) start = ts;
        var p = Math.min(1, (ts - start) / dur);
        node.textContent = text.slice(0, Math.floor(p * text.length));
        self._scroll();
        if (p < 1) requestAnimationFrame(step);
        else {
          node.textContent = text;
          done();
        }
      }
      requestAnimationFrame(step);
    }

    clear() {
      this.output.innerHTML = "";
      this._revealQueue = [];
      this._revealing = false;
    }

    banner() {
      BANNER.forEach((l) => this.printInstant(l, "banner"));
      this.printInstant("image → pure CSS · single-element box-shadow · 100% client-side", "muted");
      this.printInstant("", null);
      this.print("type 'help' to list commands, 'upload' to load an image, or drag one in.", "accent");
      this.printInstant("", null);
    }

    // ---- confirmation prompt ----------------------------------------
    ask(question) {
      var self = this;
      this.printInstant(question, "warn");
      return new Promise(function (resolve) {
        self._ask = resolve;
      });
    }

    // ---- progress bar ------------------------------------------------
    beginProgress(label) {
      var self = this;
      var line = this._makeLine("progress-line");
      var width = 26;
      function bar(pct, cls) {
        var filled = Math.round((pct / 100) * width);
        var b = "[" + repeat("█", filled) + repeat("·", width - filled) + "]";
        line.textContent = label + " " + b + " " + pct + "%";
        if (cls) line.classList.add(cls);
        self._scroll();
      }
      bar(0);
      return {
        update: function (p) {
          bar(Math.max(0, Math.min(100, p | 0)));
        },
        done: function () {
          bar(100, "accent");
        },
        fail: function () {
          line.classList.add("err");
          line.textContent = label + " [failed]";
          self._scroll();
        },
      };
    }

    // ---- input loop --------------------------------------------------
    _wireInput() {
      var self = this;
      var input = this.input;

      input.addEventListener("input", function () {
        self._syncMirror();
      });

      input.addEventListener("keydown", function (e) {
        self.flush = true; // any keypress skips the typewriter
        if (e.key === "Enter") {
          e.preventDefault();
          self._submit();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          self._historyPrev();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          self._historyNext();
        } else if (e.key === "Tab") {
          e.preventDefault();
          self._autocomplete();
        }
      });

      input.addEventListener("focus", function () {
        self.inputLine.classList.remove("blurred");
      });
      input.addEventListener("blur", function () {
        self.inputLine.classList.add("blurred");
      });

      // keep cursor glued to the typed text
      this._syncMirror();
    }

    _syncMirror() {
      this.mirror.textContent = this.input.value;
      this._scroll();
    }

    _setValue(v) {
      this.input.value = v;
      this._syncMirror();
      // caret to end
      var len = v.length;
      try {
        this.input.setSelectionRange(len, len);
      } catch (e) {}
    }

    focus() {
      this.input.focus();
    }

    _submit() {
      var val = this.input.value;
      this._setValue("");

      // resolving a confirmation prompt?
      if (this._ask) {
        this.printInstant(val, "cmd");
        var resolve = this._ask;
        this._ask = null;
        resolve(val);
        return;
      }

      this.printInstant(val, "cmd"); // echo with prompt prefix (via CSS)

      if (val.trim()) {
        if (this.history[this.history.length - 1] !== val) this.history.push(val);
        this.histIdx = this.history.length;
        window.Commands.run(val);
      }
    }

    _historyPrev() {
      if (!this.history.length) return;
      if (this.histIdx === this.history.length) {
        this.draftBeforeHistory = this.input.value;
      }
      this.histIdx = Math.max(0, this.histIdx - 1);
      this._setValue(this.history[this.histIdx]);
    }

    _historyNext() {
      if (this.histIdx >= this.history.length) return;
      this.histIdx++;
      if (this.histIdx >= this.history.length) {
        this.histIdx = this.history.length;
        this._setValue(this.draftBeforeHistory || "");
      } else {
        this._setValue(this.history[this.histIdx]);
      }
    }

    _autocomplete() {
      var val = this.input.value;
      var opts = window.Commands.completions();
      var lower = val.toLowerCase();
      var matches = opts.filter(function (o) {
        return o.toLowerCase().indexOf(lower) === 0;
      });

      if (!val.trim()) {
        // nothing typed -> show top-level commands
        this.printInstant(val, "cmd");
        this.print(uniqueFirstWords(opts).join("   "), "muted");
        return;
      }
      if (matches.length === 0) return;
      if (matches.length === 1) {
        this._setValue(matches[0]);
        return;
      }
      // complete to common prefix, then list options
      var prefix = commonPrefix(matches);
      if (prefix.length > val.length) {
        this._setValue(prefix);
      } else {
        this.printInstant(val, "cmd");
        this.print(matches.join("   "), "muted");
      }
    }

    // ---- preview -----------------------------------------------------
    showPreviewPane(show) {
      var pane = document.getElementById("preview");
      if (!pane) return;
      pane.classList.toggle("hidden", !show);
    }

    renderPreview(result, originalUrl) {
      this.showPreviewPane(true);
      var host = document.getElementById("previewHost");
      var styleEl = document.getElementById("previewStyle");
      var stageOriginal = document.getElementById("stageOriginal");

      // ascii output: render the <pre> directly (no box-shadow scaling)
      if (result.method === "ascii") {
        styleEl.textContent = result.cssRule;
        host.style.width = "";
        host.style.height = "";
        host.innerHTML = result.htmlBody;
        if (originalUrl) {
          stageOriginal.innerHTML =
            '<img src="' + originalUrl + '" alt="original" style="max-width:100%;image-rendering:pixelated;">';
        }
        return;
      }

      var outW = result.width * result.blockSize;
      var outH = result.height * result.blockSize;
      var k = Math.max(1, Math.min(10, Math.floor(360 / Math.max(outW, outH)) || 1));
      var dispW = outW * k;
      var dispH = outH * k;

      // inject the *actual generated* CSS rule
      styleEl.textContent = result.cssRule;

      // scaled wrapper so small images are visible (and box-shadow scales too)
      host.style.width = dispW + "px";
      host.style.height = dispH + "px";
      host.innerHTML =
        '<div style="transform:scale(' + k + ');transform-origin:0 0;width:' +
        outW + "px;height:" + outH + 'px;">' + result.htmlBody + "</div>";

      if (originalUrl) {
        stageOriginal.innerHTML =
          '<img src="' + originalUrl + '" alt="original" style="width:' +
          dispW + "px;height:" + dispH + 'px;image-rendering:pixelated;">';
      }
    }

    showOriginal(originalUrl) {
      // show the source in the pane right after upload (before convert)
      this.showPreviewPane(true);
      var stageOriginal = document.getElementById("stageOriginal");
      if (originalUrl) {
        stageOriginal.innerHTML =
          '<img src="' + originalUrl + '" alt="original" style="max-width:100%;image-rendering:pixelated;">';
      }
    }
  }

  // ---- module-local utils -------------------------------------------
  function repeat(ch, n) {
    if (n <= 0) return "";
    return new Array(n + 1).join(ch);
  }
  function commonPrefix(arr) {
    if (!arr.length) return "";
    var p = arr[0];
    for (var i = 1; i < arr.length; i++) {
      while (arr[i].toLowerCase().indexOf(p.toLowerCase()) !== 0) {
        p = p.slice(0, -1);
        if (!p) return "";
      }
    }
    return p;
  }
  function uniqueFirstWords(opts) {
    var seen = {};
    var out = [];
    opts.forEach(function (o) {
      var w = o.split(/\s+/)[0];
      if (!seen[w]) {
        seen[w] = true;
        out.push(w);
      }
    });
    return out;
  }

  // ===================================================================
  //  boot
  // ===================================================================
  function boot() {
    var term = new Terminal({
      output: document.getElementById("output"),
      input: document.getElementById("cmd"),
      mirror: document.getElementById("mirror"),
      cursor: document.getElementById("cursor"),
      inputLine: document.getElementById("inputLine"),
    });
    window.term = term;

    // focus on any click in the terminal area
    var terminalEl = document.getElementById("terminal");
    terminalEl.addEventListener("mousedown", function (e) {
      // don't steal focus from text selection inside output
      if (window.getSelection && String(window.getSelection())) return;
      setTimeout(function () {
        term.focus();
      }, 0);
    });

    // ---- file handling (picker + drag-drop) ----
    function handleFile(file) {
      window.Converter.loadFile(file)
        .then(function (info) {
          term.print(
            "> file received: " + info.filename + " (" + info.originalW + "×" +
              info.originalH + ", " + humanBytes(info.fileSize) + ")",
            "accent"
          );
          var cls = info.count > window.Converter.limits.WARN ? "warn" : "muted";
          term.print(
            "suggested res " + info.targetW + "px → " + info.targetW + "×" + info.targetH +
              " (~" + commas(info.count) + " shadows). 'info' for details · 'convert' to build.",
            cls
          );
          term.showOriginal(window.Converter.objectUrl);
        })
        .catch(function (err) {
          term.print("upload failed: " + err.message, "err");
        });
    }

    var picker = document.getElementById("filePicker");
    picker.addEventListener("change", function () {
      if (picker.files && picker.files[0]) {
        handleFile(picker.files[0]);
        picker.value = ""; // allow re-selecting the same file
      }
    });

    // drag + drop anywhere
    var overlay = document.getElementById("dropOverlay");
    window.addEventListener("dragover", function (e) {
      e.preventDefault();
      overlay.classList.remove("hidden");
    });
    window.addEventListener("dragleave", function (e) {
      if (e.relatedTarget === null) overlay.classList.add("hidden");
    });
    window.addEventListener("drop", function (e) {
      e.preventDefault();
      overlay.classList.add("hidden");
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files[0]) handleFile(dt.files[0]);
    });

    // preview close
    var previewClose = document.getElementById("previewClose");
    if (previewClose) {
      previewClose.addEventListener("click", function () {
        term.showPreviewPane(false);
      });
    }

    // restore a shared image+settings from the URL hash, if present
    function restoreFromHash() {
      var m = /(?:^|#|&)i=([^&]+)/.exec(location.hash || "");
      if (!m) return;
      var payload;
      try {
        payload = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
      } catch (e) {
        term.print("share link looks corrupted — ignoring it.", "warn");
        return;
      }
      if (!payload || !payload.img) return;
      var img = new Image();
      img.onload = function () {
        window.Converter.adoptImage(img, img.src, "shared.png", 0);
        if (payload.s) Object.assign(window.Converter.settings, payload.s);
        var info = window.Converter.info();
        term.print("> restored shared image (" + info.originalW + "×" + info.originalH +
          ") + settings from link.", "accent");
        term.print("method " + info.settings.method + " · res " + info.settings.res +
          " · format " + info.settings.format + ". 'convert' to rebuild.", "muted");
        term.showOriginal(window.Converter.objectUrl);
      };
      img.onerror = function () { term.print("could not decode the shared image.", "warn"); };
      img.src = payload.img;
    }

    // boot output
    term.banner();
    restoreFromHash();
    term.focus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
