import { createShell } from "/omnishell/interpreter/shell.js";
const mount = document.getElementById("app");
if (!mount) throw new Error("boot: #app mount missing");

function initPersistentMasthead() {
  let backdrop = document.getElementById("shell-masthead");
  if (!backdrop) {
    backdrop = document.createElement("header");
    backdrop.id = "shell-masthead";
    backdrop.className = "masthead-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.inert = true;
    document.body.prepend(backdrop);
  }

  function sync() {
    const active = document.querySelector(".shell-screen:not([hidden]) .masthead");
    if (!active) return;
    if (!backdrop.firstElementChild || backdrop.innerHTML !== active.innerHTML) {
      backdrop.innerHTML = active.innerHTML;
    }
  }

  sync();
  const observer = new MutationObserver(sync);
  observer.observe(mount, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "aria-current", "href"] });
}

initPersistentMasthead();

createShell({ config: "./shell.json", mount, liveUpdates: false });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/offline-first-sw.js");
}
