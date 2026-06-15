/* Minimal CDP driver: launches headless Chrome on a real-time clock,
   loads a URL, and polls #TESTRESULT until the page finishes. Used to
   verify the real Web Worker path (which doesn't settle under Chrome's
   virtual-time clock). Node 22 globals: fetch, WebSocket. */
const { spawn } = require("child_process");

const CHROME =
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const url = process.argv[2];
const port = 9333;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--allow-file-access-from-files",
    "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + process.env.TEMP + "\\img2css-cdp",
    url,
  ], { stdio: "ignore" });

  let wsUrl = null;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (e) {}
    await sleep(200);
  }
  if (!wsUrl) { console.log("NO_TARGET"); chrome.kill(); process.exit(2); }

  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = {};
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id]; }
  });
  function send(method, params) {
    return new Promise((res) => { const i = ++id; pending[i] = res; ws.send(JSON.stringify({ id: i, method, params })); });
  }
  await new Promise((res) => ws.addEventListener("open", res));
  await send("Runtime.enable", {});

  let result = null;
  for (let i = 0; i < 60; i++) {
    const r = await send("Runtime.evaluate", {
      expression: "(function(){var e=document.getElementById('TESTRESULT');return e?e.textContent:(window._err||'');})()",
      returnByValue: true,
    });
    const val = r && r.result && r.result.value;
    if (val && val.indexOf("ALL_PASS") === 0 || (val && val.indexOf("SOME_FAIL") === 0)) { result = val; break; }
    await sleep(300);
  }

  console.log(result || "TIMEOUT_NO_RESULT");
  ws.close();
  chrome.kill();
  process.exit(result && result.indexOf("ALL_PASS") === 0 ? 0 : 1);
})();
