// Injected into every page of a tutorial recording (page.addInitScript). Draws a fake cursor, click ripple,
// highlight ring, caption bar and title/outro cards. State survives navigations through sessionStorage.
(() => {
  const S = sessionStorage;
  const css = `
  #tut-cursor{position:fixed;z-index:2147483647;left:0;top:0;width:26px;height:26px;pointer-events:none;
    transition:transform 520ms cubic-bezier(.4,0,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
  #tut-ring{position:fixed;z-index:2147483645;pointer-events:none;border:3px solid #6366f1;border-radius:10px;
    box-shadow:0 0 0 6px rgba(99,102,241,.22);opacity:0;transition:opacity 200ms}
  .tut-ripple{position:fixed;z-index:2147483646;pointer-events:none;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;
    background:rgba(99,102,241,.45);animation:tutr 600ms ease-out forwards}
  @keyframes tutr{to{transform:scale(4.5);opacity:0}}
  #tut-cap{position:fixed;z-index:2147483646;left:50%;bottom:22px;transform:translateX(-50%);max-width:1080px;width:calc(100% - 80px);
    display:flex;gap:14px;align-items:center;padding:14px 22px;border-radius:14px;background:rgba(17,17,27,.92);color:#fff;
    font:600 22px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3);pointer-events:none}
  #tut-cap b{flex:none;display:inline-grid;place-items:center;min-width:34px;height:34px;border-radius:999px;background:#6366f1;font-size:18px}
  #tut-card{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:linear-gradient(135deg,#0f0f1a,#1e1b4b);
    color:#fff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;pointer-events:none}
  #tut-card .in{max-width:900px;padding:40px;text-align:left}
  #tut-card .k{font:600 18px/1 system-ui;letter-spacing:.12em;text-transform:uppercase;color:#a5b4fc}
  #tut-card h1{margin:18px 0 0;font:700 52px/1.1 system-ui}
  #tut-card p{margin:22px 0 0;font:400 26px/1.45 system-ui;color:#e0e7ff}
  #tut-card ul{margin:20px 0 0;padding-left:28px;font:400 24px/1.6 system-ui;color:#e0e7ff}`;
  const svg = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  function ensure() {
    if (!document.body) return false;
    if (!document.getElementById("tut-style")) {
      const st = document.createElement("style"); st.id = "tut-style"; st.textContent = css; document.head.appendChild(st);
    }
    if (!document.getElementById("tut-cursor")) {
      const c = document.createElement("div"); c.id = "tut-cursor"; c.innerHTML = svg;
      const p = JSON.parse(S.getItem("tut-pos") || "[640,400]");
      c.style.transition = "none"; c.style.transform = `translate(${p[0]}px,${p[1]}px)`;
      document.body.appendChild(c); void c.offsetWidth; c.style.transition = "";
      const r = document.createElement("div"); r.id = "tut-ring"; document.body.appendChild(r);
    }
    const cap = S.getItem("tut-cap");
    let el = document.getElementById("tut-cap");
    if (cap) {
      if (!el) { el = document.createElement("div"); el.id = "tut-cap"; document.body.appendChild(el); }
      const [n, t] = JSON.parse(cap);
      const html = (n ? `<b>${n}</b>` : "") + `<span>${esc(t)}</span>`;
      if (el.innerHTML !== html) el.innerHTML = html;
    } else if (el) el.remove();
    const card = S.getItem("tut-card");
    let ce = document.getElementById("tut-card");
    if (card) {
      if (!ce) { ce = document.createElement("div"); ce.id = "tut-card"; document.body.appendChild(ce); }
      if (ce.dataset.v !== card) { ce.dataset.v = card; ce.innerHTML = JSON.parse(card); }
    } else if (ce) ce.remove();
    return true;
  }
  window.__tut = {
    move(x, y) { ensure(); S.setItem("tut-pos", JSON.stringify([x, y])); document.getElementById("tut-cursor").style.transform = `translate(${x}px,${y}px)`; },
    ring(b) {
      ensure(); const r = document.getElementById("tut-ring");
      if (!b) { r.style.opacity = "0"; return; }
      Object.assign(r.style, { left: b.x - 6 + "px", top: b.y - 6 + "px", width: b.width + 12 + "px", height: b.height + 12 + "px", opacity: "1" });
    },
    ripple(x, y) { ensure(); const d = document.createElement("div"); d.className = "tut-ripple"; d.style.left = x + "px"; d.style.top = y + "px"; document.body.appendChild(d); setTimeout(() => d.remove(), 700); },
    caption(n, t) { if (t == null) S.removeItem("tut-cap"); else S.setItem("tut-cap", JSON.stringify([n, t])); ensure(); },
    card(kicker, title, sub, list) {
      if (title == null) S.removeItem("tut-card");
      else S.setItem("tut-card", JSON.stringify(`<div class="in"><div class="k">${esc(kicker)}</div><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ""}${list && list.length ? `<ul>${list.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}</div>`));
      ensure();
    },
  };
  // Re-apply overlay whenever the app re-renders (client navigations replace parts of the DOM).
  const tick = () => { try { ensure(); } catch {} };
  document.addEventListener("DOMContentLoaded", tick);
  setInterval(tick, 150);
})();
