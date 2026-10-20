// Notes overlay for packs, added to every pack page by files/bin/packs-server.py.
// the owner taps an element or selects text, writes a note, and sends the batch to the agent, which reads it with
// `packs-notes <pack>`. It lives in a shadow root, so the pack's CSS never reaches it and it never touches the pack's DOM
// apart from one host element. State lives on the server, so a reload or another device shows the same notes.
// The agent answers with `packs-notes reply`, and the answer shows under the note. A 2 s poll of the pack's version
// reloads the page when the pack is rebuilt (keeping the scroll position) and refetches notes when they change.
(() => {
  if (window.__packsNotes) return;
  window.__packsNotes = true;
  const match = location.pathname.match(/^\/packs\/([A-Za-z0-9][A-Za-z0-9_-]*)\//);
  if (!match) return;
  const api = `/packs/.notes/${match[1]}`;
  const page = () => location.pathname.slice(match[0].length - 1) + location.hash;

  const host = document.createElement("packs-notes");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; font: inherit; }
    .ui { --base: #1e1e2e; --mantle: #181825; --crust: #11111b; --s0: #313244; --s1: #45475a; --text: #cdd6f4;
      --sub: #a6adc8; --mauve: #cba6f7; --green: #a6e3a1; --peach: #fab387; --red: #f38ba8; --blue: #89b4fa;
      --on: #11111b; --shadow: rgba(0,0,0,.4);
      font-family: "JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, Menlo, monospace;
      font-size: 14px; line-height: 1.45; color: var(--text); -webkit-text-size-adjust: 100%; }
    @media (prefers-color-scheme: light) { .ui { --base: #eff1f5; --mantle: #e6e9ef; --crust: #dce0e8; --s0: #ccd0da;
      --s1: #bcc0cc; --text: #4c4f69; --sub: #6c6f85; --mauve: #8839ef; --green: #40a02b; --peach: #fe640b;
      --red: #d20f39; --blue: #1e66f5; --on: #eff1f5; --shadow: rgba(76,79,105,.18); } }
    button { cursor: pointer; border: 0; border-radius: 10px; padding: 10px 14px; min-height: 44px;
      background: var(--s0); color: var(--text); font-weight: 600; }
    button.primary { background: var(--mauve); color: var(--on); }
    button:disabled, button.primary:disabled { background: var(--s0); color: var(--sub); cursor: default; }
    button:focus-visible, textarea:focus-visible { outline: 2px solid var(--mauve); outline-offset: 2px; }
    .fab { position: fixed; z-index: 2147483646; right: max(16px, env(safe-area-inset-right));
      bottom: max(16px, env(safe-area-inset-bottom)); display: flex; align-items: center; gap: 8px;
      border-radius: 999px; padding: 10px 16px; background: var(--base); border: 1px solid var(--s1);
      box-shadow: 0 6px 24px var(--shadow); }
    .badge { min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px; background: var(--peach);
      color: var(--on); font-size: 12px; display: inline-flex; align-items: center; justify-content: center; }
    .badge.replies { background: var(--blue); }
    .panel { position: fixed; z-index: 2147483647; left: 0; right: 0; bottom: 0; max-height: min(78vh, 640px);
      display: flex; flex-direction: column; background: var(--base); border-top: 1px solid var(--s1);
      border-radius: 16px 16px 0 0; box-shadow: 0 -8px 32px var(--shadow);
      padding: 16px 16px max(16px, env(safe-area-inset-bottom)); }
    @media (min-width: 720px) { .panel { left: auto; right: 16px; bottom: 16px; width: 400px;
      border: 1px solid var(--s1); border-radius: 16px; } }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .title { font-weight: 700; font-size: 15px; }
    .x { background: transparent; color: var(--sub); padding: 8px 10px; min-width: 44px; }
    .tools { display: flex; align-items: center; gap: 4px; flex: none; }
    .link { background: transparent; color: var(--mauve); padding: 8px 10px; }
    .list { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; margin: 0 0 12px; }
    .empty { color: var(--sub); }
    .note { background: var(--mantle); border: 1px solid var(--s0); border-radius: 12px; padding: 10px 12px; min-width: 0; }
    .meta { display: flex; align-items: center; gap: 8px; color: var(--sub); font-size: 12px; margin-bottom: 4px; min-width: 0; }
    .state { border-radius: 6px; padding: 1px 6px; font-weight: 700; flex: none; }
    .state.draft { background: var(--s1); color: var(--text); }
    .state.sent { background: var(--green); color: var(--on); }
    .state.read { background: var(--s0); color: var(--sub); }
    .where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .quote { color: var(--sub); border-left: 2px solid var(--mauve); padding-left: 8px; margin: 4px 0;
      overflow-wrap: break-word; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .text { white-space: pre-wrap; overflow-wrap: break-word; }
    .reply { margin-top: 8px; padding: 6px 0 2px 10px; border-left: 2px solid var(--blue); }
    .reply .who { color: var(--blue); font-size: 12px; font-weight: 700; display: flex; gap: 8px; }
    .reply .who .new { color: var(--on); background: var(--blue); border-radius: 6px; padding: 0 6px; }
    .reply .who time { color: var(--sub); font-weight: 400; }
    .toast { position: fixed; z-index: 2147483646; left: 50%; transform: translateX(-50%);
      top: max(16px, env(safe-area-inset-top)); padding: 10px 16px; border-radius: 999px; background: var(--base);
      border: 1px solid var(--s1); box-shadow: 0 6px 24px var(--shadow); color: var(--sub); white-space: nowrap; }
    .row { display: flex; gap: 8px; }
    .row > button { flex: 1; }
    .small { display: flex; gap: 4px; margin-top: 6px; }
    .small button { min-height: 36px; padding: 6px 10px; font-size: 12px; background: transparent; color: var(--mauve); }
    .small button.del { color: var(--red); }
    textarea { width: 100%; min-height: 110px; resize: vertical; border-radius: 10px; border: 1px solid var(--s1);
      background: var(--mantle); color: var(--text); padding: 10px; font-size: 16px; margin: 4px 0 12px; }
    .bar { position: fixed; z-index: 2147483647; left: 0; right: 0; top: 0; display: flex; align-items: center;
      justify-content: space-between; gap: 12px; padding: max(10px, env(safe-area-inset-top)) 16px 10px;
      background: var(--base); border-bottom: 1px solid var(--s1); box-shadow: 0 6px 24px var(--shadow); }
    @media (min-width: 720px) { .bar { left: 50%; right: auto; top: 16px; transform: translateX(-50%); width: max-content;
      max-width: calc(100vw - 32px); padding: 8px 8px 8px 18px; border: 1px solid var(--s1); border-radius: 14px; } }
    .bar span { min-width: 0; }
    .bar .row { flex: none; }
    .bar button { white-space: nowrap; }
    .box { position: fixed; z-index: 2147483645; pointer-events: none; border: 2px solid var(--mauve);
      background: color-mix(in srgb, var(--mauve) 12%, transparent); border-radius: 4px; transition: all .08s; }
    .error { color: var(--red); margin: 0 0 10px; }
    [hidden] { display: none !important; }
  </style>
  <div class="ui">
    <button class="fab" part="fab" aria-label="Notes"><span>Notes</span><span class="badge drafts" hidden></span><span class="badge replies" hidden></span></button>
    <div class="toast" hidden role="status">Page updated</div>
    <div class="box" hidden></div>
    <div class="bar" hidden><span>Tap what the note is about</span>
      <div class="row"><button class="whole">Whole page</button><button class="cancel-pick">Cancel</button></div></div>
    <section class="panel list-panel" hidden role="dialog" aria-label="Notes">
      <div class="head"><span class="title">Notes for the agent</span>
        <span class="tools"><button class="link share">Share</button><button class="x close" aria-label="Close">✕</button></span></div>
      <p class="error" hidden></p>
      <div class="list"></div>
      <div class="row"><button class="add">Add note</button><button class="primary send">Send</button></div>
    </section>
    <section class="panel compose" hidden role="dialog" aria-label="New note">
      <div class="head"><span class="title">New note</span><button class="x cancel" aria-label="Cancel">✕</button></div>
      <div class="quote target"></div>
      <textarea placeholder="What should change?"></textarea>
      <p class="error" hidden></p>
      <div class="row"><button class="cancel">Cancel</button><button class="primary save">Save draft</button></div>
    </section>
  </div>`;
  const $ = (s) => root.querySelector(s);
  const ui = { fab: $(".fab"), drafts: $(".drafts"), replies: $(".replies"), toast: $(".toast"), box: $(".box"), bar: $(".bar"), listPanel: $(".list-panel"),
    list: $(".list"), send: $(".send"), compose: $(".compose"), target: $(".target"), text: $("textarea") };
  let notes = [];
  let target = null; // { element, quote, tag } for the note being written
  let picking = false;
  let selection = null; // the last non-empty text selection on the page, kept because tapping a button can clear it
  let version = null; // the last { pack, notes } version the server reported
  let reloadPending = false;
  const seenKey = `packs-notes-seen:${match[1]}`;
  const restoreKey = "packs-notes-restore";
  // How many replies this device has shown per note, so the button can say when the agent answered.
  const seen = (() => {
    try {
      return JSON.parse(localStorage.getItem(seenKey)) || {};
    } catch {
      return {};
    }
  })();

  const SHARE_NOTE = "Make a public share link for this pack (packs-share). Show me the files first.";
  // Plain names for what was tapped, shown before its text in the compose sheet.
  const KINDS = { a: "Link", button: "Button", img: "Image", svg: "Image", h1: "Heading", h2: "Heading", h3: "Heading",
    h4: "Heading", h5: "Heading", h6: "Heading", li: "List item", td: "Table cell", th: "Table cell", pre: "Code",
    code: "Code", input: "Field", textarea: "Field", select: "Field", summary: "Summary" };
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const textOf = (el) => clip((el.innerText || el.textContent || el.getAttribute("alt") || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(), 400);

  function selectorFor(el) {
    const parts = [];
    for (; el && el.nodeType === 1 && el !== document.documentElement; el = el.parentElement) {
      if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {
        parts.unshift("#" + CSS.escape(el.id));
        break;
      }
      let i = 1;
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) i++;
      parts.unshift(`${el.tagName.toLowerCase()}:nth-of-type(${i})`);
    }
    return parts.join(" > ");
  }

  // The nearest heading before the element, so the agent knows which section a note is about.
  function headingFor(el) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = el;
    for (let n = el; n; n = walker.previousNode()) {
      if (/^H[1-4]$/.test(n.tagName) && n.offsetParent !== null) return clip(n.textContent.replace(/\s+/g, " ").trim(), 200);
    }
    return "";
  }

  function frame(el) {
    const r = el.getBoundingClientRect();
    Object.assign(ui.box.style, { left: r.left - 3 + "px", top: r.top - 3 + "px", width: r.width + 6 + "px", height: r.height + 6 + "px" });
    ui.box.hidden = false;
  }

  function showError(panel, message) {
    const p = panel.querySelector(".error");
    p.textContent = message || "";
    p.hidden = !message;
  }

  async function call(method, path = "", body) {
    const res = await fetch(api + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `the server answered ${res.status}`);
    return res.json();
  }

  async function load() {
    try {
      notes = (await call("GET")).notes;
      showError(ui.listPanel, "");
    } catch (e) {
      showError(ui.listPanel, `Could not load notes: ${e.message}`);
    }
    render();
  }

  function render() {
    const drafts = notes.filter((n) => n.state === "draft").length;
    const open = !ui.listPanel.hidden;
    const fresh = (n) => (n.replies || []).length - (seen[n.id] || 0);
    const unseen = open ? 0 : notes.reduce((sum, n) => sum + Math.max(0, fresh(n)), 0);
    ui.drafts.textContent = drafts;
    ui.drafts.hidden = !drafts;
    ui.replies.textContent = unseen === 1 ? "1 reply" : `${unseen} replies`;
    ui.replies.hidden = !unseen;
    ui.fab.setAttribute("aria-label", ["Notes", drafts && `${drafts} not sent`, unseen && `${unseen} new from the agent`]
      .filter(Boolean).join(", "));
    ui.send.textContent = drafts ? `Send ${drafts} to agent` : "Send to agent";
    ui.send.disabled = !drafts;
    const scroll = ui.list.scrollTop;
    ui.list.replaceChildren();
    if (!notes.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No notes yet. Add one, or select text first and then tap Notes.";
      ui.list.append(p);
    }
    for (const n of [...notes].reverse()) {
      const card = document.createElement("div");
      card.className = "note";
      const meta = document.createElement("div");
      meta.className = "meta";
      const state = document.createElement("span");
      state.className = `state ${n.state}`;
      state.textContent = n.state;
      const where = document.createElement("span");
      where.className = "where";
      where.textContent = [n.page !== page() ? n.page : "", n.heading].filter(Boolean).join(" › ") || "this page";
      meta.append(state, where);
      card.append(meta);
      if (n.quote) {
        const q = document.createElement("div");
        q.className = "quote";
        q.textContent = n.quote;
        card.append(q);
      }
      const t = document.createElement("div");
      t.className = "text";
      t.textContent = n.note;
      card.append(t);
      (n.replies || []).forEach((r, i) => {
        const reply = document.createElement("div");
        reply.className = "reply";
        const who = document.createElement("div");
        who.className = "who";
        who.append("Agent");
        if (i >= (seen[n.id] || 0)) {
          const badge = document.createElement("span");
          badge.className = "new";
          badge.textContent = "new";
          who.append(badge);
        }
        const at = document.createElement("time");
        at.dateTime = r.at;
        at.textContent = when(r.at);
        who.append(at);
        const text = document.createElement("div");
        text.className = "text";
        text.textContent = r.text;
        reply.append(who, text);
        card.append(reply);
      });
      const actions = document.createElement("div");
      actions.className = "small";
      if (n.selector && n.page === page()) {
        const show = document.createElement("button");
        show.textContent = "Show";
        show.onclick = () => reveal(n.selector);
        actions.append(show);
      }
      if (n.state === "draft") {
        const del = document.createElement("button");
        del.className = "del";
        del.textContent = "Delete";
        del.onclick = async () => {
          try {
            await call("DELETE", "/" + n.id);
          } catch (e) {
            showError(ui.listPanel, `Could not delete: ${e.message}`);
          }
          load();
        };
        actions.append(del);
      }
      if (actions.children.length) card.append(actions);
      ui.list.append(card);
    }
    ui.list.scrollTop = scroll;
    if (open) {
      for (const n of notes) seen[n.id] = (n.replies || []).length;
      try {
        localStorage.setItem(seenKey, JSON.stringify(seen));
      } catch {}
    }
  }

  // "14:32" today, "20 Oct 14:32" before that. The server writes +0800-style offsets, which Date parses after a colon.
  function when(at) {
    const d = new Date(String(at).replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
    if (isNaN(d)) return "";
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    return d.toDateString() === new Date().toDateString() ? time
      : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
  }

  function reveal(selector) {
    let el;
    try {
      el = document.querySelector(selector);
    } catch {}
    if (!el) return showError(ui.listPanel, "That element is no longer on the page.");
    ui.listPanel.hidden = true;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => frame(el), 350);
    setTimeout(() => { ui.box.hidden = true; ui.listPanel.hidden = false; }, 2200);
  }

  // Every way out of pick mode (the list, compose, close, cancel) goes through here, so none of them leaves the page's
  // taps intercepted or the bar and highlight showing.
  function stopPicking() {
    picking = false;
    ui.bar.hidden = ui.box.hidden = true;
  }

  function openList() {
    stopPicking();
    ui.compose.hidden = true;
    ui.listPanel.hidden = false;
    ui.fab.hidden = true;
    load();
  }

  function closeAll() {
    stopPicking();
    ui.listPanel.hidden = ui.compose.hidden = true;
    ui.fab.hidden = false;
  }

  function compose(t, text = "") {
    target = t;
    stopPicking();
    ui.listPanel.hidden = ui.fab.hidden = true;
    const kind = KINDS[t.tag];
    ui.target.textContent = t.quote ? `${kind ? kind + ": " : ""}${clip(t.quote, 240)}` : "The whole page";
    ui.text.value = text;
    showError(ui.compose, "");
    ui.compose.hidden = false;
    if (t.element) frame(t.element);
    ui.text.focus({ preventScroll: true });
    ui.text.setSelectionRange(text.length, text.length);
  }

  function startPicking() {
    picking = true;
    ui.listPanel.hidden = ui.fab.hidden = true;
    ui.bar.hidden = false;
  }

  const inside = (e) => e.composedPath().includes(host);
  // Capture phase, so a tap on a link or tab picks it instead of following it, and the page's own handlers never see
  // it. Pointer and touch events are stopped but not cancelled: cancelling them makes a phone (WebKit) skip the click,
  // so a tap would pick nothing.
  for (const type of ["click", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"]) {
    document.addEventListener(type, (e) => {
      if (!picking || inside(e)) return;
      if (type === "click" || type.startsWith("mouse")) e.preventDefault();
      e.stopPropagation();
      if (type !== "click") return;
      const el = e.target instanceof Element ? e.target : e.target.parentElement;
      if (el) compose({ element: el, quote: textOf(el), tag: el.tagName.toLowerCase() });
    }, true);
  }
  document.addEventListener("mousemove", (e) => {
    if (picking && !inside(e) && e.target instanceof Element) frame(e.target);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (picking || !ui.compose.hidden || !ui.listPanel.hidden)) closeAll();
  });
  document.addEventListener("selectionchange", () => {
    const s = document.getSelection();
    const text = s && s.rangeCount ? s.toString().replace(/\s+/g, " ").trim() : "";
    if (!text) return;
    const node = s.getRangeAt(0).commonAncestorContainer;
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (element && !host.contains(element)) selection = { element, quote: clip(text, 1000), tag: "", at: Date.now() };
  });

  ui.fab.addEventListener("click", () => {
    const s = document.getSelection();
    const live = s && s.toString().trim();
    // A selection made in the last minute that the tap did not clear, or one the tap cleared just now.
    if (selection && (live || Date.now() - selection.at < 1500)) {
      const t = selection;
      selection = null;
      s && s.removeAllRanges();
      return compose(t);
    }
    openList();
  });
  $(".close").onclick = closeAll;
  $(".add").onclick = startPicking;
  $(".whole").onclick = () => compose({ element: null, quote: "", tag: "" });
  // Share asks the agent for a public read-only copy (scripts/packs-share) through an ordinary note. The page never
  // publishes anything itself: the agent shows the owner the file list and waits for his yes in the chat.
  $(".share").onclick = () => compose({ element: null, quote: "", tag: "" }, SHARE_NOTE);
  $(".cancel-pick").onclick = openList;
  for (const b of root.querySelectorAll(".cancel")) b.onclick = openList;
  $(".save").onclick = async () => {
    const note = ui.text.value.trim();
    if (!note) return showError(ui.compose, "Write the note first.");
    const el = target.element;
    try {
      await call("POST", "", { page: page(), selector: el ? selectorFor(el) : "", tag: target.tag,
        heading: el ? headingFor(el) : "", quote: target.quote, note });
    } catch (e) {
      return showError(ui.compose, `Could not save: ${e.message}`);
    }
    openList();
  };
  ui.send.onclick = async () => {
    try {
      await call("POST", "/send", {});
    } catch (e) {
      showError(ui.listPanel, `Could not send: ${e.message}`);
    }
    load();
  };

  // Live reload. A rebuilt pack reloads the page, but never while the owner is picking or writing a note: the reload waits
  // until he saves or cancels. The scroll position and an open notes panel survive the reload.
  const busy = () => picking || !ui.compose.hidden;
  async function poll() {
    if (document.hidden) return;
    let next;
    try {
      next = await call("GET", "/version");
    } catch {
      return;
    }
    if (version && next.pack !== version.pack) reloadPending = true;
    if (version && next.notes !== version.notes) load();
    version = next;
    if (reloadPending && !busy()) {
      sessionStorage.setItem(restoreKey, JSON.stringify({ path: location.pathname, x: scrollX, y: scrollY,
        panel: !ui.listPanel.hidden }));
      location.reload();
    }
  }

  function restore() {
    let saved;
    try {
      saved = JSON.parse(sessionStorage.getItem(restoreKey));
    } catch {}
    sessionStorage.removeItem(restoreKey);
    if (!saved || saved.path !== location.pathname) return;
    const go = () => {
      scrollTo(saved.x, saved.y);
      if (saved.panel) openList();
      ui.toast.hidden = false;
      setTimeout(() => (ui.toast.hidden = true), 1800);
    };
    document.readyState === "complete" ? go() : addEventListener("load", go, { once: true });
  }

  document.documentElement.append(host);
  load();
  restore();
  poll();
  setInterval(poll, 2000);
  document.addEventListener("visibilitychange", poll);
})();
