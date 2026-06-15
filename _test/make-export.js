/* Build a real export .html from a recognizable 13x13 pattern using the
   actual converter.js code, so we can screenshot it and confirm the
   exported file renders the image with no JS / no <img>. */
const fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.join(__dirname, "..");

const sandbox = {
  window: {}, document: { createElement: () => ({ getContext: () => ({}) }) },
  performance: { now: () => 0 },
  Blob: function (p) { this.size = Buffer.byteLength(p.join("")); },
  URL: { createObjectURL: () => "", revokeObjectURL: () => {} },
  Image: function () {}, console,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "js/converter.js"), "utf8"), sandbox);
const C = sandbox.window.Converter;

const N = 13;
const data = new Uint8ClampedArray(N * N * 4);
function set(x, y, r, g, b, a) { const i = (y * N + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a; }
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const border = x === 0 || y === 0 || x === N - 1 || y === N - 1;
  const diag = x === y || x === N - 1 - y;
  if (border) set(x, y, 230, 60, 60, 255);        // red frame
  else if (diag) set(x, y, 80, 220, 120, 255);    // green X
  else if (x > 4 && x < 8 && y > 4 && y < 8) set(x, y, 245, 245, 245, 255); // white center
  else set(x, y, 0, 0, 0, 0);                      // transparent field
}

C.settings.blockSize = 16;
C.settings.format = "hex";
const r = C._coreBuild(data, N, N, 16, "hex", "boxshadow", 0, 0, () => {});
const result = C._assemble({ type: "done", method: "boxshadow", value: r.value, count: r.count }, N, N, 1);
fs.writeFileSync(path.join(__dirname, "export-demo.html"), result.fullHtml);
console.log("wrote _test/export-demo.html — " + r.count + " shadows, " + result.sizeBytes + " bytes");
console.log("has <img>:", /<img/i.test(result.fullHtml), " has <script>:", /<script/i.test(result.fullHtml));
