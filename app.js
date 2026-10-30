// Purple Knight – website (home, level select, leaderboards) + Godot startup.
// Screens are hash routes: #/ (home + account), #/levels, #/level/<id>.
// The engine loads right away in the background (download + WebAssembly) but
// only starts on the first "Play"/"Watch" click (which also unlocks audio);
// Godot then loads just that level. "Leaderboard" in the game comes back to
// #/level/<id>. Settings (volumes, keys) live in localStorage "pk_settings",
// which the game reads too.
(() => {
  "use strict";

  // Same order and ids as scripts/web/web_config.gd (WebConfig.LEVELS)
  const LEVELS = [
    { id: "Level1", title: "Level 1", subtitle: "The Basics" },
    { id: "Level4", title: "Level 2", subtitle: "Spike Caves" },
    { id: "Level5", title: "Level 3", subtitle: "Into the Ruins" },
    { id: "Level2", title: "Level 4", subtitle: "Moving Platforms" },
    { id: "Level3", title: "Level 5", subtitle: "The Long Way" },
  ];
  const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
  const LB_LIMIT = 50;   // rows per level; the API allows up to 200

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);
  const levelInfo = (id) => LEVELS.find((l) => l.id === id);
  const site = $("site");
  const game = $("game");
  const canvas = $("canvas");
  const playBtn = $("play");
  const playLabel = $("play-label");
  const playProgress = $("play-progress");

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
    remove(key) { try { localStorage.removeItem(key); } catch {} },
  };

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;   // textContent: never insert names as HTML
    return e;
  };
  const fmt = (ms) => {
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    return `${m}:${String(s).padStart(2, "0")}.${String(r).padStart(3, "0")}`;
  };
  // "Top 4.2%" – share of players at or above this rank
  const percentile = (rank, total) => {
    const p = (rank / total) * 100;
    return "Top " + (p < 10 ? Math.max(0.1, Math.round(p * 10) / 10) : Math.round(p)) + "%";
  };
  const setStatus = (e, text, kind = "") => { e.textContent = text; e.className = "small " + kind; };

  // ── Load engine ────────────────────────────────────────────────────────────
  let engine = null;
  let ready = false;
  let started = false;
  let pending = null;        // {method, args} to call on window.pkGodot once it is ready

  function setProgress(current, total) {
    if (ready) return;   // the engine reports progress again on start – keep "PLAY"
    if (total > 0) {
      const pct = Math.min(100, Math.round((current / total) * 100));
      playProgress.style.width = pct + "%";
      playLabel.textContent = "LOADING … " + pct + "%";
      $("load-hint").textContent = "The game is loading in the background … " + pct + "%";
    }
  }

  function preload() {
    const missing = Engine.getMissingFeatures({ threads: window.GODOT_THREADS_ENABLED });
    if (missing.length) {
      playLabel.textContent = "NOT SUPPORTED";
      const warn = $("unsupported");
      warn.textContent = "Your browser cannot run the game: " + missing.join(", ");
      warn.hidden = false;
      $("load-hint").hidden = true;
      return;
    }
    const config = Object.assign({}, window.GODOT_CONFIG, { onProgress: setProgress });
    engine = new Engine(config);
    const exe = config.executable;
    const pack = config.mainPack || exe + ".pck";
    Promise.all([engine.init(exe), engine.preloadFile(pack, pack)])
      .then(() => {
        ready = true;
        playBtn.disabled = false;
        $("watch").disabled = false;
        playLabel.textContent = "PLAY";
        setPlayHint("");
        $("load-hint").textContent = "Ready! Keyboard recommended.";
        engine.__pack = pack;
      })
      .catch((err) => {
        console.error(err);
        playLabel.textContent = "LOADING FAILED";
        $("play-hint").textContent = "Please reload the page.";
        $("load-hint").textContent = "Loading failed – please reload the page.";
      });
  }

  function showGame() {
    site.hidden = true;
    game.hidden = false;
    document.body.classList.add("playing");
    window.scrollTo(0, 0);
    canvas.focus();
  }

  // Calls window.pkGodot[method](...args) – right away, or once the engine runs.
  function runInGame(method, args) {
    showGame();
    if (started) {
      if (window.pkGodot) window.pkGodot[method](...args);
      return;
    }
    started = true;
    pending = { method, args };
    $("game-loading").hidden = false;
    engine
      .start({ args: ["--main-pack", engine.__pack] })
      .then(() => {
        $("game-loading").hidden = true;
        canvas.focus();
      })
      .catch((err) => {
        console.error(err);
        $("game-loading").innerHTML = "<p>The game could not start. Please reload the page.</p>";
      });
  }

  // Called by Godot once its bridge (window.pkGodot) exists.
  window.pkOnGodotReady = () => {
    const call = pending;
    pending = null;
    // Not from inside Godot's eval call: start on the next tick
    if (call) setTimeout(() => window.pkGodot[call.method](...call.args), 0);
  };

  // Called by Godot ("Leaderboard"/"Exit"): back to the site, at the
  // leaderboard of the level that was just played (with an optional message).
  window.pkShowSite = (levelId, message) => {
    settings = loadSettings();   // keys may have been changed in the game
    renderKeysList();
    game.hidden = true;
    site.hidden = false;
    document.body.classList.remove("playing");
    setPlayHint(message || "", message ? "err" : "");
    const target = levelInfo(levelId) ? "#/level/" + levelId : location.hash;
    if (location.hash !== target) location.hash = target;   // hashchange renders
    else route();
  };

  // ── Play / Watch with the chosen ghosts ─────────────────────────────────────
  // A ghost pick: "" = none, "@me" = own best (online, or this device's best
  // run for guests), otherwise a player name from the leaderboard.
  const MAX_WATCH = 5;
  let race = "@me";        // ghost raced with "Play"
  let watchPicks = [];     // ghosts shown by "Watch"
  let pickMode = false;    // leaderboard clicks toggle watchPicks instead of setting race
  let busy = false;

  const defaultHint = () => "Enter = play · keyboard recommended";
  function setPlayHint(text, kind = "") {
    $("play-hint").textContent = text || (ready ? defaultHint() : "");
    $("play-hint").className = "hint" + (kind ? " " + kind : "");
  }

  // → "" | "local" | {name, time_ms, replay} (what Godot's bridge expects)
  async function resolveGhost(pick) {
    if (!pick) return "";
    if (pick === "@me" && !account.code) return "local";
    const name = pick === "@me" ? account.name : pick;
    try {
      return await api("GET", `/api/replay/${currentLevel}/${encodeURIComponent(name)}`);
    } catch (err) {
      if (pick === "@me") return "local";   // no online run yet: best run of this device
      throw new Error(err.status === 404 ? `No replay of ${name} available` : err.message);
    }
  }

  async function start(watch) {
    if (!ready || busy || !levelInfo(currentLevel)) return;
    const picks = watch ? watchPicks.slice() : [race];
    if (watch && !picks.length) {
      setPickMode(true);
      return setPlayHint("Click up to 5 players in the leaderboard, then Watch.");
    }
    busy = true;
    setPlayHint("Loading ghost …");
    try {
      const ghosts = await Promise.all(picks.map(resolveGhost));
      setPlayHint("");
      const level = currentLevel;
      if (watch) runInGame("watch", [level, JSON.stringify(ghosts)]);
      else runInGame("startLevel", [level, typeof ghosts[0] === "string" ? ghosts[0] : JSON.stringify(ghosts[0])]);
    } catch (err) {
      setPlayHint(err.message, "err");
    } finally {
      busy = false;
    }
  }
  playBtn.addEventListener("click", () => start(false));
  $("watch").addEventListener("click", () => start(true));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && window.pkGodot) window.pkGodot.pause();
  });
  window.addEventListener("keydown", (e) => {
    // Arrow keys/space must not scroll the page while playing.
    if (!game.hidden) {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) e.preventDefault();
      return;
    }
    if (dialog.open || settingsDialog.open) return;
    const onBody = document.activeElement === document.body || !document.activeElement;
    if (e.key === "Enter" && onBody && currentScreen === "level") start(false);
    if (e.key === "Escape" && currentScreen === "level") location.hash = "#/levels";
    else if (e.key === "Escape" && currentScreen === "levels") location.hash = "#/";
  }, { passive: false });

  // ── API ─────────────────────────────────────────────────────────────────────
  const API = String((window.PK_CONFIG && window.PK_CONFIG.api) || "").replace(/\/+$/, "");

  async function api(method, path, { body, code } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (code) headers.Authorization = "Bearer " + code;
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Error("Server unreachable");
    }
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || "Error " + res.status);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ── Account ──────────────────────────────────────────────────────────────────
  // The code only lives in localStorage (pk_code); the server only knows its hash.
  // pk_guest = the player chose "Play as guest" (no welcome dialog any more).
  const account = {
    get code() { return store.get("pk_code"); },
    get name() { return store.get("pk_name"); },
    save(name, code) { store.set("pk_name", name); store.set("pk_code", code); store.remove("pk_guest"); },
    clear() { store.remove("pk_name"); store.remove("pk_code"); },
  };
  let me = null;          // last /api/me response: {name, bests: {LevelN: {time_ms, rank, total}}}
  let codeVisible = false;

  function notifyGodot() {
    if (window.pkGodot && window.pkGodot.accountChanged) window.pkGodot.accountChanged();
  }

  function renderAccount() {
    const loggedIn = !!account.code;
    $("acc-guest").hidden = loggedIn;
    $("acc-user").hidden = !loggedIn;
    $("levels-player").textContent = loggedIn ? "Player: " + account.name : "Guest – times are not uploaded";
    if (!loggedIn) return;
    $("acc-name").textContent = account.name;
    $("acc-code").textContent = codeVisible ? account.code : "••••-••••-••••";
    $("code-toggle").textContent = codeVisible ? "Hide" : "Show";
    // Own bests per level
    const bests = $("acc-bests");
    const rows = LEVELS.filter((l) => me && me.bests && me.bests[l.id]).map((l) => {
      const b = me.bests[l.id];
      const a = el("a", "acc-best");
      a.href = "#/level/" + l.id;
      a.append(el("span", "", l.title), el("span", "hl", "#" + b.rank), el("span", "num", fmt(b.time_ms)));
      return a;
    });
    bests.replaceChildren(...(rows.length ? [el("h3", "", "Your bests"), ...rows] : []));
  }

  // Re-render whatever is visible after an account change
  function accountChanged() {
    renderAccount();
    renderScreen();
    notifyGodot();
  }

  async function refreshMe() {
    if (!account.code || !API) { me = null; return; }
    try {
      me = await api("GET", "/api/me", { code: account.code });
      if (me.name !== account.name) { account.save(me.name, account.code); notifyGodot(); }
      setStatus($("acc-status"), "");
    } catch (err) {
      me = null;
      if (err.status === 401) {
        // Account no longer exists – sign out locally
        account.clear();
        notifyGodot();
        if (!game.hidden) return renderAccount();   // never over the running game
        openAccountDialog(true);
        setStatus($("restore-status"), "Your saved code is no longer valid. Please sign in again.", "err");
      } else {
        setStatus($("acc-status"), err.message, "err");
      }
    }
    renderAccount();
  }

  $("code-toggle").addEventListener("click", () => { codeVisible = !codeVisible; renderAccount(); });
  $("code-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(account.code);
      setStatus($("acc-status"), "Code copied!", "ok");
    } catch {
      codeVisible = true;
      renderAccount();
      setStatus($("acc-status"), "Copying not possible – please write the code down.", "err");
    }
  });
  $("logout").addEventListener("click", () => {
    if (!confirm("Sign out? Without your code (" + account.code + ") you cannot get back into this account.")) return;
    account.clear();
    store.set("pk_guest", "1");
    me = null;
    codeVisible = false;
    accountChanged();
  });
  $("delete-account").addEventListener("click", async () => {
    if (!confirm("Permanently delete account \"" + account.name + "\" and all its online times?")) return;
    try {
      await api("DELETE", "/api/me", { code: account.code });
      account.clear();
      store.set("pk_guest", "1");
      me = null;
      accountChanged();
    } catch (err) {
      setStatus($("acc-status"), err.message, "err");
    }
  });

  // ── Account dialog ───────────────────────────────────────────────────────────
  const dialog = $("account-dialog");

  function openAccountDialog(restore = false) {
    $("dlg-forms").hidden = false;
    $("dlg-created").hidden = true;
    if (!dialog.open) dialog.showModal();
    showAccountForm(restore);
  }
  $$("[data-open-account]").forEach((b) => b.addEventListener("click", () => openAccountDialog(false)));

  // Closing without an account (guest link, Esc) = play as guest
  dialog.addEventListener("close", () => {
    if (!account.code) store.set("pk_guest", "1");
  });
  $("play-guest").addEventListener("click", () => dialog.close());
  $("dlg-done").addEventListener("click", () => dialog.close());

  // "New account" / "I have a code" switch
  function showAccountForm(restore) {
    $("seg-create").setAttribute("aria-selected", String(!restore));
    $("seg-restore").setAttribute("aria-selected", String(restore));
    $("create-form").hidden = restore;
    $("create-status").hidden = restore;
    $("restore-form").hidden = !restore;
    $("restore-status").hidden = !restore;
    (restore ? $("restore-code") : $("create-name")).focus();
  }
  $("seg-create").addEventListener("click", () => showAccountForm(false));
  $("seg-restore").addEventListener("click", () => showAccountForm(true));

  $("create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("create-status");
    const name = $("create-name").value.trim();
    if (!NAME_RE.test(name)) return setStatus(status, "Invalid: 3–16 characters, only letters, digits, _ and -", "err");
    setStatus(status, "Creating …");
    try {
      const data = await api("POST", "/api/accounts", { body: { name } });
      account.save(data.name, data.code);
      me = { name: data.name, bests: {} };
      setStatus(status, "3–16 letters, digits, _ or -");
      // Second step: show the recovery code
      $("dlg-name").textContent = data.name;
      $("dlg-code").textContent = data.code;
      setStatus($("dlg-status"), "");
      $("dlg-forms").hidden = true;
      $("dlg-created").hidden = false;
      $("dlg-copy").focus();
      accountChanged();
    } catch (err) {
      setStatus(status, err.message, "err");
    }
  });
  $("dlg-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(account.code);
      setStatus($("dlg-status"), "Code copied!", "ok");
    } catch {
      setStatus($("dlg-status"), "Copying not possible – please write the code down.", "err");
    }
  });

  $("restore-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("restore-status");
    const raw = $("restore-code").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (raw.length !== 12) return setStatus(status, "The code has 12 characters, e.g. K7XQ-92PM-4LTA", "err");
    const code = raw.match(/.{4}/g).join("-");
    setStatus(status, "Checking …");
    try {
      me = await api("GET", "/api/me", { code });
      account.save(me.name, code);
      codeVisible = false;
      $("restore-code").value = "";
      setStatus(status, "");
      dialog.close();
      accountChanged();
    } catch (err) {
      setStatus(status, err.status === 401 ? "Code not found – please check it." : err.message, "err");
    }
  });

  // ── Level select ─────────────────────────────────────────────────────────────
  const records = {};   // level id -> leaderboard entry #1 (or null)

  function renderLevelCards() {
    const cards = LEVELS.map((lvl, i) => {
      const card = el("a", "card");
      card.href = "#/level/" + lvl.id;
      const head = el("div", "card-head");
      const names = el("div");
      names.append(el("strong", "", lvl.title.toUpperCase()), el("span", "small muted", lvl.subtitle));
      head.append(el("span", "card-num", String(i + 1)), names);
      const thumb = el("div", "thumb");
      thumb.style.backgroundImage = `url("img/thumb_${lvl.id}.png")`;
      const rec = records[lvl.id];
      const mine = me && me.bests && me.bests[lvl.id];
      const stats = el("dl", "card-stats");
      stats.append(
        el("dt", "", "Record"),
        el("dd", "rec", rec ? `${rec.name}  ${fmt(rec.time_ms)}` : rec === null ? "--" : "…"),
        el("dt", "", "Your best"),
        el("dd", "mine", mine ? `${fmt(mine.time_ms)}  #${mine.rank}` : "--"));
      card.append(head, thumb, stats);
      return card;
    });
    $("level-cards").replaceChildren(...cards);
  }

  async function loadRecords() {
    if (!API) return;
    await Promise.all(LEVELS.map(async (lvl) => {
      try {
        const data = await api("GET", "/api/leaderboard/" + lvl.id + "?limit=1");
        records[lvl.id] = data.entries[0] || null;
      } catch {
        records[lvl.id] = null;
      }
    }));
    if (currentScreen === "levels") renderLevelCards();
  }

  // ── Level screen: leaderboard + own rank ─────────────────────────────────────
  let currentLevel = LEVELS[0].id;
  let lbRequest = 0;
  let lbEntries = [];   // leaderboard rows of currentLevel (for the ghost pickers)

  function lbRow(rank, name, time, cls = "") {
    const tr = el("tr", cls);
    [rank, name, time].forEach((v, i) => tr.appendChild(el("td", i === 2 ? "num" : "", v)));
    return tr;
  }

  function renderStats(entries) {
    const loggedIn = !!account.code;
    $("stats-user").hidden = !loggedIn;
    $("stats-guest").hidden = loggedIn;
    const mine = me && me.bests && me.bests[currentLevel];
    $("st-rank").textContent = mine ? "#" + mine.rank : "--";
    $("st-pct").textContent = mine ? percentile(mine.rank, mine.total) : "--";
    $("st-best").textContent = mine ? fmt(mine.time_ms) : "--";
    const top = entries && entries[0];
    $("st-gap").textContent = mine && top
      ? (mine.rank === 1 ? "Record!" : "+" + fmt(Math.max(0, mine.time_ms - top.time_ms)))
      : "--";
    $("st-rank").title = mine ? `of ${mine.total} players` : "No run yet";
  }

  async function renderLeaderboard() {
    const levelId = currentLevel;
    const req = ++lbRequest;
    const body = $("lb-body");
    const status = $("lb-status");
    renderStats(null);
    if (!API) {
      body.replaceChildren(lbRow("-", "No server configured", "-:--.---", "placeholder"));
      return;
    }
    setStatus(status, "Loading …", "muted");
    try {
      const data = await api("GET", "/api/leaderboard/" + levelId + "?limit=" + LB_LIMIT);
      if (req !== lbRequest) return;
      records[levelId] = data.entries[0] || null;
      const own = account.code && account.name && account.name.toLowerCase();
      lbEntries = data.entries;
      const rows = data.entries.map((e) => {
        const isMe = own && e.name.toLowerCase() === own;
        return pickableRow(lbRow(e.rank, e.name, fmt(e.time_ms), isMe ? "me" : ""), isMe ? "@me" : e.name);
      });
      // Own rank outside the top list: show it below a gap
      const mine = account.code && me && me.bests && me.bests[levelId];
      if (mine && mine.rank > data.entries.length) {
        rows.push(lbRow("…", "", "", "gap"), pickableRow(lbRow(mine.rank, account.name, fmt(mine.time_ms), "me"), "@me"));
      }
      if (!data.entries.length) rows.push(lbRow("-", "No times yet – be the first!", "-:--.---", "placeholder"));
      body.replaceChildren(...rows);
      renderGhosts();
      const players = data.total === 1 ? "1 player" : data.total + " players";
      setStatus(status, !data.total ? "" : data.total > LB_LIMIT ? `Top ${LB_LIMIT} of ${players}` : players, "muted");
      renderStats(data.entries);
    } catch (err) {
      if (req !== lbRequest) return;
      body.replaceChildren(lbRow("-", "Leaderboard unreachable", "-:--.---", "placeholder"));
      setStatus(status, err.message, "err");
    }
  }

  // ── Ghost choice: click a row = race that ghost; "Pick ghosts to watch" =
  // clicks toggle up to MAX_WATCH ghosts for "Watch" ─────────────────────────
  const pickName = (p) => (p === "@me" ? "You" : p);

  function pickableRow(tr, pick) {
    tr.classList.add("pickable");
    tr.dataset.pick = pick;
    tr.addEventListener("click", () => {
      if (!pickMode) {
        race = pick;
      } else if (watchPicks.includes(pick)) {
        watchPicks = watchPicks.filter((p) => p !== pick);
      } else if (watchPicks.length < MAX_WATCH) {
        watchPicks.push(pick);
      } else {
        setPlayHint(`You can watch up to ${MAX_WATCH} ghosts.`, "err");
      }
      renderGhosts();
    });
    return tr;
  }

  function setPickMode(on) {
    pickMode = on;
    setPlayHint("");
    renderGhosts();
  }

  function renderGhosts() {
    const mine = account.code && me && me.bests && me.bests[currentLevel];
    $("race-name").textContent = race === "@me" ? (mine ? "You · " + fmt(mine.time_ms) : "You") : race || "No ghost";
    $("race-reset").textContent = race === "@me" ? "No ghost" : "Race yourself";
    $("ghost-tip").textContent = pickMode
      ? `Click up to ${MAX_WATCH} players in the leaderboard to watch them.`
      : "Click a player in the leaderboard to race their ghost.";
    $("pick-watch").textContent = pickMode ? `Done (${watchPicks.length}/${MAX_WATCH})`
      : watchPicks.length ? "Change watch list" : "Pick ghosts to watch";
    $("pick-watch").classList.toggle("active", pickMode);
    $("watch").textContent = watchPicks.length ? `WATCH (${watchPicks.length})` : "WATCH";
    // Chips of the watch list (× removes)
    $("watch-picks").replaceChildren(...watchPicks.map((p, i) => {
      const chip = el("button", "chip c" + i, pickName(p) + " ×");
      chip.type = "button";
      chip.title = "Remove from the watch list";
      chip.addEventListener("click", () => { watchPicks.splice(i, 1); renderGhosts(); });
      return chip;
    }));
    const table = $("lb-body").closest("table");
    table.classList.toggle("picking", pickMode);
    $("lb-body").querySelectorAll("tr[data-pick]").forEach((tr) => {
      tr.classList.toggle("race", tr.dataset.pick === race);
      const w = watchPicks.indexOf(tr.dataset.pick);
      tr.classList.toggle("watching", w >= 0);
      tr.dataset.watch = w >= 0 ? String(w) : "";
      tr.title = pickMode ? "Add to / remove from the watch list" : "Race this ghost";
    });
  }
  $("race-reset").addEventListener("click", () => { race = race === "@me" ? "" : "@me"; renderGhosts(); });
  $("pick-watch").addEventListener("click", () => setPickMode(!pickMode));

  async function refreshLevel() {
    const btn = $("lb-refresh");
    btn.disabled = true;
    await refreshMe();
    await renderLeaderboard();
    btn.disabled = false;
  }
  $("lb-refresh").addEventListener("click", refreshLevel);

  // ── Settings: volumes + two keys per action (localStorage "pk_settings") ────
  // Keys are Godot physical keycodes; the game applies them on start and on
  // pkGodot.settingsChanged(). Defaults = scripts/ui/keybinds.gd.
  const ACTIONS = [
    ["move_left", "Left"], ["move_right", "Right"], ["jump", "Jump"], ["dash", "Dash"],
    ["checkpoint", "Checkpoint"], ["reset", "Restart"], ["esc", "Pause"],
  ];
  const K = { LEFT: 4194319, UP: 4194320, RIGHT: 4194321, DOWN: 4194322, ESC: 4194305, BACKSPACE: 4194308, ENTER: 4194309 };
  const DEFAULT_KEYS = {
    move_left: [65, K.LEFT], move_right: [68, K.RIGHT], jump: [87, K.UP], dash: [83, K.DOWN],
    checkpoint: [K.BACKSPACE, 0], reset: [K.ENTER, 0], esc: [K.ESC, 80],
  };
  const KEY_CODES = {};    // KeyboardEvent.code -> Godot keycode
  const KEY_INFO = {};     // Godot keycode -> {code, label}
  const addKey = (code, godot, label) => {
    KEY_CODES[code] = godot;
    if (!KEY_INFO[godot]) KEY_INFO[godot] = { code, label };
  };
  for (let c = 65; c <= 90; c++) addKey("Key" + String.fromCharCode(c), c, String.fromCharCode(c));
  for (let d = 0; d <= 9; d++) addKey("Digit" + d, 48 + d, String(d));
  [
    ["ArrowLeft", K.LEFT, "Left"], ["ArrowUp", K.UP, "Up"], ["ArrowRight", K.RIGHT, "Right"], ["ArrowDown", K.DOWN, "Down"],
    ["Space", 32, "Space"], ["ShiftLeft", 4194325, "Shift"], ["ShiftRight", 4194325, "Shift"],
    ["ControlLeft", 4194326, "Ctrl"], ["ControlRight", 4194326, "Ctrl"], ["AltLeft", 4194328, "Alt"], ["AltRight", 4194328, "Alt"],
    ["Enter", K.ENTER, "Enter"], ["NumpadEnter", 4194310, "Num Enter"], ["Backspace", K.BACKSPACE, "Backspace"],
    ["Tab", 4194306, "Tab"], ["Escape", K.ESC, "Esc"], ["CapsLock", 4194329, "Caps"], ["Delete", 4194312, "Del"],
    ["Insert", 4194311, "Ins"], ["Home", 4194317, "Home"], ["End", 4194318, "End"], ["PageUp", 4194323, "PgUp"],
    ["PageDown", 4194324, "PgDn"], ["Comma", 44, ","], ["Period", 46, "."], ["Slash", 47, "/"], ["Semicolon", 59, ";"],
    ["Quote", 39, "'"], ["BracketLeft", 91, "["], ["BracketRight", 93, "]"], ["Backslash", 92, "\\"],
    ["Minus", 45, "-"], ["Equal", 61, "="], ["Backquote", 96, "`"],
  ].forEach((k) => addKey(...k));
  // Key caps of the player's layout (e.g. QWERTZ), where the browser knows them
  let layout = null;
  if (navigator.keyboard && navigator.keyboard.getLayoutMap) {
    navigator.keyboard.getLayoutMap().then((m) => { layout = m; renderKeysList(); renderBinds(); }).catch(() => {});
  }
  const keyLabel = (k) => {
    if (!k) return "--";
    const info = KEY_INFO[k];
    if (!info) return "Key " + k;
    const local = layout && info.label.length === 1 && layout.get(info.code);
    return local ? local.toUpperCase() : info.label;
  };

  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(store.get("pk_settings") || "{}") || {}; } catch {}
    const keys = {};
    ACTIONS.forEach(([id]) => {
      const v = saved.keys && saved.keys[id];
      keys[id] = Array.isArray(v) && v.length === 2 ? v.map((n) => Number(n) || 0) : DEFAULT_KEYS[id].slice();
    });
    const vol = (v, d) => (typeof v === "number" && v >= 0 && v <= 1 ? v : d);
    return { music: vol(saved.music, 0.7), sfx: vol(saved.sfx, 0.8), keys };
  }
  let settings = loadSettings();
  function saveSettings() {
    store.set("pk_settings", JSON.stringify(settings));
    if (window.pkGodot && window.pkGodot.settingsChanged) window.pkGodot.settingsChanged();
    renderKeysList();
  }

  // Controls on the home screen
  function renderKeysList() {
    const keys = (...ids) => ids.flatMap((id) => settings.keys[id].filter(Boolean)).map((k) => el("kbd", "", keyLabel(k)));
    const items = [[["move_left", "move_right"], "run"], [["jump"], "jump"], [["dash"], "dash"],
      [["checkpoint"], "checkpoint"], [["reset"], "restart"], [["esc"], "pause"]];
    $("keys-list").replaceChildren(...items.map(([ids, text]) => {
      const li = el("li");
      li.append(...keys(...ids), " " + text);
      return li;
    }));
  }

  const settingsDialog = $("settings-dialog");
  let waiting = null;   // slot waiting for a key: {id, slot}

  function renderBinds() {
    const grid = $("bind-grid");
    grid.replaceChildren();
    ACTIONS.forEach(([id, label]) => {
      grid.append(el("span", "", label));
      [0, 1].forEach((slot) => {
        const isWaiting = waiting && waiting.id === id && waiting.slot === slot;
        const b = el("button", "btn btn-small bind" + (isWaiting ? " waiting" : ""),
          isWaiting ? "Press a key …" : keyLabel(settings.keys[id][slot]));
        b.type = "button";
        b.addEventListener("click", () => { waiting = { id, slot }; renderBinds(); });
        b.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          waiting = null;
          settings.keys[id][slot] = 0;
          saveSettings();
          renderBinds();
        });
        grid.append(b);
      });
    });
    $("bind-hint").textContent = waiting
      ? "Press the new key – Esc cancels."
      : "Click a slot, then press the new key. Right-click clears a slot.";
  }

  settingsDialog.addEventListener("keydown", (e) => {
    if (!waiting) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code !== "Escape") {
      const key = KEY_CODES[e.code];
      if (!key) {
        $("bind-hint").textContent = "This key can't be used – try another one.";
        return;
      }
      // A key belongs to one slot only
      ACTIONS.forEach(([id]) => { settings.keys[id] = settings.keys[id].map((k) => (k === key ? 0 : k)); });
      settings.keys[waiting.id][waiting.slot] = key;
      saveSettings();
    }
    waiting = null;
    renderBinds();
  }, true);
  settingsDialog.addEventListener("cancel", (e) => { if (waiting) e.preventDefault(); });
  settingsDialog.addEventListener("close", () => { waiting = null; });

  [["music", "set-music"], ["sfx", "set-sfx"]].forEach(([key, id]) => {
    $(id).addEventListener("input", (e) => {
      settings[key] = Number(e.target.value) / 100;
      $(id + "-v").textContent = e.target.value + "%";
      saveSettings();
    });
  });
  $("bind-reset").addEventListener("click", () => {
    waiting = null;
    ACTIONS.forEach(([id]) => { settings.keys[id] = DEFAULT_KEYS[id].slice(); });
    saveSettings();
    renderBinds();
  });
  $("settings-done").addEventListener("click", () => settingsDialog.close());
  $$("[data-open-settings]").forEach((b) => b.addEventListener("click", () => {
    settings = loadSettings();   // the game may have changed them
    for (const [key, id] of [["music", "set-music"], ["sfx", "set-sfx"]]) {
      const pct = Math.round(settings[key] * 100);
      $(id).value = pct;
      $(id + "-v").textContent = pct + "%";
    }
    waiting = null;
    renderBinds();
    settingsDialog.showModal();
  }));

  // ── Routing ──────────────────────────────────────────────────────────────────
  let currentScreen = "home";

  function show(screen) {
    currentScreen = screen;
    ["home", "levels", "level"].forEach((s) => { $("screen-" + s).hidden = s !== screen; });
    site.dataset.screen = screen;
    window.scrollTo(0, 0);
  }

  // Draws the visible screen from cached data (no requests)
  function renderScreen() {
    if (currentScreen === "levels") renderLevelCards();
    if (currentScreen === "level") renderLeaderboard();
  }

  function route() {
    const m = location.hash.match(/^#\/level\/([A-Za-z0-9_]+)$/);
    if (m && levelInfo(m[1])) {
      if (currentLevel !== m[1] || !lbEntries.length) {
        // New level: own ghost by default, empty list until the leaderboard is loaded
        race = "@me";
        watchPicks = [];
        pickMode = false;
        lbEntries = [];
      }
      currentLevel = m[1];
      renderGhosts();
      const info = levelInfo(currentLevel);
      $("lvl-title").textContent = info.title;
      $("lvl-subtitle").textContent = info.subtitle;
      document.title = info.title + " – Purple Knight";
      show("level");
      if (ready) playBtn.focus({ preventScroll: true });
      refreshLevel();
    } else if (location.hash === "#/levels") {
      document.title = "Levels – Purple Knight";
      show("levels");
      renderLevelCards();
      refreshMe().then(() => currentScreen === "levels" && renderLevelCards());
      loadRecords();
    } else {
      document.title = "Purple Knight – Speedrun";
      show("home");
      refreshMe();
    }
  }
  window.addEventListener("hashchange", route);

  // ── Start ────────────────────────────────────────────────────────────────────
  const oldName = store.get("pk_name");
  if (!account.code && oldName) $("create-name").value = oldName;   // suggest the old local name
  renderAccount();
  renderKeysList();
  route();
  preload();
  // First visit without an account: ask to create one (or play as guest)
  if (!account.code && !store.get("pk_guest")) openAccountDialog(false);
})();
