/* cm-update.js — avviso "nuova versione disponibile".
   Identico per tutti i locali, nessuna config. Confronta ETag/Last-Modified di
   index.html e degli script locali (manager.js…) con quelli al caricamento:
   se cambiano dopo un deploy mostra un banner con "Ricarica". Mai reload automatico
   (non si perde lavoro non salvato). */
(function () {
  "use strict";
  if (window.__cmUpdate) return;
  window.__cmUpdate = true;

  var INTERVAL = 60 * 1000;
  var urls = [location.pathname];
  Array.prototype.forEach.call(document.querySelectorAll("script[src]"), function (s) {
    var u = new URL(s.getAttribute("src"), location.href);
    if (u.origin === location.origin && !/cm-update\.js$/.test(u.pathname)) urls.push(u.pathname);
  });

  var base = null, shown = false, busy = false;

  function sig(u) {
    return fetch(u, { method: "HEAD", cache: "no-store" }).then(function (r) {
      if (!r.ok) throw 0;
      return r.headers.get("etag") || r.headers.get("last-modified") || r.headers.get("content-length") || "";
    });
  }

  function check() {
    if (busy || shown || document.hidden || navigator.onLine === false) return;
    busy = true;
    Promise.all(urls.map(sig)).then(function (s) {
      var cur = s.join("|");
      if (base === null) base = cur;
      else if (cur !== base) show();
    }).catch(function () {}).then(function () { busy = false; });
  }

  function reload(btn) {
    btn.disabled = true;
    btn.textContent = "Aggiorno…";
    // Rinfresca la cache HTTP (max-age 600 di GitHub Pages) prima del reload.
    Promise.all(urls.map(function (u) { return fetch(u, { cache: "reload" }).catch(function () {}); }))
      .then(function () { location.reload(); });
  }

  function show() {
    shown = true;
    var st = document.createElement("style");
    st.textContent =
      "#cm-upd{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);" +
      "z-index:2147483000;display:flex;align-items:center;gap:12px;max-width:calc(100vw - 32px);box-sizing:border-box;" +
      "padding:10px 10px 10px 16px;border-radius:12px;background:#1c1c1e;color:#fff;font:500 14px/1.35 system-ui,-apple-system,sans-serif;" +
      "box-shadow:0 8px 28px rgba(0,0,0,.28)}" +
      "#cm-upd b{font-weight:600}" +
      "#cm-upd button{flex:none;border:0;border-radius:8px;padding:8px 14px;font:600 14px system-ui,-apple-system,sans-serif;cursor:pointer}" +
      "#cm-upd .go{background:#fff;color:#1c1c1e}#cm-upd .x{background:transparent;color:#aaa;padding:8px;display:inline-flex}";
    var el = document.createElement("div");
    el.id = "cm-upd";
    el.setAttribute("role", "status");
    el.innerHTML = "<span><b>Nuova versione disponibile.</b> Salva quello che stai facendo e ricarica.</span>" +
      "<button class='go' type='button'>Ricarica</button><button class='x' type='button' aria-label='Più tardi'><svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' aria-hidden='true'><path d='M6 6l12 12M18 6 6 18'/></svg></button>";
    el.querySelector(".go").onclick = function () { reload(this); };
    // "Più tardi": nasconde e ripropone tra 10 minuti.
    el.querySelector(".x").onclick = function () {
      el.remove();
      setTimeout(function () { document.body.appendChild(el); }, 10 * 60 * 1000);
    };
    document.head.appendChild(st);
    document.body.appendChild(el);
  }

  check();
  setInterval(check, INTERVAL);
  document.addEventListener("visibilitychange", check);
  window.addEventListener("online", check);
})();
