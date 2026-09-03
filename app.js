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

// entry hours for a given company: supports new schema (entry.company) and
// legacy entries saved before per-company timers (entry.splits[companyId])
function entryHoursFor(entry, companyId) {
  if (entry.company) return entry.company === companyId ? hoursFromSec(entry.durationSec) : 0;
  if (entry.splits) return parseFloat(entry.splits[companyId]) || 0;
  return 0;
}
function entryTotalHours(entry) {
  return hoursFromSec(entry.durationSec);
}

// ---------- state ----------
const BASE = ["ledger", "mike"]; // fixed personal path, no auth, single user
let entries = [];
let tasks = [];
let timers = {}; // { mfi: {running,startTs}, genesis: {...}, milar: {...} }
let taskWeekOffset = 0;
let payPeriodOffset = 0;
let payPeriodAnchor = getMonday(new Date());
let tickInterval = null;
let unsubEntries = null, unsubTasks = null, unsubMeta = null;

// ---------- data ----------
attachListeners();

function attachListeners() {
  const entriesQ = query(collection(db, ...BASE, "entries"), orderBy("startTs", "desc"), limit(60));
  unsubEntries = onSnapshot(entriesQ, (snap) => {
    entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderPeriod(); renderEntries(); renderClocks();
  });

  unsubTasks = onSnapshot(collection(db, ...BASE, "tasks"), (snap) => {
    tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTasks();
  });

  unsubMeta = onSnapshot(doc(db, ...BASE, "meta", "state"), (snap) => {
    const data = snap.data() || {};
    timers = data.timers || {};
    payPeriodAnchor = data.payPeriodAnchor ? new Date(data.payPeriodAnchor + "T00:00:00") : getMonday(new Date());
    renderClocks();
    renderPeriod();
  });
}

async function saveMeta(patch) {
  await setDoc(doc(db, ...BASE, "meta", "state"), patch, { merge: true });
}

// ---------- punch clocks (one per company, independent) ----------
function renderClocks() {
  const grid = el("#clocks-grid");
  grid.innerHTML = COMPANIES.map((c) => {
    const t = timers[c.id] || { running: false, startTs: null };
    const running = !!(t.running && t.startTs);
    return `
      <div class="clock-mini">
        <div class="clock-mini-head"><span class="dot" style="background:${c.color}"></span>${c.short}</div>
        <div class="clock-mini-body">
          <div class="clock-mini-digits" id="digits-${c.id}">${running ? "" : "00:00:00"}</div>
          <div class="clock-mini-sub" id="today-${c.id}"></div>
        </div>
        <button class="clock-mini-btn ${running ? "running" : ""}" id="btn-${c.id}" data-company="${c.id}">
          ${running ? "\u25a0" : "\u25b6"}
        </button>
      </div>`;
  }).join("");

  COMPANIES.forEach((c) => {
    el(`#btn-${c.id}`).addEventListener("click", () => toggleClock(c.id));
  });

  updateTodayTotals();
  tickAllClocks();
  clearInterval(tickInterval);
  tickInterval = setInterval(tickAllClocks, 1000);
}

function tickAllClocks() {
  COMPANIES.forEach((c) => {
    const t = timers[c.id];
    const digitsEl = el(`#digits-${c.id}`);
    if (!digitsEl) return;
    if (t && t.running && t.startTs) {
      digitsEl.textContent = fmtHMS((Date.now() - t.startTs) / 1000);
    } else {
      digitsEl.textContent = "00:00:00";
    }
  });
}

function updateTodayTotals() {
  const todayKey = dateKey(new Date());
  const todays = entries.filter((e) => e.date === todayKey);
  COMPANIES.forEach((c) => {
    const totalSec = todays.reduce((s, e) => s + (e.company === c.id ? (e.durationSec || 0) : 0), 0);
    const n = todays.filter((e) => e.company === c.id).length;
    const subEl = el(`#today-${c.id}`);
    if (subEl) subEl.textContent = `${fmtH(hoursFromSec(totalSec))}h today \u00b7 ${n} session${n === 1 ? "" : "s"}`;
  });
}

async function toggleClock(companyId) {
  const t = timers[companyId] || { running: false, startTs: null };
  if (t.running) {
    const endTs = Date.now();
    const durationSec = Math.max(1, Math.floor((endTs - t.startTs) / 1000));
    await addDoc(collection(db, ...BASE, "entries"), {
      date: dateKey(new Date(t.startTs)),
      startTs: t.startTs,
      endTs,
      durationSec,
      company: companyId,
      note: "",
      createdAt: serverTimestamp(),
    });
    await saveMeta({ timers: { ...timers, [companyId]: { running: false, startTs: null } } });
  } else {
    await saveMeta({ timers: { ...timers, [companyId]: { running: true, startTs: Date.now() } } });
  }
}

// ---------- manual entry ----------
el("#manual-company").innerHTML = COMPANIES.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");

el("#manual-toggle").addEventListener("click", () => {
  el("#manual-date").value = dateKey(new Date());
  el("#manual-form").classList.toggle("hidden");
});
el("#manual-cancel").addEventListener("click", () => el("#manual-form").classList.add("hidden"));
el("#manual-save").addEventListener("click", async () => {
  const companyId = el("#manual-company").value;
  const dateStr = el("#manual-date").value || dateKey(new Date());
  const hours = parseFloat(el("#manual-hours").value) || 0;
  const note = el("#manual-note").value.trim();
  if (hours <= 0) return;
  await addDoc(collection(db, ...BASE, "entries"), {
    date: dateStr,
    startTs: null,
    endTs: null,
    durationSec: Math.round(hours * 3600),
    company: companyId,
    note,
    createdAt: serverTimestamp(),
  });
  el("#manual-note").value = "";
  el("#manual-form").classList.add("hidden");
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
    COMPANIES.forEach((c) => (totals[c.id] += entryHoursFor(e, c.id)));
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

  el("#period-label").textContent = `Pay period: ${shortDate(days14[0].date)} \u2013 ${shortDate(days14[13].date)}`;
  el("#period-week1-label").textContent = `Week 1 \u00b7 ${shortDate(week1[0].date)} \u2013 ${shortDate(week1[6].date)}`;
  el("#period-week2-label").textContent = `Week 2 \u00b7 ${shortDate(week2[0].date)} \u2013 ${shortDate(week2[6].date)}`;

  const maxDay = Math.max(0.25, ...days14.map((d) => COMPANIES.reduce((s, c) => s + d.totals[c.id], 0)));
  renderDayBars("#day-bars-week1", week1, maxDay);
  renderDayBars("#day-bars-week2", week2, maxDay);

  const grand = {}; COMPANIES.forEach((c) => (grand[c.id] = days14.reduce((s, d) => s + d.totals[c.id], 0)));
  const grandTotal = COMPANIES.reduce((s, c) => s + grand[c.id], 0);
  el("#period-totals").innerHTML = COMPANIES.map((c) =>
    `<div class="wt-item"><span class="dot" style="background:${c.color}"></span>${c.short}
     <span class="wt-hours">${fmtH(grand[c.id])}h</span></div>`
  ).join("") + `<div class="wt-grand">Total ${fmtH(grandTotal)}h</div>`;

  updateTodayTotals();
}

// ---------- weekly tasks nav ----------
el("#task-week-prev").addEventListener("click", () => { taskWeekOffset--; renderTasks(); });
el("#task-week-next").addEventListener("click", () => { taskWeekOffset++; renderTasks(); });

function currentMonday() { return getMonday(addDays(new Date(), taskWeekOffset * 7)); }

// ---------- tasks ----------
el("#new-task-company").innerHTML = `<option value="">\u2014</option>` +
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
  el("#task-week-label").textContent = `Tasks for week of ${shortDate(monday)} \u2013 ${shortDate(addDays(monday, 6))}`;
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
      <button class="icon-btn" data-del="${t.id}" style="font-size:14px">\u2715</button>
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
    const total = entryTotalHours(e);
    const co = COMPANIES.find((c) => c.id === e.company);
    const bar = co
      ? `<span style="width:100%;background:${co.color}"></span>`
      : COMPANIES.map((c) => {
          const h = entryHoursFor(e, c.id);
          const pct = total > 0 ? (h / total) * 100 : 0;
          return pct > 0 ? `<span style="width:${pct}%;background:${c.color}"></span>` : "";
        }).join("");
    const detail = co
      ? `<span style="color:${co.color}">${co.short}</span> ${fmtH(total)}h`
      : COMPANIES.map((c) => {
          const h = entryHoursFor(e, c.id);
          return h > 0 ? `<span style="color:${c.color}">${c.short}</span> ${fmtH(h)}h` : "";
        }).filter(Boolean).join(" &nbsp; ");
    return `<div class="entry-row">
      <div class="entry-date">${e.date}</div>
      <div class="entry-mid">
        <div class="entry-bar">${bar}</div>
        <div class="entry-detail">${detail}${e.note ? ` &nbsp; <em>"${escapeHtml(e.note)}"</em>` : ""}</div>
      </div>
      <div class="entry-hours">${fmtH(total)}h</div>
      <button class="icon-btn" data-entrydel="${e.id}">\u2715</button>
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
