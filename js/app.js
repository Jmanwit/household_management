import * as Store from "./store.js";
import * as Cloud from "./cloud.js";
import { requireAuth, renameActiveWorkspace, getSignedInUser } from "./auth.js";

const $ = id => document.getElementById(id);
const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const shortDays = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
let currentView = "today", taskFilter = "all", calendarMode = "day", selectedDays = new Set(), operations = [];
let toastTimer;
let authenticatedWorkspace = null;
let signedInUser = null;

function toast(message) {
  $("toast").textContent = message; $("toast").classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>$("toast").classList.remove("show"), 2600);
}
function keyDate(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function dateLabel(d = new Date()) { return d.toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"}); }
function parseTime(t) { if(!t)return null; const [h,m]=t.split(":").map(Number); return h*60+m; }
function statusFor(task, date = keyDate()) {
  const occ = task.occurrences?.[date];
  if (occ?.status === "completed") return "done";
  if (occ?.status === "progress") return "progress";
  const start = parseTime(task.start);
  const now = new Date();
  if (date < keyDate()) return "late";
  if (date === keyDate() && start !== null && now.getHours()*60+now.getMinutes() >= start) return "late";
  return "future";
}
function taskOccurs(task, date) {
  const d = new Date(date + "T12:00:00");
  if (task.repeat === "daily") return true;
  if (task.repeat === "weekdays") return (task.weekdays || []).includes(d.getDay());
  return task.date === date;
}
function todayTasks() {
  const date=keyDate();
  return Cloud.getState().tasks.filter(t=>taskOccurs(t,date)).sort((a,b)=>(parseTime(a.start)??9999)-(parseTime(b.start)??9999));
}
function person(id) { return Cloud.getState().people.find(p=>p.id===id); }
function personName(id) { return person(id)?.name || "Unassigned"; }
function personColor(id) { return person(id)?.color || "#6f8876"; }
function timeText(t) { if(!t)return "Anytime"; const [h,m]=t.split(":").map(Number); const d=new Date();d.setHours(h,m);return d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}); }
function empty(title,desc) { return `<div class="empty-state"><strong>${title}</strong>${desc}</div>`; }
function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebarBackdrop").classList.remove("visible");
}
function openSidebar() {
  $("sidebar").classList.add("open");
  $("sidebarBackdrop").classList.add("visible");
}
function setView(view) {
  currentView=view;
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===`view-${view}`));
  document.querySelectorAll(".nav-item[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  $("pageTitle").textContent={today:"Today",calendar:"Calendar",tasks:"Tasks",meals:"Meals",groceries:"Groceries",people:"People",ledger:"Activity",settings:"Settings"}[view]||"Today";
  closeSidebar();
  render();
}
function renderToday() {
  const state={...Store.getState(), ...Cloud.getState()}, tasks=todayTasks();
  const done=tasks.filter(t=>statusFor(t)==="done").length, progress=tasks.filter(t=>statusFor(t)==="progress").length, late=tasks.filter(t=>statusFor(t)==="late").length;
  $("scheduledCount").textContent=tasks.length; $("completedCount").textContent=done; $("progressCount").textContent=progress; $("notStartedCount").textContent=late;
  $("dateLabel").textContent=dateLabel().toUpperCase(); $("greeting").textContent=new Date().getHours()<12?"Good morning. Here's the shape of the day.":new Date().getHours()<17?"A clear plan for the rest of the day.":"Let's bring the day home.";
  $("todayAgenda").innerHTML=tasks.length?tasks.map(t=>`<div class="agenda-item"><div class="agenda-time">${timeText(t.start)}</div><div class="agenda-stripe" style="--person-color:${personColor((t.assigneeIds||[])[0])}"></div><div><div class="agenda-name">${esc(t.name)}</div><div class="agenda-meta">${esc((t.assigneeIds||[]).map(personName).join(", ")||"Unassigned")}${t.end?" · until "+timeText(t.end):""}</div></div><span class="status-dot ${statusFor(t)}" title="${statusFor(t)}"></span></div>`).join(""):empty("Nothing scheduled yet","Create a task and it will appear here.");
  $("householdMini").innerHTML=state.people.length?state.people.map(p=>`<div class="person-mini"><span class="person-dot" style="--person-color:${p.color}"></span><span class="person-name">${esc(p.name)}</span><span class="person-count">${p.role}</span></div>`).join(""):empty("Add your household","Create member profiles to assign responsibilities.");
  const dinner=state.meals.find(m=>Number(m.day)===new Date().getDay());
  $("dinnerPreview").innerHTML=dinner?`<div class="empty-icon">♨</div><div><strong>${esc(dinner.name)}</strong><div class="agenda-meta">${esc(dinner.notes||"Dinner plan")}</div></div>`:`<div class="empty-icon">♨</div><p>No dinner planned yet.</p>`;
}
function renderTasks() {
  const tasks=Cloud.getState().tasks.filter(t=>taskFilter==="all"||(taskFilter==="active"&&!t.archived)||(taskFilter==="recurring"&&t.repeat!=="once"));
  $("taskList").innerHTML=tasks.length?tasks.map(t=>{const done=t.occurrences?.[keyDate()]?.status==="completed";const names=(t.assigneeIds||[]).map(personName).join(", ")||"Unassigned";const canEdit=Cloud.canManageTask(t);const canComplete=Cloud.canCompleteTask(t);return `<div class="task-row"><button class="task-check ${done?"checked":""}" data-complete="${t.id}" ${!canComplete||done?"disabled":""} aria-label="Complete task">${done?"✓":""}</button><div class="task-main"><div class="task-title">${esc(t.name)}</div><div class="task-detail">${esc(names)} · ${repeatText(t)} · ${t.operations?.length||0} steps${done?" · Completed"+(t.occurrences?.[keyDate()]?.completedByProfileId?" by "+esc(personName(t.occurrences[keyDate()].completedByProfileId)):""):""}</div></div><div class="task-time">${timeText(t.start)}</div>${canEdit?`<button class="task-edit" data-edit-task="${t.id}" aria-label="Edit task">⋯</button>`:""}</div>`}).join(""):empty("No tasks here yet","Add a task to begin building your household routine.");
}
function repeatText(t) { return t.repeat==="daily"?"Daily":t.repeat==="weekdays"?(t.weekdays||[]).map(x=>shortDays[x]).join(", "):"One time"; }
function renderMeals() {
  const meals=Store.getState().meals.slice().sort((a,b)=>Number(a.day)-Number(b.day));
  $("mealList").innerHTML=meals.length?meals.map(m=>`<div class="meal-row"><div class="meal-day">${days[Number(m.day)]}</div><div><div class="meal-name">${esc(m.name)}</div><div class="meal-notes">${esc(m.notes||"")}</div></div><button class="task-edit" data-delete-meal="${m.id}" disabled title="Meal synchronization is coming later">×</button></div>`).join(""):empty("A week of possibilities.","Add meals as you plan them.");
}
function renderGroceries() {
  const items=Store.getState().groceries;
  $("groceryList").innerHTML=items.length?items.map(i=>`<div class="grocery-row ${i.done?"done":""}"><input type="checkbox" data-grocery="${i.id}" ${i.done?"checked":""} disabled style="width:17px;height:17px"><label>${esc(i.name)}</label><span class="grocery-category">${esc(i.category)}</span></div>`).join(""):empty("Your list is clear.","Add groceries, ingredients, and household supplies.");
}
function renderPeople() {
  const people=Cloud.getState().people;
  $("addPersonButton").hidden=!Cloud.canManageProfiles();
  $("peopleGrid").innerHTML=people.length?people.map(p=>`<article class="person-card"><div class="person-avatar" style="background:${p.color}">${esc(p.name.slice(0,1).toUpperCase())}</div><h3>${esc(p.name)}</h3><p>${esc(p.role)} · ${p.accountId?"Account linked":"Member profile"}</p></article>`).join(""):empty("Start with your people.","Add member profiles now. Accounts and invitations can be linked later.");
}
function renderLedger() {
  const entries=Store.getState().ledger;
  $("ledgerList").innerHTML=entries.length?entries.map(e=>`<div class="ledger-row"><div class="ledger-symbol">↗</div><div class="ledger-text"><strong>${esc(e.action)}</strong>${e.detail?` · ${esc(e.detail)}`:""}<div class="ledger-time">${new Date(e.at).toLocaleString()}</div></div></div>`).join(""):empty("Your workspace starts here.","Changes and completed work will appear in this activity history.");
}
function renderCalendar() {
  const date=new Date(); const d=keyDate(date); $("calendarDate").textContent=dateLabel(date);
  const tasks=Cloud.getState().tasks.filter(t=>taskOccurs(t,d));
  let html="";
  for(let h=6;h<23;h++){
    html+=`<div class="time-label">${new Date(2000,0,1,h).toLocaleTimeString([],{hour:"numeric"})}</div><div class="time-slot" data-hour="${h}"></div>`;
  }
  $("calendarGrid").innerHTML=html;
  tasks.forEach(t=>{
    const start=parseTime(t.start)??9*60, end=parseTime(t.end)??start+45;
    const top=(start-6*60)/60*62, height=Math.max(34,(end-start)/60*62);
    const slot=$(`calendarGrid`).querySelector(`[data-hour="${Math.max(6,Math.min(22,Math.floor(start/60)))}"]`);
    if(slot){const ev=document.createElement("div");ev.className="calendar-event";ev.style.cssText=`top:${(start%60)/60*62}px;height:${Math.min(height,500)}px;--person-color:${personColor((t.assigneeIds||[])[0])}`;ev.innerHTML=`<strong>${esc(t.name)}</strong><small>${timeText(t.start)} · ${esc((t.assigneeIds||[]).map(personName).join(", ")||"Unassigned")}</small>`;slot.appendChild(ev);}
  });
}
function render() {
  const visibleWorkspaceName = authenticatedWorkspace?.name || Store.getState().workspace.name;
  $("workspaceName").textContent = visibleWorkspaceName;
  $("settingsWorkspace").value = visibleWorkspaceName;
  renderToday();renderTasks();renderMeals();renderGroceries();renderPeople();renderLedger();renderCalendar();
  const away=Store.getState().workspace.away;
  $("awayButton").innerHTML=away?`☼ <span class="desktop-only">Away mode on</span>`:`☼ <span class="desktop-only">Away mode</span>`;
}
function esc(s="") { return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function populatePeopleSelects() {
  const people=Cloud.getState().people;
  $("taskAssigneeOptions").innerHTML=people.length?people.map(p=>`<label class="assignee-option"><input type="checkbox" value="${p.id}" data-assignee-option> <span>${esc(p.name)}</span></label>`).join(""):empty("No household profiles yet","An Admin or authorized Manager can add people first.");
  $("awayPerson").innerHTML=`<option value="">Select a person</option>`+people.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join("");
}
function openTask(task=null) {
  populatePeopleSelects(); $("taskEditor").reset(); operations=[]; selectedDays=new Set();
  $("taskId").value=task?.id||""; $("taskDialogTitle").textContent=task?"Edit task":"Create a task";
  $("taskName").value=task?.name||""; 
  const assigned=new Set(task?.assigneeIds||[]);
  if(!task && !Cloud.canAssignAnyone() && Cloud.getMembership()?.member_profile_id) assigned.add(Cloud.getMembership().member_profile_id);
  document.querySelectorAll("[data-assignee-option]").forEach(o=>{o.checked=assigned.has(o.value);o.disabled=!Cloud.canAssignAnyone();});
  $("taskRepeat").value=task?.repeat||"once";
  $("taskStart").value=task?.start||""; $("taskEnd").value=task?.end||""; $("taskNotes").value=task?.notes||"";
  if(task?.weekdays) selectedDays=new Set(task.weekdays);
  operations=(task?.operations||[]).map(o=>({...o}));
  $("deleteTaskButton").hidden=!(task && Cloud.canManageTask(task));
  $("weekdayPicker").hidden=$("taskRepeat").value!=="weekdays";
  renderOperations();renderWeekdays();$("taskDialog").showModal();
}
function renderOperations() {
  $("operationEditor").innerHTML=operations.map((o,i)=>`<div class="operation-row"><input type="checkbox" ${o.required===false?"":"checked"} data-op-required="${i}" style="width:16px"><input type="text" value="${esc(o.name)}" data-op-name="${i}"><button type="button" class="op-remove" data-op-remove="${i}">×</button></div>`).join("");
}
function renderWeekdays() { document.querySelectorAll("[data-day]").forEach(b=>b.classList.toggle("selected",selectedDays.has(Number(b.dataset.day)))); }
async function saveTaskFromForm() {
  const id=$("taskId").value, repeat=$("taskRepeat").value;
  if(repeat==="weekdays"&&!selectedDays.size){toast("Choose at least one weekday.");return false;}
  const task={id:id||undefined,name:$("taskName").value.trim(),assigneeIds:[...document.querySelectorAll("[data-assignee-option]:checked")].map(o=>o.value),repeat,weekdays:repeat==="weekdays"?[...selectedDays]:[],date:repeat==="once"?keyDate():null,start:$("taskStart").value||null,end:$("taskEnd").value||null,operations,notes:$("taskNotes").value.trim()};
  if(!task.name)return false;
  try { await Cloud.saveTask(task); $("taskDialog").close(); toast("Task saved and shared."); render(); return true; }
  catch(error) { toast("Could not save task: "+error.message); return false; }
}
function setup() {
  document.querySelectorAll(".nav-item[data-view]").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.view)));
  document.querySelectorAll("[data-go]").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.go)));
  $("quickAddTask").onclick=$("newTaskButton").onclick=()=>openTask();
  $("taskRepeat").onchange=()=>{$("weekdayPicker").hidden=$("taskRepeat").value!=="weekdays";};
  document.querySelectorAll("[data-day]").forEach(b=>b.onclick=()=>{const d=Number(b.dataset.day);selectedDays.has(d)?selectedDays.delete(d):selectedDays.add(d);renderWeekdays();});
  $("addOperation").onclick=()=>{const v=$("newOperation").value.trim();if(v){operations.push({name:v,required:true});$("newOperation").value="";renderOperations();}};
  $("operationEditor").addEventListener("click",e=>{const i=e.target.dataset.opRemove;if(i!==undefined){operations.splice(Number(i),1);renderOperations();}});
  $("operationEditor").addEventListener("change",e=>{if(e.target.dataset.opRequired!==undefined)operations[Number(e.target.dataset.opRequired)].required=e.target.checked;if(e.target.dataset.opName!==undefined)operations[Number(e.target.dataset.opName)].name=e.target.value;});
  $("taskEditor").addEventListener("submit",e=>{e.preventDefault();saveTaskFromForm();});
  $("deleteTaskButton").onclick=async()=>{const id=$("taskId").value;if(id&&confirm("Delete this task? Its task definition will be removed.")){try{await Cloud.deleteTask(id);$("taskDialog").close();render();toast("Task deleted.");}catch(error){toast("Could not delete task: "+error.message);}}};
  $("taskList").addEventListener("click",async e=>{const id=e.target.dataset.editTask;if(id)openTask(Cloud.getState().tasks.find(t=>t.id===id));const complete=e.target.dataset.complete;if(complete){try{await Cloud.setOccurrence(complete,keyDate(),"completed");render();toast("Task completed for everyone.");}catch(error){toast("Could not complete task: "+error.message);}}});
  document.querySelectorAll("[data-task-filter]").forEach(b=>b.onclick=()=>{taskFilter=b.dataset.taskFilter;document.querySelectorAll("[data-task-filter]").forEach(x=>x.classList.toggle("selected",x===b));renderTasks();});
  $("addPersonButton").onclick=()=>{$("personEditor").reset();$("personDialog").showModal();};
  $("personEditor").addEventListener("submit",async e=>{e.preventDefault();const name=$("personName").value.trim();if(name){try{await Cloud.addPerson({name,color:$("personColor").value,role:$("personRole").value});$("personDialog").close();populatePeopleSelects();render();toast("Member profile added.");}catch(error){toast("Could not add member: "+error.message);}}});
  $("addMealButton").onclick=()=>{$("mealEditor").reset();$("mealDialog").showModal();};
  $("mealEditor").addEventListener("submit",e=>{e.preventDefault();Store.addMeal({day:$("mealDay").value,name:$("mealName").value.trim(),notes:$("mealNotes").value.trim()});$("mealDialog").close();render();toast("Meal added.");});
  $("mealList").addEventListener("click",e=>{const id=e.target.dataset.deleteMeal;if(id){Store.update(s=>s.meals=s.meals.filter(m=>m.id!==id),"Removed a meal","");render();}});
  $("groceryForm").onsubmit=e=>{e.preventDefault();const name=$("groceryInput").value.trim();if(name){Store.addGrocery({name,category:$("groceryCategory").value});$("groceryInput").value="";renderGroceries();}};
  $("groceryList").addEventListener("change",e=>{const id=e.target.dataset.grocery;if(id){Store.toggleGrocery(id);renderGroceries();}});
  $("clearGroceries").onclick=()=>{Store.clearCompletedGroceries();renderGroceries();};
  $("saveWorkspace").onclick=async()=>{
    const proposed = $("settingsWorkspace").value.trim();
    if (!proposed) { toast("Enter a workspace name."); return; }
    try {
      authenticatedWorkspace = await renameActiveWorkspace(proposed);
      Store.saveWorkspaceName(proposed);
      render();
      toast("Workspace name saved.");
    } catch (error) { toast("Could not save workspace name: " + error.message); }
  };
  $("exportData").onclick=()=>{const blob=new Blob([Store.exportState()],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="wiwy-backup-"+keyDate()+".json";a.click();URL.revokeObjectURL(a.href);};
  $("importData").onchange=async e=>{const f=e.target.files[0];if(!f)return;try{Store.importState(JSON.parse(await f.text()));render();toast("Backup imported.");}catch(err){alert(err.message);}e.target.value="";};
  $("awayButton").onclick=()=>{populatePeopleSelects();$("awayPersonWrap").hidden=true;$("awayScope").onchange=()=>{$("awayPersonWrap").hidden=$("awayScope").value!=="person";};$("awayDialog").showModal();};
  $("awayEditor").addEventListener("submit",e=>{e.preventDefault();const scope=$("awayScope").value;Store.setAway({scope,personId:scope==="person"?$("awayPerson").value:null,duration:$("awayDuration").value,enabledAt:new Date().toISOString()});$("awayDialog").close();render();toast("Away mode enabled.");});
  $("turnOffAway").onclick=()=>{Store.setAway(null);$("awayDialog").close();render();toast("Away mode turned off.");};
  $("mobileMenu").onclick=()=> {
    if ($("sidebar").classList.contains("open")) closeSidebar();
    else openSidebar();
  };
  $("sidebarBackdrop").onclick=closeSidebar;
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeSidebar(); });
  $("workspaceButton").onclick=()=>toast("Workspace switching will be added with account and invitation support.");
  $("notificationButton").onclick=()=>toast("Notifications are planned for the next build stage.");
  $("profileButton").onclick=()=>{
    const menu = $("accountMenu");
    menu.hidden = !menu.hidden;
    $("profileButton").setAttribute("aria-expanded", String(!menu.hidden));
  };
  $("accountMenu").addEventListener("click", async e => {
    const action = e.target.closest("[data-account-action]")?.dataset.accountAction;
    if (!action) return;
    $("accountMenu").hidden = true;
    if (action === "account") { setView("settings"); toast("Account settings will be expanded in a later update."); }
    if (action === "household") { setView("settings"); $("settingsWorkspace").focus(); }
    if (action === "signout") {
      if (!confirm("Sign out of WIWY on this device?")) return;
      try { await window.WIWY_AUTH?.client?.auth.signOut(); location.reload(); }
      catch(error) { toast("Could not sign out: " + error.message); }
    }
  });
  document.addEventListener("click", e => {
    if (!$("accountMenu").hidden && !e.target.closest("#profileButton") && !e.target.closest("#accountMenu")) {
      $("accountMenu").hidden = true;
      $("profileButton").setAttribute("aria-expanded", "false");
    }
  });
  document.querySelectorAll("[data-cal-mode]").forEach(b=>b.onclick=()=>{calendarMode=b.dataset.calMode;document.querySelectorAll("[data-cal-mode]").forEach(x=>x.classList.toggle("selected",x===b));toast(calendarMode==="week"?"Week view is coming in the next calendar pass.":"Day view selected.");});
  $("prevDay").onclick=$("nextDay").onclick=()=>toast("Date navigation is coming in the next calendar pass.");
  render();
}
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./service-worker.js").catch(()=>{});
(async () => {
  try {
    const auth = await requireAuth();
    window.WIWY_AUTH = auth;
    authenticatedWorkspace = auth.workspace;
    signedInUser = await getSignedInUser();
    await Cloud.initialize(auth.client, auth.workspace, auth.membership, signedInUser);
    const avatar = document.getElementById("profileButton");
    if (avatar) {
      avatar.textContent = "♙";
      avatar.setAttribute("aria-label", "Account menu");
      avatar.setAttribute("aria-haspopup", "true");
      avatar.setAttribute("aria-expanded", "false");
    }
    setup();
    document.addEventListener("wiwy-cloud-updated", () => { render(); });
    toast("Connected. Household tasks are syncing.");
  } catch (error) {
    console.error("WIWY authentication startup:", error);
    const msg = document.getElementById("authMessage");
    if (msg) { msg.textContent = "WIWY could not load shared household data: " + (error.message || "Unknown connection error") + ". Refresh the page and try again."; msg.classList.add("error"); document.getElementById("authGate").hidden = false; }
  }
})();
