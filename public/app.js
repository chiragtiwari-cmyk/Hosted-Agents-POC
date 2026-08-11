/**
 * Kore.ai multi-agent orchestration lab — workshop UI.
 *
 * Talks to the agent over the WebSocket transport (/invocations_ws) so text
 * deltas and delegation steps arrive live. Falls back to POST /responses if the
 * socket cannot be established, so the UI still works behind a proxy that blocks
 * WebSocket upgrades.
 *
 * Session model, mirroring Foundry:
 *   agent_session_id  the sandbox and its persisted filesystem. Holds this
 *                     customer's ledger. Survives idle deprovisioning.
 *   conversation      message history. Created up front so turns thread, and it
 *                     binds a stable session for us.
 *
 * The "deprovision (idle)" button simulates Foundry's 15-minute idle timeout so
 * stateful resume is demonstrable without waiting.
 *
 * Voice is browser-side: SpeechRecognition for input, speechSynthesis for
 * output. No server-side speech service, no extra credential. Degrades to
 * text-only where unsupported (notably Firefox, which lacks SpeechRecognition).
 */

import { setMarkdown } from "/markdown.js";

const els = {
  messages: document.getElementById("messages"),
  trace: document.getElementById("trace"),
  accounts: document.getElementById("accounts"),
  form: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("sendBtn"),
  mic: document.getElementById("micBtn"),
  speakBack: document.getElementById("speakBack"),
  reset: document.getElementById("resetBtn"),
  debit: document.getElementById("debitBtn"),
  quick: document.getElementById("quick"),
  wsDot: document.getElementById("wsDot"),
  wsLabel: document.getElementById("wsLabel"),
  // session bar
  sessId: document.getElementById("sessId"),
  convId: document.getElementById("convId"),
  sessStatus: document.getElementById("sessStatus"),
  sessResumes: document.getElementById("sessResumes"),
  deprovision: document.getElementById("deprovisionBtn"),
  newSession: document.getElementById("newSessionBtn"),
  filesBtn: document.getElementById("filesBtn"),
  filesPanel: document.getElementById("filesPanel"),
  filesClose: document.getElementById("filesClose"),
  filesList: document.getElementById("filesList"),
  uploadForm: document.getElementById("uploadForm"),
  fileInput: document.getElementById("fileInput"),
  // session manager
  isoKey: document.getElementById("isoKey"),
  sessionsBtn: document.getElementById("sessionsBtn"),
  sessionsPanel: document.getElementById("sessionsPanel"),
  sessionsClose: document.getElementById("sessionsClose"),
  sessionsRefresh: document.getElementById("sessionsRefresh"),
  sessionsRows: document.getElementById("sessionsRows"),
  showAll: document.getElementById("showAll"),
  convRows: document.getElementById("convRows"),
  historyView: document.getElementById("historyView"),
  historyId: document.getElementById("historyId"),
  historyList: document.getElementById("historyList"),
  historyClose: document.getElementById("historyClose"),
};

/**
 * Every request carries the isolation key, because Foundry scopes sessions by it.
 * Switching the "acting as" selector makes one caller's sessions invisible to
 * another — which is the whole isolation lesson.
 */
function isoHeaders(extra = {}) {
  return { "x-ms-user-isolation-key": els.isoKey.value, ...extra };
}

/** fetch() with the isolation key attached. */
function api(url, options = {}) {
  return fetch(url, { ...options, headers: isoHeaders(options.headers ?? {}) });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatIdle(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Session and conversation are persisted in localStorage so a browser reload
 * resumes the same sandbox — which is the whole point of session state.
 */
const STORAGE_KEY = "koreai-orchestration-session";
let sessionId = null;
let conversationId = null;

/** Turn key → { group, steps: Map } for live trace rendering. */
const traceTurns = new Map();
let turnCount = 0;
let busy = false;
let socket = null;
let socketReady = false;
let activeTurn = null;

/* ------------------------------------------------------------------ chat --- */

/**
 * Appends a message bubble.
 *
 * Assistant replies are Markdown — the models emit **bold** and numbered lists,
 * which previously rendered as literal asterisks. User messages and system notices
 * stay plain text: they need no formatting, and echoing user input through any
 * renderer is a habit worth not forming.
 */
function addMessage(text, kind) {
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  if (kind.startsWith("bot")) setMarkdown(el, text);
  else el.textContent = text;
  els.messages.append(el);
  els.messages.scrollTop = els.messages.scrollHeight;
  return el;
}

/**
 * Enables/disables the composer for the duration of a turn.
 *
 * On release the input is refocused so the next message can be typed straight
 * away. This is the single choke point every completion path goes through —
 * WebSocket completion, WebSocket error, and the HTTP fallback — so the refocus
 * lives here rather than being repeated three times.
 *
 * The focus() must come AFTER re-enabling: a disabled input cannot take focus.
 */
function setBusy(value) {
  busy = value;
  els.send.disabled = value;
  els.input.disabled = value;
  if (!value) refocusComposer();
}

/**
 * Returns focus to the message input once a turn finishes, so the next message
 * can be typed immediately.
 *
 * The rule is deliberately narrow: refocus UNLESS the user is currently inside a
 * control they chose themselves (the isolation-key selector, the speak-aloud
 * checkbox, the file picker). Everything else — including `body`, which is where
 * focus lands when the Send button is disabled mid-turn — is treated as "nowhere
 * in particular" and gets the input back.
 *
 * Checking against a known list of controls rather than tagName: buttons that
 * send (Send, the quick phrases) should hand focus back, and they are gone from
 * activeElement by the time this runs anyway.
 */
function refocusComposer() {
  const holdFocus = [els.isoKey, els.speakBack, els.fileInput, els.showAll];
  if (holdFocus.includes(document.activeElement)) return;
  els.input.focus();
}

/* -------------------------------------------------------------- session --- */

function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved?.sessionId && saved?.conversationId) {
      sessionId = saved.sessionId;
      conversationId = saved.conversationId;
      return true;
    }
  } catch {
    /* corrupt entry — start fresh */
  }
  return false;
}

function saveSession() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId, conversationId }));
}

/**
 * Create a conversation server-side. Foundry binds a stable session to a
 * conversation, so this hands us both ids in one call.
 */
async function startSession() {
  const res = await api("/endpoint/protocols/openai/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await res.json();
  conversationId = body.id;
  sessionId = body.agent_session_id;
  saveSession();
  renderSessionBar();
}

function renderSessionBar(view) {
  els.sessId.textContent = sessionId ?? "—";
  els.convId.textContent = conversationId ?? "—";
  if (view) {
    els.sessStatus.textContent = view.status;
    els.sessStatus.className = `pill ${view.status}`;
    els.sessResumes.textContent = String(view.resume_count ?? 0);
  }
}

/* ----------------------------------------------------------------- trace --- */

function agentOf(name) {
  if (name.startsWith("supervisor")) return "supervisor";
  const match = /^delegate\.(\w+)$/.exec(name);
  if (match) return match[1];
  const prefix = name.split(".")[0];
  return ["balance", "payments", "loans"].includes(prefix) ? prefix : "other";
}

function beginTurnGroup(label) {
  if (els.trace.querySelector(".empty")) els.trace.innerHTML = "";
  const group = document.createElement("div");
  group.className = "turn-group";
  const heading = document.createElement("div");
  heading.className = "turn-label";
  heading.textContent = label;
  const total = document.createElement("span");
  total.className = "turn-total";
  heading.append(total);
  group.append(heading);
  els.trace.append(group);
  els.trace.scrollTop = els.trace.scrollHeight;
  // `origin` and `span` drive the waterfall bars; both are learned as steps
  // arrive, since the turn's true extent isn't known up front.
  return { group, steps: new Map(), total, origin: null, span: 1 };
}

/**
 * Fills a step's expandable panel: notes with their offsets, the gen_ai.*
 * attributes that also go to Application Insights, and any error.
 *
 * Rebuilt wholesale each update rather than diffed — a step updates at most twice
 * (running, then finished), so there is nothing to gain from being clever.
 */
function renderStepDetails(el, step) {
  const details = el.detailsEl;
  if (!details) return;
  details.dataset.depth = el.dataset.depth;
  details.textContent = "";
  // Rebuilding content must not resurrect a collapsed panel: a step updates
  // twice (running, then finished), and the second pass was reopening it.
  details.hidden = el.dataset.expanded !== "true";

  const row = (label, value, cls) => {
    const line = document.createElement("div");
    line.className = `detail-row${cls ? ` ${cls}` : ""}`;
    const k = document.createElement("span");
    k.className = "detail-key";
    k.textContent = label;
    const v = document.createElement("span");
    v.className = "detail-val";
    v.textContent = value;
    line.append(k, v);
    return line;
  };

  for (const note of step.notes ?? []) {
    const offset = note.atMs - step.startedAtMs;
    const cls = /committed/i.test(note.message)
      ? "commit"
      : /staged|awaiting|refused/i.test(note.message)
        ? "stage"
        : "";
    details.append(row(`+${offset} ms`, note.message, cls));
  }

  for (const [key, value] of Object.entries(step.attributes ?? {})) {
    details.append(row(key, String(value)));
  }

  if (step.error) details.append(row("error", step.error, "error"));

  if (!details.childElementCount) {
    details.append(row("", "No attributes recorded.", "muted"));
  }
}

/**
 * Redraws every bar in a turn against its current time window.
 *
 * Durations alone are actively misleading here: parallel specialists show two
 * long numbers that read as sequential and sum to more than the turn took. The
 * bars are offset by start time, so concurrent work visibly overlaps.
 */
function layoutTurn(entry) {
  if (entry.origin === null) return;
  for (const [, el] of entry.steps) {
    const start = Number(el.dataset.start);
    const dur = Number(el.dataset.dur || 0);
    const bar = el.querySelector(".bar");
    if (!bar) continue;
    const left = ((start - entry.origin) / entry.span) * 100;
    const width = Math.max((dur / entry.span) * 100, dur > 0 ? 1.5 : 0.6);
    bar.style.left = `${Math.min(left, 99)}%`;
    bar.style.width = `${Math.min(width, 100 - Math.min(left, 99))}%`;
  }
  entry.total.textContent = `${entry.span} ms total`;
}

/** Steps arrive twice (running, then finished), so update in place. */
function renderStep(turnKey, step) {
  const entry = traceTurns.get(turnKey);
  if (!entry) return;

  const key = `${step.name}#${step.depth}#${step.startedAtMs}`;
  let el = entry.steps.get(key);

  if (!el) {
    el = document.createElement("div");
    el.className = "step";
    el.dataset.depth = String(step.depth);
    el.dataset.agent = agentOf(step.name);
    el.innerHTML =
      '<span class="glyph">▸</span><span class="name"></span>' +
      '<span class="track"><span class="bar"></span></span>' +
      '<span class="dur"></span>';

    // Expandable detail: attributes, notes and errors, revealed on click.
    const details = document.createElement("div");
    details.className = "step-details";
    details.hidden = true;
    el.dataset.expanded = "false";

    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.title = "Click for attributes and notes";
    const toggle = () => {
      const open = el.dataset.expanded === "true";
      el.dataset.expanded = open ? "false" : "true";
      details.hidden = open;
      el.querySelector(".glyph").textContent = open ? "▸" : "▾";
    };
    el.addEventListener("click", toggle);
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });

    entry.steps.set(key, el);
    entry.group.append(el);
    entry.group.append(details);
    el.detailsEl = details;
  }

  el.classList.toggle("running", step.status === "running");
  el.classList.toggle("error", step.status === "error");
  el.querySelector(".name").textContent = step.name;
  el.querySelector(".dur").textContent = step.durationMs != null ? `${step.durationMs} ms` : "";

  // Track this step's window, then rescale the whole turn so bars stay comparable.
  el.dataset.start = String(step.startedAtMs);
  el.dataset.dur = String(step.durationMs ?? 0);
  if (entry.origin === null || step.startedAtMs < entry.origin) entry.origin = step.startedAtMs;
  const end = step.startedAtMs + (step.durationMs ?? 0);
  entry.span = Math.max(entry.span, end - entry.origin, 1);
  layoutTurn(entry);

  // Notes stay visible inline — they carry the payment story — while attributes
  // and errors live in the expandable panel.
  renderStepDetails(el, step);

  els.trace.scrollTop = els.trace.scrollHeight;
}

/* ---------------------------------------------------------------- ledger --- */

const lastBalances = new Map();

async function refreshLedger() {
  if (!sessionId) return;
  try {
    // Note: /api/state acquires the session, which reactivates it. So after a
    // deprovision the status legitimately reads "active" again — the proof that
    // state survived is the resume counter, not the status.
    const res = await api(`/api/state?agent_session_id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return;
    const state = await res.json();

    renderSessionBar(state.session);

    els.accounts.innerHTML = "";
    for (const account of state.accounts) {
      const changed =
        lastBalances.has(account.id) && lastBalances.get(account.id) !== account.balanceMinor;

      const wrap = document.createElement("div");
      wrap.className = "acct";
      wrap.innerHTML = '<span class="nm"></span><span class="bal"></span><span class="avail"></span>';
      wrap.querySelector(".nm").textContent = account.name;

      const bal = wrap.querySelector(".bal");
      bal.textContent = account.balance;
      if (account.balanceMinor < 0) bal.classList.add("negative");
      if (changed) {
        bal.classList.add("flash");
        setTimeout(() => bal.classList.remove("flash"), 1200);
      }

      // Show reserved funds only when they differ — that is a pending payment.
      wrap.querySelector(".avail").textContent =
        account.availableMinor !== account.balanceMinor ? `${account.available} available` : "";

      els.accounts.append(wrap);
      lastBalances.set(account.id, account.balanceMinor);
    }

    // Submitted loan applications sit alongside the balances — they are session
    // state too, and seeing a reference appear is the payoff of the apply flow.
    for (const application of state.applications ?? []) {
      const wrap = document.createElement("div");
      wrap.className = "acct application";
      wrap.innerHTML = '<span class="nm"></span><span class="bal"></span><span class="avail"></span>';
      wrap.querySelector(".nm").textContent = `${application.product} · ${application.status.replace("_", " ")}`;
      wrap.querySelector(".bal").textContent = application.amount;
      wrap.querySelector(".avail").textContent =
        `${application.monthly_payment}/mo · ${application.reference}`;
      els.accounts.append(wrap);
    }
  } catch {
    // A failed refresh must not break the conversation.
  }
}

/* ----------------------------------------------------------------- files --- */

async function refreshFiles() {
  if (!sessionId) return;
  const res = await api(`/endpoint/sessions/${encodeURIComponent(sessionId)}/files?path=.`);
  const body = res.ok ? await res.json() : { entries: [] };
  els.filesList.innerHTML = "";

  if (!body.entries?.length) {
    const li = document.createElement("li");
    li.className = "empty-files";
    li.textContent = "No files yet. Upload one — it persists across idle/resume.";
    els.filesList.append(li);
    return;
  }

  for (const entry of body.entries) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.className = "fname";
    link.textContent = entry.name;
    link.href = `/endpoint/sessions/${encodeURIComponent(sessionId)}/files/content?path=${encodeURIComponent(entry.name)}`;
    link.download = entry.name;

    const size = document.createElement("span");
    size.className = "fsize";
    size.textContent = entry.is_directory ? "dir" : `${entry.size} B`;

    const del = document.createElement("button");
    del.className = "ghost small";
    del.type = "button";
    del.textContent = "delete";
    del.addEventListener("click", async () => {
      await api(
        `/endpoint/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(entry.name)}`,
        { method: "DELETE" },
      );
      refreshFiles();
    });

    li.append(link, size, del);
    els.filesList.append(li);
  }
}

/* ------------------------------------------------------- session manager --- */

/**
 * Renders the sessions table from GET /endpoint/sessions.
 *
 * With "show all" off, the list is scoped to the current isolation key — switch
 * "acting as" and other callers' sessions vanish. With it on, we pass ?all=true,
 * which models the cross-user view Foundry gates behind the Foundry User role.
 */
async function refreshSessions() {
  const query = els.showAll.checked ? "?all=true" : "";
  const res = await api(`/endpoint/sessions${query}`);
  const body = res.ok ? await res.json() : { data: [] };
  els.sessionsRows.innerHTML = "";

  if (!body.data?.length) {
    els.sessionsRows.innerHTML =
      '<tr class="empty-row"><td colspan="7">No sessions for this caller.</td></tr>';
  }

  for (const s of body.data ?? []) {
    const tr = document.createElement("tr");
    if (s.agent_session_id === sessionId) tr.className = "current";

    const cell = (text, cls) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (cls) td.className = cls;
      return td;
    };

    tr.append(cell(s.agent_session_id, "sid"));

    const status = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = `pill ${s.status}`;
    pill.textContent = s.status;
    status.append(pill);
    tr.append(status);

    tr.append(
      cell(s.isolation_key),
      cell(String(s.resume_count)),
      cell(formatIdle(s.idle_in_seconds)),
      cell(formatBytes(s.disk_used_bytes)),
    );

    const actions = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "row-actions";

    if (s.agent_session_id !== sessionId) {
      wrap.append(
        button("switch", async () => {
          // Adopt this sandbox. The conversation stays as-is, which is itself
          // instructive: history and sandbox are independent.
          sessionId = s.agent_session_id;
          saveSession();
          renderSessionBar();
          await refreshLedger();
          await refreshSessions();
          addMessage(`Switched to session ${s.agent_session_id}.`, "err");
        }),
      );
    }

    wrap.append(
      button("stop", async () => {
        const res = await api(
          `/endpoint/sessions/${encodeURIComponent(s.agent_session_id)}:stop`,
          { method: "POST" },
        );
        // A cross-key action legitimately 404s. Say so rather than appearing inert.
        if (!res.ok) {
          addMessage(
            `Can't stop ${s.agent_session_id} — it belongs to isolation key ` +
              `"${s.isolation_key}", and you're acting as "${els.isoKey.value}".`,
            "err",
          );
        }
        await refreshSessions();
      }),
      button(
        "delete",
        async () => {
          const res = await api(`/endpoint/sessions/${encodeURIComponent(s.agent_session_id)}`, {
            method: "DELETE",
          });
          if (!res.ok) {
            addMessage(
              `Can't delete ${s.agent_session_id} — it belongs to isolation key ` +
                `"${s.isolation_key}", and you're acting as "${els.isoKey.value}".`,
              "err",
            );
          } else if (s.agent_session_id === sessionId) {
            // We just deleted our own sandbox — get a fresh one.
            localStorage.removeItem(STORAGE_KEY);
            await startSession();
          }
          await refreshSessions();
          await refreshLedger();
        },
        "danger",
      ),
    );

    actions.append(wrap);
    tr.append(actions);
    els.sessionsRows.append(tr);
  }
}

/** Renders the conversations table, with a history viewer. */
async function refreshConversations() {
  const res = await api("/endpoint/protocols/openai/conversations");
  const body = res.ok ? await res.json() : { data: [] };
  els.convRows.innerHTML = "";

  if (!body.data?.length) {
    els.convRows.innerHTML =
      '<tr class="empty-row"><td colspan="4">No conversations yet.</td></tr>';
  }

  for (const c of body.data ?? []) {
    const tr = document.createElement("tr");
    if (c.id === conversationId) tr.className = "current";

    const cell = (text) => {
      const td = document.createElement("td");
      td.textContent = text;
      return td;
    };

    tr.append(cell(c.id), cell(c.agent_session_id), cell(String(c.message_count)));

    const actions = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "row-actions";
    wrap.append(
      button("history", () => showHistory(c.id)),
      button(
        "delete",
        async () => {
          await api(`/endpoint/protocols/openai/conversations/${encodeURIComponent(c.id)}`, {
            method: "DELETE",
          });
          if (c.id === conversationId) {
            localStorage.removeItem(STORAGE_KEY);
            await startSession();
          }
          els.historyView.hidden = true;
          await refreshConversations();
        },
        "danger",
      ),
    );
    actions.append(wrap);
    tr.append(actions);
    els.convRows.append(tr);
  }
}

/** Shows a conversation's stored messages — proof history is server-side. */
async function showHistory(id) {
  const res = await api(`/endpoint/protocols/openai/conversations/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const body = await res.json();

  els.historyId.textContent = id;
  els.historyList.innerHTML = "";
  for (const message of body.messages ?? []) {
    const li = document.createElement("li");
    const role = document.createElement("span");
    role.className = "role";
    role.textContent = message.role;
    // Content goes in its own element — appending a bare text node put the role
    // and the message flush against each other ("userwhat is my balance?").
    const text = document.createElement("span");
    text.className = "content";
    text.textContent = message.content;
    li.append(role, text);
    els.historyList.append(li);
  }
  if (!body.messages?.length) {
    const li = document.createElement("li");
    li.textContent = "No messages yet.";
    els.historyList.append(li);
  }
  els.historyView.hidden = false;
}

function button(label, onClick, extraClass) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  if (extraClass) btn.className = extraClass;
  btn.addEventListener("click", onClick);
  return btn;
}

async function refreshManager() {
  await Promise.all([refreshSessions(), refreshConversations()]);
}

/* ------------------------------------------------------------- transport --- */

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  try {
    socket = new WebSocket(`${proto}//${location.host}/invocations_ws`);
  } catch {
    markSocket(false, "http fallback");
    return;
  }

  socket.addEventListener("open", () => markSocket(true, "websocket"));
  socket.addEventListener("close", () => {
    markSocket(false, "disconnected");
    setTimeout(connect, 3000);
  });
  socket.addEventListener("error", () => markSocket(false, "http fallback"));
  socket.addEventListener("message", (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    handleFrame(frame);
  });
}

function markSocket(up, label) {
  socketReady = up;
  els.wsDot.className = `dot ${up ? "on" : "off"}`;
  els.wsLabel.textContent = label;
}

function handleFrame(frame) {
  switch (frame.type) {
    case "ready":
      break;

    case "turn.started":
      activeTurn = { key: frame.turnId, bubble: addMessage("", "bot pending"), text: "" };
      traceTurns.set(frame.turnId, beginTurnGroup(`turn ${++turnCount}`));
      break;

    case "delegation.step":
      renderStep(frame.turnId, frame.step);
      break;

    case "response.delta":
      if (activeTurn) {
        activeTurn.text += frame.delta;
        // Plain text while streaming: re-rendering Markdown on every delta would
        // flicker as partial "**" tokens open and close.
        activeTurn.bubble.textContent = activeTurn.text;
        els.messages.scrollTop = els.messages.scrollHeight;
      }
      break;

    case "turn.completed":
      if (activeTurn) {
        activeTurn.bubble.classList.remove("pending");
        // Now the text is whole, so Markdown can be rendered safely.
        setMarkdown(activeTurn.bubble, frame.text);
        speak(frame.text);
        activeTurn = null;
      }
      // The server tells us which sandbox served the turn.
      if (frame.agent_session_id && frame.agent_session_id !== sessionId) {
        sessionId = frame.agent_session_id;
        saveSession();
      }
      setBusy(false);
      refreshLedger();
      break;

    case "error":
      if (activeTurn) {
        activeTurn.bubble.remove();
        activeTurn = null;
      }
      addMessage(frame.message ?? "Something went wrong.", "err");
      setBusy(false);
      break;
  }
}

/** HTTP fallback when the socket is unavailable. */
async function sendOverHttp(message) {
  const turnKey = `http-${++turnCount}`;
  traceTurns.set(turnKey, beginTurnGroup(`turn ${turnCount}`));
  const bubble = addMessage("", "bot pending");

  try {
    const res = await api("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: message,
        conversation: conversationId,
        agent_session_id: sessionId,
      }),
    });
    const body = await res.json();

    if (!res.ok) {
      bubble.remove();
      addMessage(body?.error?.message ?? `HTTP ${res.status}`, "err");
      return;
    }

    const text = body.output_text ?? "";
    bubble.classList.remove("pending");
    setMarkdown(bubble, text);
    speak(text);

    // No live steps over this path — fetch the finished trace instead.
    const trace = await fetch(`/api/trace/${encodeURIComponent(conversationId)}`);
    if (trace.ok) {
      const data = await trace.json();
      const turn = data.turns.at(-1);
      for (const step of turn?.steps ?? []) renderStep(turnKey, step);
    }
  } catch (error) {
    bubble.remove();
    addMessage(String(error), "err");
  } finally {
    setBusy(false);
    refreshLedger();
  }
}

function send(message) {
  const text = message.trim();
  if (!text || busy) return;

  addMessage(text, "user");
  els.input.value = "";
  setBusy(true);

  if (socketReady && socket?.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        type: "turn",
        message: text,
        conversation: conversationId,
        agent_session_id: sessionId,
      }),
    );
  } else {
    sendOverHttp(text);
  }
}

/* ----------------------------------------------------------------- voice --- */

const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
let recognition = null;
let listening = false;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = "en-GB";
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.addEventListener("result", (event) => {
    let transcript = "";
    let isFinal = false;
    for (const result of event.results) {
      transcript += result[0].transcript;
      if (result.isFinal) isFinal = true;
    }
    els.input.value = transcript;
    if (isFinal) {
      stopListening();
      send(transcript);
    }
  });

  recognition.addEventListener("end", stopListening);
  recognition.addEventListener("error", (event) => {
    stopListening();
    if (event.error !== "aborted" && event.error !== "no-speech") {
      addMessage(`Microphone error: ${event.error}`, "err");
    }
  });
} else {
  els.mic.classList.add("unsupported");
  els.mic.title = "Speech recognition isn't available in this browser";
}

function startListening() {
  if (!recognition || listening || busy) return;
  try {
    recognition.start();
    listening = true;
    els.mic.classList.add("listening");
  } catch {
    /* already running */
  }
}

function stopListening() {
  listening = false;
  els.mic.classList.remove("listening");
  try {
    recognition?.stop();
  } catch {
    /* already stopped */
  }
}

function speak(text) {
  if (!els.speakBack.checked || !text || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(speakable(text));
  utterance.lang = "en-GB";
  utterance.rate = 1.02;
  window.speechSynthesis.speak(utterance);
}

/** "£1,240.00" reads far better spelled out. */
function speakable(text) {
  return text
    .replace(/£([\d,]+)\.00\b/g, (_m, pounds) => `${pounds.replace(/,/g, "")} pounds`)
    .replace(
      /£([\d,]+)\.(\d{2})\b/g,
      (_m, pounds, pence) => `${pounds.replace(/,/g, "")} pounds ${pence} pence`,
    )
    .replace(/\bREF(\d+)/g, (_m, digits) => `reference ${digits.split("").join(" ")}`);
}

/* ---------------------------------------------------------------- events --- */

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  send(els.input.value);
});

els.mic.addEventListener("click", () => {
  if (listening) stopListening();
  else startListening();
});

els.quick.addEventListener("click", (event) => {
  const phrase = event.target.dataset?.say;
  if (phrase) send(phrase);
});

els.reset.addEventListener("click", async () => {
  await api("/api/demo/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_session_id: sessionId, conversation: conversationId }),
  });
  localStorage.removeItem(STORAGE_KEY);
  els.messages.innerHTML = "";
  els.trace.innerHTML = '<p class="empty">Send a message to see how the supervisor delegates.</p>';
  traceTurns.clear();
  turnCount = 0;
  lastBalances.clear();
  await startSession();
  addMessage("Session reset — new sandbox, fresh ledger.", "err");
  await refreshLedger();
  if (!els.sessionsPanel.hidden) await refreshManager();
});

els.debit.addEventListener("click", async () => {
  await api("/api/demo/debit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_session_id: sessionId, accountId: "acc-current", amountMinor: 100000 }),
  });
  refreshLedger();
});

/**
 * Simulates the 15-minute idle timeout. Compute is dropped; $HOME is kept. The
 * next turn restores from disk and the resume counter ticks up — which is the
 * visible proof that state survived.
 */
els.deprovision.addEventListener("click", async () => {
  const res = await api("/api/demo/deprovision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_session_id: sessionId }),
  });
  const body = await res.json();
  addMessage(
    body.ok
      ? "Sandbox deprovisioned (idle). $HOME kept — send a message and watch RESUMES tick up."
      : "Session wasn't live, so there was nothing to deprovision.",
    "err",
  );
  // Read status WITHOUT reacquiring, so "idle" is actually visible. Refreshing
  // the ledger here would reactivate the session and mask what just happened.
  await showSessionStatusOnly();
  if (!els.sessionsPanel.hidden) await refreshSessions();
});

/** Read-only status probe — does not acquire (and so does not reactivate). */
async function showSessionStatusOnly() {
  if (!sessionId) return;
  const res = await api(`/endpoint/sessions/${encodeURIComponent(sessionId)}`);
  if (!res.ok) return;
  const view = await res.json();
  els.sessStatus.textContent = view.status;
  els.sessStatus.className = `pill ${view.status}`;
  els.sessResumes.textContent = String(view.resume_count ?? 0);
}

els.newSession.addEventListener("click", async () => {
  localStorage.removeItem(STORAGE_KEY);
  els.messages.innerHTML = "";
  els.trace.innerHTML = '<p class="empty">Send a message to see how the supervisor delegates.</p>';
  traceTurns.clear();
  turnCount = 0;
  lastBalances.clear();
  await startSession();
  addMessage("New session and conversation. The old one is still on disk.", "err");
  await refreshLedger();
  if (!els.sessionsPanel.hidden) await refreshManager();
});

/*
 * The drawers are mutually exclusive. Both open at once squeezes the chat log to
 * a couple of visible messages and leaves each drawer too short to be useful, so
 * opening one closes the other.
 */
els.filesBtn.addEventListener("click", () => {
  const opening = els.filesPanel.hidden;
  els.filesPanel.hidden = !opening;
  if (opening) {
    els.sessionsPanel.hidden = true;
    refreshFiles();
  }
});

els.sessionsBtn.addEventListener("click", () => {
  const opening = els.sessionsPanel.hidden;
  els.sessionsPanel.hidden = !opening;
  if (opening) {
    els.filesPanel.hidden = true;
    refreshManager();
  }
});

els.sessionsClose.addEventListener("click", () => {
  els.sessionsPanel.hidden = true;
});

els.sessionsRefresh.addEventListener("click", refreshManager);

/** Escape dismisses whichever drawer is open — it overlays the chat on short screens. */
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!els.sessionsPanel.hidden || !els.filesPanel.hidden) {
    els.sessionsPanel.hidden = true;
    els.filesPanel.hidden = true;
    els.historyView.hidden = true;
  }
});
els.showAll.addEventListener("change", refreshSessions);
els.historyClose.addEventListener("click", () => {
  els.historyView.hidden = true;
});

/**
 * Switching caller starts a fresh session for that identity. Foundry scopes
 * sessions by isolation key, so acting as a different user must not inherit the
 * previous one's sandbox.
 */
els.isoKey.addEventListener("change", async () => {
  localStorage.removeItem(STORAGE_KEY);
  els.messages.innerHTML = "";
  els.trace.innerHTML = '<p class="empty">Send a message to see how the supervisor delegates.</p>';
  traceTurns.clear();
  turnCount = 0;
  lastBalances.clear();
  els.historyView.hidden = true;
  await startSession();
  await refreshLedger();
  if (!els.sessionsPanel.hidden) await refreshManager();
  addMessage(
    `Now acting as "${els.isoKey.value}" — a new session, and the other caller's ` +
      `sessions are no longer listed.`,
    "err",
  );
});

els.filesClose.addEventListener("click", () => {
  els.filesPanel.hidden = true;
});

els.uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = els.fileInput.files?.[0];
  if (!file || !sessionId) return;

  const res = await api(
    `/endpoint/sessions/${encodeURIComponent(sessionId)}/files/content?path=${encodeURIComponent(file.name)}`,
    { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    addMessage(body?.error?.message ?? `Upload failed (${res.status})`, "err");
  }
  els.fileInput.value = "";
  refreshFiles();
});

/* ------------------------------------------------------------------ init --- */

(async function init() {
  // localStorage alone is not evidence the session still exists: the server may
  // have been restarted, or the session deleted or expired. Claiming "welcome
  // back" without checking asserts continuity that may not be there, so verify
  // against the server and fall back to a fresh session.
  let resumed = false;
  if (loadSession()) {
    resumed = await sessionStillExists(sessionId);
    if (!resumed) {
      localStorage.removeItem(STORAGE_KEY);
      sessionId = null;
      conversationId = null;
    }
  }
  if (!resumed) await startSession();

  renderSessionBar();
  connect();
  await refreshLedger();

  addMessage(
    resumed
      ? "Welcome back — same session, so your balances and any pending payment are as you left them."
      : "Hello — I can help with balances, payments, and loans. Try the buttons below, " +
          "or click the microphone and speak.",
    "bot",
  );
})();

/**
 * Does the server still know this session? A 404 means it was deleted, expired,
 * or the server restarted with a cleared state directory.
 *
 * Deliberately uses the read-only /endpoint/sessions/:id probe, NOT /api/state —
 * the latter acquires the session, which would create the very thing we are
 * checking for and always report success.
 */
async function sessionStillExists(id) {
  if (!id) return false;
  try {
    const res = await api(`/endpoint/sessions/${encodeURIComponent(id)}`);
    return res.ok;
  } catch {
    return false;
  }
}
