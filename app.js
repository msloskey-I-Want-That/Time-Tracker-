import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, setDoc, updateDoc, onSnapshot, collection, addDoc,
  deleteDoc, query, orderBy, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const COMPANIES = [
  { id: "mfi", name: "Miller Family Industries", short: "MFI", color: "var(--mfi)" },
  { id: "genesis", name: "Genesis Diagnostics", short: "Genesis", color: "var(--genesis)" },
  { id: "milar", name: "Milar Properties", short: "Milar", color: "var(--milar)" },
];

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, "0");
const fmtHMS = (s) => {
  s = Math.max(0, Math.floor(s));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const hoursFromSec = (s) => s / 3600;
const fmtH = (h) => (Math.round(h * 100) / 100).toString();
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const getMonday = (d) => {
  const date = new Date(d);
  const day = date.getDay();
  date.setDate(date.getDate() + ((day === 0 ? -6 : 1) - day));
  date.setHours(0, 0, 0, 0);
  return date;
};
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const shortDate = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
const weekDayLabel = (d) => d.toLocaleDateString(undefined, { weekday: "short" });
const el = (sel) => document.querySelector(sel);

// ---------- state ----------
const BASE = ["ledger", "mike"]; // fixed personal path — no auth, single user
let entries = [];
let tasks = [];
let timerState = { running: false, startTs: null };
let pendingStop = null; // { startTs, endTs, durationSec, dateLabel, manualDate }
let taskWeekOffset = 0;
let payPeriodOffset = 0;
let payPeriodAnchor = getMonday(new Date()); // overwritten once meta loads
let tickInterval = null;
let unsubEntries = null, unsubTasks = null, unsubMeta = null;

// ---------- data ----------
attachListeners();

function attachListeners() {
  const entriesQ = query(collection(db, ...BASE, "entries"), orderBy("startTs", "desc"), limit(60));
  unsubEntries = onSnapshot(entriesQ, (snap) => {
    entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderPeriod(); renderEntries(); renderTodayTotal();
  });

  unsubTasks = onSnapshot(collection(db, ...BASE, "tasks"), (snap) => {
    tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTasks();
  });

  unsubMeta = onSnapshot(doc(db, ...BASE, "meta", "state"), (snap) => {
    const data = snap.data() || {};
    timerState = data.timer || { running: false, startTs: null };
    pendingStop = data.pendingStop || null;
    payPeriodAnchor = data.payPeriodAnchor ? new Date(data.payPeriodAnchor + "T00:00:00") : getMonday(new Date());
    renderClockState();
    renderAlloc();
    renderPeriod();
  });
}

async function saveMeta(patch) {
  await setDoc(doc(db, ...BASE, "meta", "state"), patch, { merge: true });
}

// ---------- company chips ----------
el("#company-chips").innerHTML = COMPANIES.map(
  (c) => `<span class="chip" style="color:${c.color}">${c.short}</span>`
).join("");

// ---------- clock ----------
function renderClockState() {
  clearInterval(tickInterval);
  const btn = el("#clock-btn");
  if (timerState.running && timerState.startTs) {
    el("#clock-state").textContent = "Clocked in";
    btn.classList.add("running");
    el("#clock-btn-icon").textContent = "■";
    el("#clock-btn-label").textContent = "Stop";
    tickInterval = setInterval(tickClock, 1000);
    tickClock();
  } else {
    el("#clock-state").textContent = "Clocked out";
    btn.classList.remove("running");
    el("#clock-btn-icon").textContent = "▶";
    el("#clock-btn-label").textContent = "Start";
    el("#clock-digits").textContent = "00:00:00";
  }
  btn.disabled = !!pendingStop;
  el("#manual-toggle").classList.toggle("hidden", !!pendingStop);
}

function tickClock() {
  const elapsed = (Date.now() - timerState.startTs) / 1000;
  el("#clock-digits").textContent = fmtHMS(elapsed);
}

function renderTodayTotal() {
  const todayKey = dateKey(new Date());
  const todays = entries.filter((e) => e.date === todayKey);
  const totalSec = todays.reduce((s, e) => s + (e.durationSec || 0), 0);
  const n = todays.length;
  el("#today-total").textContent = `Today: ${fmtH(hoursFromSec(totalSec))}h across ${n} session${n === 1 ? "" : "s"}`;
}

el("#clock-btn").addEventListener("click", async () => {
  if (pendingStop) return;
  if (timerState.running) {
    const endTs = Date.now();
    const durationSec = Math.max(1, Math.floor((endTs - timerState.startTs) / 1000));
    await saveMeta({
      timer: { running: false, startTs: null },
      pendingStop: { startTs: timerState.startTs, endTs, durationSec, dateLabel: shortDate(new Date(timerState.startTs)) },
    });
  } else {
    await saveMeta({ timer: { running: true, startTs: Date.now() } });
  }
});

// ---------- manual entry ----------
el("#manual-toggle").addEventListener("click", () => {
  el("#manual-date").value = dateKey(new Date());
  el("#manual-form").classList.toggle("hidden");
});
el("#manual-cancel").addEventListener("click", () => el("#manual-form").classList.add("hidden"));
el("#manual-continue").addEventListener("click", async () => {
  const dateStr = el("#manual-date").value || dateKey(new Date());
  const hours = parseFloat(el("#manual-hours").value) || 0;
  if (hours <= 0) return;
  await saveMeta({ pendingStop: { startTs: null, endTs: null, durationSec: hours * 3600, dateLabel: dateStr, manualDate: dateStr } });
  el("#manual-form").classList.add("hidden");
});

// ---------- allocation ----------
let allocSplits = {};
function renderAlloc() {
  const panel = el("#alloc-panel");
  if (!pendingStop) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  el("#manual-form").classList.add("hidden");
  el("#alloc-title").textContent = `Allocate session${pendingStop.dateLabel ? " · " + pendingStop.dateLabel : ""}`;

  const totalHours = hoursFromSec(pendingStop.durationSec);
  el("#alloc-total").textContent = `${fmtH(totalHours)}h`;

  if (!allocSplits._for || allocSplits._for !== pendingStop.startTs + "-" + pendingStop.durationSec) {
    allocSplits = { _for: pendingStop.startTs + "-" + pendingStop.durationSec };
    COMPANIES.forEach((c) => (allocSplits[c.id] = 0));
  }

  const rows = el("#alloc-rows");
  rows.innerHTML = "";
  COMPANIES.forEach((c) => {
    const row = document.createElement("div");
    row.className = "alloc-row";
    row.innerHTML = `
      <span class="dot" style="background:${c.color}"></span>
      <span class="name">${c.name}</span>
      <input type="number" step="0.25" min="0" value="${allocSplits[c.id]}" data-co="${c.id}" />
      <span class="unit">h</span>
      <button class="assign-btn" style="background:${c.color}" data-assign="${c.id}">all</button>
    `;
    rows.appendChild(row);
  });
  rows.querySelectorAll("input[data-co]").forEach((inp) => {
    inp.addEventListener("input", () => { allocSplits[inp.dataset.co] = parseFloat(inp.value) || 0; renderAllocBarAndStatus(totalHours); });
  });
  rows.querySelectorAll("[data-assign]").forEach((btn) => {
    btn.addEventListener("click", () => {
      COMPANIES.forEach((c) => (allocSplits[c.id] = c.id === btn.dataset.assign ? Math.round(totalHours * 100) / 100 : 0));
      renderAlloc();
    });
  });

  renderAllocBarAndStatus(totalHours);
}

function renderAllocBarAndStatus(totalHours) {
  const bar = el("#alloc-bar");
  bar.innerHTML = COMPANIES.map((c) => {
    const h = parseFloat(allocSplits[c.id]) || 0;
    const pct = totalHours > 0 ? Math.max(0, Math.min(100, (h / totalHours) * 100)) : 0;
    return `<span style="width:${pct}%;background:${c.color}"></span>`;
  }).join("");

  const assigned = COMPANIES.reduce((s, c) => s + (parseFloat(allocSplits[c.id]) || 0), 0);
  const remaining = Math.round((totalHours - assigned) * 100) / 100;
  const status = el("#alloc-status");
  const balanced = Math.abs(remaining) < 0.02;
  status.textContent = balanced ? "balanced" : remaining > 0 ? `${fmtH(remaining)}h unassigned` : `${fmtH(-remaining)}h over`;
  status.className = balanced ? "status-ok" : "status-bad";
  el("#alloc-save").disabled = !balanced || totalHours === 0;
}

el("#alloc-split-even").addEventListener("click", () => {
  const totalHours = hoursFromSec(pendingStop.durationSec);
  const each = Math.round((totalHours / COMPANIES.length) * 100) / 100;
  COMPANIES.forEach((c, i) => {
    allocSplits[c.id] = i === COMPANIES.length - 1
      ? Math.round((totalHours - each * (COMPANIES.length - 1)) * 100) / 100 : each;
  });
  renderAlloc();
});

async function discardPending() {
  await saveMeta({ pendingStop: null });
  el("#alloc-note").value = "";
}
el("#alloc-cancel").addEventListener("click", discardPending);
el("#alloc-discard").addEventListener("click", discardPending);

el("#alloc-save").addEventListener("click", async () => {
  const note = el("#alloc-note").value.trim();
  const entryDate = pendingStop.manualDate || dateKey(new Date(pendingStop.startTs));
  await addDoc(collection(db, ...BASE, "entries"), {
    date: entryDate,
    startTs: pendingStop.startTs || null,
    endTs: pendingStop.endTs || null,
    durationSec: pendingStop.durationSec,
    splits: { ...allocSplits, _for: undefined },
    note,
    createdAt: serverTimestamp(),
  });
  el("#alloc-note").value = "";
  await saveMeta({ pendingStop: null });
});

// ---------- pay period summary (2 weeks) ----------
el("#period-prev").addEventListener("click", () => { payPeriodOffset--; renderPeriod(); });
el("#period-next").addEventListener("click", () => { payPeriodOffset++; renderPeriod(); });

el("#period-anchor-toggle").addEventListener("click", () => {
  const row = el("#period-anchor-row");
  row.classList.toggle("hidden");
  if (!row.classList.contains("hidden")) el("#period-anchor-input").value = dateKey(payPeriodAnchor);
});
el("#period-anchor-save").addEventListener("click", async () => {
  const val = el("#period-anchor-input").value;
  if (!val) return;
  await saveMeta({ payPeriodAnchor: val });
  payPeriodOffset = 0;
  el("#period-anchor-row").classList.add("hidden");
});

function zeroTime(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

function currentPeriodStart() {
  const msPerDay = 86400000;
  const diffDays = Math.floor((zeroTime(new Date()) - zeroTime(payPeriodAnchor)) / msPerDay);
  const periodsSinceAnchor = Math.floor(diffDays / 14);
  const base = addDays(payPeriodAnchor, periodsSinceAnchor * 14);
  return addDays(base, payPeriodOffset * 14);
}

function dayTotals(d) {
  const key = dateKey(d);
  const totals = {}; COMPANIES.forEach((c) => (totals[c.id] = 0));
  entries.filter((e) => e.date === key).forEach((e) => {
    COMPANIES.forEach((c) => (totals[c.id] += parseFloat(e.splits?.[c.id]) || 0));
  });
  return { date: d, key, totals };
}

function renderDayBars(containerSel, days, maxDay) {
  el(containerSel).innerHTML = days.map((d) => {
    const dayTotal = COMPANIES.reduce((s, c) => s + d.totals[c.id], 0);
    const heightPct = maxDay > 0 ? (dayTotal / maxDay) * 100 : 0;
    const segs = COMPANIES.map((c) => {
      const h = d.totals[c.id]; if (!h) return "";
      const segPct = dayTotal > 0 ? (h / dayTotal) * 100 : 0;
      return `<div style="height:${segPct}%;background:${c.color}"></div>`;
    }).join("");
    return `<div class="day-col">
      <div class="day-col-fill" style="height:${Math.max(heightPct, dayTotal > 0 ? 4 : 0)}%">${segs}</div>
      <div class="day-col-label">${weekDayLabel(d.date)}</div>
    </div>`;
  }).join("");
}

function renderPeriod() {
  const periodStart = currentPeriodStart();
  const days14 = Array.from({ length: 14 }, (_, i) => dayTotals(addDays(periodStart, i)));
  const week1 = days14.slice(0, 7), week2 = days14.slice(7, 14);

  el("#period-label").textContent = `Pay period: ${shortDate(days14[0].date)} – ${shortDate(days14[13].date)}`;
  el("#period-week1-label").textContent = `Week 1 · ${shortDate(week1[0].date)} – ${shortDate(week1[6].date)}`;
  el("#period-week2-label").textContent = `Week 2 · ${shortDate(week2[0].date)} – ${shortDate(week2[6].date)}`;

  const maxDay = Math.max(0.25, ...days14.map((d) => COMPANIES.reduce((s, c) => s + d.totals[c.id], 0)));
  renderDayBars("#day-bars-week1", week1, maxDay);
  renderDayBars("#day-bars-week2", week2, maxDay);

  const grand = {}; COMPANIES.forEach((c) => (grand[c.id] = days14.reduce((s, d) => s + d.totals[c.id], 0)));
  const grandTotal = COMPANIES.reduce((s, c) => s + grand[c.id], 0);
  el("#period-totals").innerHTML = COMPANIES.map((c) =>
    `<div class="wt-item"><span class="dot" style="background:${c.color}"></span>${c.short}
     <span class="wt-hours">${fmtH(grand[c.id])}h</span></div>`
  ).join("") + `<div class="wt-grand">Total ${fmtH(grandTotal)}h</div>`;
}

// ---------- weekly tasks nav ----------
el("#task-week-prev").addEventListener("click", () => { taskWeekOffset--; renderTasks(); });
el("#task-week-next").addEventListener("click", () => { taskWeekOffset++; renderTasks(); });

function currentMonday() { return getMonday(addDays(new Date(), taskWeekOffset * 7)); }

// ---------- tasks ----------
el("#new-task-company").innerHTML = `<option value="">—</option>` +
  COMPANIES.map((c) => `<option value="${c.id}">${c.short}</option>`).join("");

el("#add-task-btn").addEventListener("click", addTask);
el("#new-task-text").addEventListener("keydown", (e) => { if (e.key === "Enter") addTask(); });

async function addTask() {
  const text = el("#new-task-text").value.trim();
  if (!text) return;
  const company = el("#new-task-company").value || null;
  await addDoc(collection(db, ...BASE, "tasks"), {
    text, done: false, company, weekStart: dateKey(currentMonday()), createdAt: serverTimestamp(),
  });
  el("#new-task-text").value = ""; el("#new-task-company").value = "";
}

function renderTasks() {
  const monday = currentMonday();
  el("#task-week-label").textContent = `Tasks for week of ${shortDate(monday)} – ${shortDate(addDays(monday, 6))}`;
  const weekStartKey = dateKey(monday);
  const weekTasks = tasks.filter((t) => t.weekStart === weekStartKey);
  const listEl = el("#task-list");
  if (weekTasks.length === 0) {
    listEl.innerHTML = `<div class="task-empty">Nothing on the list yet.</div>`;
    return;
  }
  listEl.innerHTML = weekTasks.map((t) => {
    const co = COMPANIES.find((c) => c.id === t.company);
    return `<div class="task-row">
      <button class="task-check ${t.done ? "done" : ""}" data-toggle="${t.id}"></button>
      <span class="task-text ${t.done ? "done" : ""}">${escapeHtml(t.text)}</span>
      ${co ? `<span class="task-co-chip" style="background:${co.color}">${co.short}</span>` : ""}
      <button class="icon-btn" data-del="${t.id}" style="font-size:14px">✕</button>
    </div>`;
  }).join("");
  listEl.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => toggleTask(b.dataset.toggle)));
  listEl.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteTask(b.dataset.del)));
}

async function toggleTask(id) {
  const t = tasks.find((x) => x.id === id);
  await updateDoc(doc(db, ...BASE, "tasks", id), { done: !t.done });
}
async function deleteTask(id) { await deleteDoc(doc(db, ...BASE, "tasks", id)); }

// ---------- entries ----------
function renderEntries() {
  const listEl = el("#entries-list");
  if (entries.length === 0) {
    listEl.innerHTML = `<div class="entries-empty">No sessions logged yet. Hit Start to punch in.</div>`;
    return;
  }
  listEl.innerHTML = entries.map((e) => {
    const total = hoursFromSec(e.durationSec);
    const bar = COMPANIES.map((c) => {
      const h = parseFloat(e.splits?.[c.id]) || 0;
      const pct = total > 0 ? (h / total) * 100 : 0;
      return pct > 0 ? `<span style="width:${pct}%;background:${c.color}"></span>` : "";
    }).join("");
    const detail = COMPANIES.map((c) => {
      const h = parseFloat(e.splits?.[c.id]) || 0;
      return h > 0 ? `<span style="color:${c.color}">${c.short}</span> ${fmtH(h)}h` : "";
    }).filter(Boolean).join(" &nbsp; ");
    return `<div class="entry-row">
      <div class="entry-date">${e.date}</div>
      <div class="entry-mid">
        <div class="entry-bar">${bar}</div>
        <div class="entry-detail">${detail}${e.note ? ` &nbsp; <em>"${escapeHtml(e.note)}"</em>` : ""}</div>
      </div>
      <div class="entry-hours">${fmtH(total)}h</div>
      <button class="icon-btn" data-entrydel="${e.id}">✕</button>
    </div>`;
  }).join("");
  listEl.querySelectorAll("[data-entrydel]").forEach((b) => b.addEventListener("click", () => deleteEntry(b.dataset.entrydel)));
}

async function deleteEntry(id) { await deleteDoc(doc(db, ...BASE, "entries", id)); }

function escapeHtml(s) {
  const d = document.createElement("div"); d.textContent = s; return d.innerHTML;
}

// register service worker for installability
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
