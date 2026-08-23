import { balances, cents, formatCents, makeExpense, settlementPlan } from "./ledger.js";

const DB_NAME = "div-it";
const STORE = "state";
const KEY = "group";
let state;
let statusMessage = "";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readState() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve(request.result || { name: "My group", currency: "USD", people: [], events: [] });
    request.onerror = () => reject(request.error);
  });
}

async function saveState() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(state, KEY);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

const escape = (text) => text.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const person = (id) => state.people.find((entry) => entry.id === id)?.name || "Unknown";
const money = (amount) => formatCents(amount, state.currency);

function render() {
  const balanceMap = balances(state.events, state.people);
  const transfers = settlementPlan(balanceMap);
  document.querySelector("#app").innerHTML = `
    <header><p class="eyebrow">LOCAL-FIRST EXPENSE SHARING</p><h1>Div It</h1><p id="notice" aria-live="polite">${escape(statusMessage)}</p></header>
    <section class="card"><label>Group name <input id="group-name" value="${escape(state.name)}"></label><label>Currency <select id="currency"><option ${state.currency === "USD" ? "selected" : ""}>USD</option><option ${state.currency === "INR" ? "selected" : ""}>INR</option><option ${state.currency === "EUR" ? "selected" : ""}>EUR</option><option ${state.currency === "GBP" ? "selected" : ""}>GBP</option></select></label><button id="save-group" type="button">Save group</button></section>
    <div class="grid">
      <section class="card"><h2>People</h2><form id="person-form" novalidate><input id="person-name" placeholder="Name"><button type="submit">Add</button></form><ul class="people">${state.people.map((entry) => `<li>${escape(entry.name)} <span>${money(balanceMap[entry.id])}</span></li>`).join("") || "<li>Add people to begin.</li>"}</ul></section>
      <section class="card"><h2>Add expense</h2><form id="expense-form" novalidate><label>Description <input id="description" placeholder="Dinner"></label><label>Amount <input id="amount" inputmode="decimal" min="0.01" step="0.01"></label><label>Paid by <select id="payer">${state.people.map((entry) => `<option value="${entry.id}">${escape(entry.name)}</option>`).join("")}</select></label><fieldset id="participants"><legend>Split with</legend>${state.people.map((entry) => `<label><input type="checkbox" value="${entry.id}" checked> ${escape(entry.name)}</label>`).join("") || "Add people first."}</fieldset><label>Split type <select id="split-type"><option value="equal">Equal</option><option value="exact">Exact amounts</option></select></label><div id="exact-splits" hidden></div><button type="submit" ${state.people.length ? "" : "disabled"}>${state.people.length ? "Add expense" : "Add people first"}</button></form></section>
    </div>
    <section class="card"><h2>Settle up</h2><ul>${transfers.map((transfer) => `<li><strong>${escape(person(transfer.from))}</strong> pays <strong>${escape(person(transfer.to))}</strong> ${money(transfer.amount)}</li>`).join("") || "<li>Everyone is settled.</li>"}</ul></section>
    <section class="card"><h2>History</h2><ol>${[...state.events].reverse().map((event) => `<li><strong>${escape(event.description)}</strong> — ${money(event.amount)} paid by ${escape(person(event.payerId))}<small>${new Date(event.createdAt).toLocaleString()}</small></li>`).join("") || "<li>No expenses yet.</li>"}</ol></section>
    <footer><button id="export-json" type="button">Export backup</button><label class="import">Import backup <input id="import-json" type="file" accept="application/json"></label></footer>`;
  bindEvents();
}

function notice(message) { statusMessage = message; document.querySelector("#notice").textContent = message; }

function renderExactInputs() {
  const box = document.querySelector("#exact-splits");
  const selected = [...document.querySelectorAll("#participants input:checked")];
  box.innerHTML = selected.map((input) => `<label>${escape(person(input.value))}<input class="split-amount" data-person="${input.value}" inputmode="decimal" min="0" step="0.01" required></label>`).join("");
}

function bindEvents() {
  document.querySelector("#save-group").onclick = async () => { state = { ...state, name: document.querySelector("#group-name").value.trim() || "My group", currency: document.querySelector("#currency").value }; await saveState(); notice("Group saved locally."); render(); };
  document.querySelector("#person-form").onsubmit = async (event) => { event.preventDefault(); const name = document.querySelector("#person-name").value.trim(); if (!name) return notice("Enter a name."); state = { ...state, people: [...state.people, { id: crypto.randomUUID(), name }] }; await saveState(); notice(`${name} added.`); render(); };
  const splitType = document.querySelector("#split-type");
  splitType.onchange = () => { const exact = splitType.value === "exact"; document.querySelector("#exact-splits").hidden = !exact; if (exact) renderExactInputs(); };
  document.querySelector("#participants").onchange = () => { if (splitType.value === "exact") renderExactInputs(); };
  document.querySelector("#expense-form").onsubmit = async (event) => {
    event.preventDefault();
    try {
      const amount = cents(document.querySelector("#amount").value);
      const participantIds = [...document.querySelectorAll("#participants input:checked")].map((input) => input.value);
      const splits = splitType.value === "equal" ? participantIds.map((personId, index) => ({ personId, amount: Math.floor(amount / participantIds.length) + (index < amount % participantIds.length ? 1 : 0) })) : [...document.querySelectorAll(".split-amount")].map((input) => ({ personId: input.dataset.person, amount: cents(input.value) }));
      state = { ...state, events: [...state.events, makeExpense({ description: document.querySelector("#description").value, amount, payerId: document.querySelector("#payer").value, splits })] };
      await saveState(); notice("Expense saved locally."); render();
    } catch (error) { notice(error.message); }
  };
  document.querySelector("#export-json").onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" })); const link = Object.assign(document.createElement("a"), { href: url, download: "div-it-backup.json" }); link.click(); URL.revokeObjectURL(url); };
  document.querySelector("#import-json").onchange = async (event) => { try { const imported = JSON.parse(await event.target.files[0].text()); if (!Array.isArray(imported.people) || !Array.isArray(imported.events)) throw new Error("Not a Div It backup."); state = imported; await saveState(); render(); } catch (error) { notice(error.message); } };
}

state = await readState();
render();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
