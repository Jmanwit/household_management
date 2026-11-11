import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const STORAGE_KEY = "wiwy_workspace_v1";
let supabase = null;
let syncEnabled = false;

const seed = () => ({
  workspace: { id: crypto.randomUUID(), name: "Our Home", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, away: null },
  people: [],
  tasks: [],
  meals: [],
  groceries: [],
  ledger: []
});

let state = loadLocal();

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...seed(), ...JSON.parse(raw) } : seed();
  } catch { return seed(); }
}
function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function log(action, detail) {
  state.ledger.unshift({ id: crypto.randomUUID(), action, detail, at: new Date().toISOString() });
  state.ledger = state.ledger.slice(0, 150);
}
export function getState() { return structuredClone(state); }
export function update(mutator, action = "Updated workspace", detail = "") {
  mutator(state);
  if (action) log(action, detail);
  persist();
  return getState();
}
export function addPerson(person) {
  return update(s => s.people.push({ id: crypto.randomUUID(), name: person.name, color: person.color, role: person.role || "Member", accountId: null, createdAt: new Date().toISOString() }), "Added a member", person.name);
}
export function saveTask(task) {
  return update(s => {
    const existing = s.tasks.find(t => t.id === task.id);
    if (existing) Object.assign(existing, task, { updatedAt: new Date().toISOString() });
    else s.tasks.push({ ...task, id: crypto.randomUUID(), createdAt: new Date().toISOString(), occurrences: {} });
  }, task.id ? "Updated a task" : "Created a task", task.name);
}
export function deleteTask(id) { return update(s => { s.tasks = s.tasks.filter(t => t.id !== id); }, "Deleted a task", "Task removed"); }
export function setOccurrence(taskId, dateKey, done) {
  return update(s => {
    const task = s.tasks.find(t => t.id === taskId);
    if (!task) return;
    task.occurrences ||= {};
    task.occurrences[dateKey] = { status: done ? "completed" : "not_started", completedAt: done ? new Date().toISOString() : null };
  }, done ? "Completed a task" : "Reopened a task", state.tasks.find(t => t.id === taskId)?.name || "");
}
export function addMeal(meal) { return update(s => s.meals.push({ ...meal, id: crypto.randomUUID() }), "Added a meal", meal.name); }
export function addGrocery(item) { return update(s => s.groceries.push({ ...item, id: crypto.randomUUID(), done: false }), "Added grocery item", item.name); }
export function toggleGrocery(id) { return update(s => { const item=s.groceries.find(x=>x.id===id); if(item)item.done=!item.done; }, "Updated grocery list", "Changed an item"); }
export function clearCompletedGroceries() { return update(s => { s.groceries=s.groceries.filter(x=>!x.done); }, "Cleared completed groceries", ""); }
export function saveWorkspaceName(name) { return update(s => s.workspace.name = name, "Renamed workspace", name); }
export function setAway(away) { return update(s => s.workspace.away = away, away ? "Enabled away mode" : "Disabled away mode", away ? "Routine alerts paused" : "Routine alerts resumed"); }
export function exportState() { return JSON.stringify(state, null, 2); }
export function importState(obj) {
  if (!obj || !obj.workspace || !Array.isArray(obj.people) || !Array.isArray(obj.tasks)) throw new Error("This doesn't look like a WIWY backup.");
  state = { ...seed(), ...obj };
  persist();
  return getState();
}
export async function connectSupabase(url = SUPABASE_URL, key = SUPABASE_PUBLISHABLE_KEY) {
  if (!url || !key) return { ok: false, message: "Add your Project URL and Publishable key in js/config.js or Settings." };
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    supabase = createClient(url, key);
    syncEnabled = true;
    return { ok: true, message: "Supabase client initialized. Database sync will be enabled after the schema is installed." };
  } catch (e) { return { ok: false, message: "Could not initialize Supabase: " + e.message }; }
}
export function connectionInfo() { return { syncEnabled, configured: Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY) }; }
