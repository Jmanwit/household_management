import * as Store from "./store.js";
import * as Cloud from "./cloud.js";
import { requireAuth, renameActiveWorkspace, getSignedInUser } from "./auth.js";

const $ = id => document.getElementById(id);
const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const shortDays = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
let currentView = "today", taskFilter = "all", calendarMode = "day", selectedDays = new Set(), operations = [], viewHistory = [];
let calendarDate = new Date(); calendarDate.setHours(12,0,0,0);
let calendarReturnToMonth = false;
let detailDateKey = keyDate();
let toastTimer;
let authenticatedWorkspace = null;
let signedInUser = null;

function toast(message) {
  $("toast").textContent = message; $("toast").classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>$("toast").classList.remove("show"), 4200);
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
function setView(view, fromBack=false) {
  if (view === currentView) return;
  if (!fromBack) viewHistory.push(currentView);
  currentView=view;
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===`view-${view}`));
  document.querySelectorAll(".nav-item[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  $("pageTitle").textContent={today:"Today",calendar:"Calendar",tasks:"Tasks",meals:"Meals",groceries:"Groceries",people:"People",ledger:"Activity",settings:"Settings"}[view]||"Today";
  $("pageBack").hidden = view === "today";
  closeSidebar();
  render();
}
function goBack() { const previous=viewHistory.pop()||"today"; setView(previous,true); }

function askWIWYConfirm(title, message, acceptLabel="Confirm") {
  return new Promise(resolve => {
    const dialog=$("wiwyConfirmDialog");
    $("wiwyConfirmTitle").textContent=title;
    $("wiwyConfirmMessage").textContent=message;
    $("wiwyConfirmAccept").textContent=acceptLabel;
    const finish=value=>{dialog.close();$("wiwyConfirmAccept").removeEventListener("click",yes);$("wiwyConfirmCancel").removeEventListener("click",no);dialog.removeEventListener("cancel",cancel);resolve(value);};
    const yes=()=>finish(true), no=()=>finish(false), cancel=e=>{e.preventDefault();finish(false);};
    $("wiwyConfirmAccept").addEventListener("click",yes);
    $("wiwyConfirmCancel").addEventListener("click",no);
    dialog.addEventListener("cancel",cancel);
    dialog.showModal();
  });
}
async function openTaskDetails(task, date=keyDate()) {
  if(!task)return;
  detailDateKey=date;
  try { if(taskOccurs(task,date) && !task.occurrences?.[date]?.id) await Cloud.ensureOccurrence(task.id,date); } catch(error) { toast("Could not prepare task occurrence: "+error.message); }
  task=Cloud.getState().tasks.find(t=>t.id===task.id)||task;
  const occurrence=task.occurrences?.[date];
  const done=occurrence?.status==="completed";
  const names=(task.assigneeIds||[]).map(personName).join(", ")||"Unassigned";
  const canComplete=Cloud.canCompleteTask(task);
  const canEdit=Cloud.canManageTask(task);
  const operations=task.operations||[];
  const steps=operations.length
    ? `<section class="detail-section"><h3>Steps</h3><ul class="detail-steps">${operations.map(o=>`<li><label class="detail-step ${o.completedDates?.[date]?"step-done":""}"><input type="checkbox" data-detail-step-task="${task.id}" data-detail-step-date="${date}" data-detail-step-id="${o.id}" ${o.completedDates?.[date]?"checked":""} ${!canComplete||done?"disabled":""}><span>${esc(o.name)}</span></label></li>`).join("")}</ul></section>`
    : "";
  const status=done?"Completed":occurrence?.status==="progress"?"In progress":statusFor(task,date)==="late"?"Needs a start":"Scheduled";
  $("taskDetailTitle").textContent=task.name;
  $("taskDetailContent").innerHTML=`
    <section class="detail-section"><h3>Schedule</h3><p>${esc(dateLabel(new Date(date+"T12:00:00")))} · ${esc(timeText(task.start))}${task.end?" – "+esc(timeText(task.end)):""}</p></section>
    <section class="detail-section"><h3>Assigned to</h3><p>${esc(names)}</p></section>
    ${task.notes?`<section class="detail-section"><h3>Notes</h3><p class="detail-notes">${esc(task.notes)}</p></section>`:""}
    ${steps}
    <section class="detail-section"><h3>Status</h3><p id="taskDetailStatus">${status}${done&&occurrence?.completedByProfileId?" · Completed by "+esc(personName(occurrence.completedByProfileId)):""}</p></section>
    <div class="detail-actions">
      ${done&&canEdit?`<button class="secondary-button" data-detail-reopen="${task.id}">Reopen task</button>`:!done&&canComplete?`<button class="primary-button" data-detail-complete="${task.id}">Mark task complete</button>`:""}
    </div>`;
  $("taskDetailDialog").dataset.taskId=task.id;
  $("taskDetailDialog").dataset.dateKey=date;
  $("taskDetailDialog").showModal();
}
async function completeTaskFromDetails(taskId) {
  const task=Cloud.getState().tasks.find(t=>t.id===taskId); if(!task)return;
  const date=detailDateKey;
  try {
    if(task.operations?.length>=2){
      if(!await askWIWYConfirm("Complete this task?","Are all steps for this task complete? Confirming will mark every step complete.","Complete task"))return;
      await Cloud.completeAllStepsAndTask(taskId,date);
    } else if(task.operations?.length===1) {
      await Cloud.completeAllStepsAndTask(taskId,date);
    } else {
      await Cloud.setOccurrence(taskId,date,"completed");
    }
    render(); await openTaskDetails(Cloud.getState().tasks.find(t=>t.id===taskId),date); toast("✓ Task completed for everyone.");
  } catch(error){toast("Could not complete task: "+error.message);}
}

function renderToday() {
  const state={...Store.getState(), ...Cloud.getState()}, tasks=todayTasks();
  const done=tasks.filter(t=>statusFor(t)==="done").length, progress=tasks.filter(t=>statusFor(t)==="progress").length, late=tasks.filter(t=>statusFor(t)==="late").length;
  $("scheduledCount").textContent=tasks.length; $("completedCount").textContent=done; $("progressCount").textContent=progress; $("notStartedCount").textContent=late;
  $("dateLabel").textContent=dateLabel().toUpperCase(); $("greeting").textContent=new Date().getHours()<12?"Good morning. Here's the shape of the day.":new Date().getHours()<17?"A clear plan for the rest of the day.":"Let's bring the day home.";
  $("todayAgenda").innerHTML=tasks.length?tasks.map(t=>`<button type="button" class="agenda-item agenda-task-button" data-agenda-task="${t.id}"><span class="agenda-time">${timeText(t.start)}</span><div class="agenda-stripe" style="--person-color:${personColor((t.assigneeIds||[])[0])}"></div><div><div class="agenda-name">${esc(t.name)}</div><div class="agenda-meta">${esc((t.assigneeIds||[]).map(personName).join(", ")||"Unassigned")}${t.end?" · until "+timeText(t.end):""}</div></div><span class="status-dot ${statusFor(t)}" title="${statusFor(t)}"></span></button>`).join(""):empty("Nothing scheduled yet","Create a task and it will appear here.");
  $("householdMini").innerHTML=state.people.length?state.people.map(p=>`<div class="person-mini"><span class="person-dot" style="--person-color:${p.color}"></span><span class="person-name">${esc(p.name)}</span><span class="person-count">${p.role}</span></div>`).join(""):empty("Add your household","Create member profiles to assign responsibilities.");
  const dinner=state.meals.find(m=>Number(m.day)===new Date().getDay());
  $("dinnerPreview").innerHTML=dinner?`<div class="empty-icon">♨</div><div><strong>${esc(dinner.name)}</strong><div class="agenda-meta">${esc(dinner.notes||"Dinner plan")}</div></div>`:`<div class="empty-icon">♨</div><p>No dinner planned yet.</p>`;
}
function renderTasks() {
  const allTasks=Cloud.getState().tasks;
  const tasks=allTasks.filter(t=>{
    const status=statusFor(t);
    if(taskFilter==="scheduled") return !t.archived;
    if(taskFilter==="completed") return status==="done";
    if(taskFilter==="progress") return status==="progress";
    if(taskFilter==="late") return status==="late";
    if(taskFilter==="active") return !t.archived;
    if(taskFilter==="recurring") return t.repeat!=="once";
    return !t.archived;
  });
  $("taskList").innerHTML=tasks.length?tasks.map(t=>{
    const occ=t.occurrences?.[keyDate()], done=occ?.status==="completed";
    const names=(t.assigneeIds||[]).map(personName).join(", ")||"Unassigned";
    const canEdit=Cloud.canManageTask(t), canComplete=Cloud.canCompleteTask(t);
    const steps=(t.operations||[]).map(o=>`<label class="task-step ${o.completed?"step-done":""}"><input type="checkbox" data-step-task="${t.id}" data-step-id="${o.id}" ${o.completed?"checked":""} ${!canComplete||done?"disabled":""}><span>${esc(o.name)}</span></label>`).join("");
    const required=(t.operations||[]).filter(o=>o.required), allStepsDone=required.length>0&&required.every(o=>o.completed);
    return `<article class="task-card ${done?"task-card-done":""}"><div class="task-row"><button class="task-check ${done?"checked":""}" data-complete="${t.id}" ${!canComplete||done?"disabled":""} aria-label="Complete task">${done?"✓":""}</button><div class="task-main"><div class="task-title">${esc(t.name)}</div><div class="task-detail">${esc(names)} · ${repeatText(t)} · ${(t.operations||[]).length} steps${done?" · Completed"+(occ?.completedByProfileId?" by "+esc(personName(occ.completedByProfileId)):""):""}</div></div><div class="task-time">${timeText(t.start)}</div>${done&&canEdit?`<button class="reopen-task" data-reopen-task="${t.id}">Reopen</button>`:canEdit?`<button class="task-edit" data-edit-task="${t.id}" aria-label="Edit task">⋯</button>`:""}</div>${steps?`<div class="task-steps">${steps}</div>${allStepsDone&&!done?`<p class="steps-hint">All required steps are complete. The task will finish automatically.</p>`:""}`:""}</article>`;
  }).join(""):empty("No tasks here yet","Add a task to begin building your household routine.");
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
  const entries=Cloud.getActivity();
  $("ledgerList").innerHTML=entries.length?entries.map(e=>{
    const detail=e.detail||{};
    const summary=detail.task_name||detail.name||detail.step_name||"";
    return `<div class="ledger-row"><div class="ledger-symbol">↗</div><div class="ledger-text"><strong>${esc(e.action)}</strong>${summary?` · ${esc(summary)}`:""}<div class="ledger-time">${esc(e.actorName||"Household member")} · ${new Date(e.created_at).toLocaleString()}</div></div></div>`;
  }).join(""):empty("Your workspace starts here.","New changes and completed work will appear here as your household uses WIWY.");
}
function addDays(date,amount){const d=new Date(date);d.setDate(d.getDate()+amount);return d;}
function formatMonth(date){return date.toLocaleDateString(undefined,{month:"long",year:"numeric"});}
function tasksForDate(date){
  const key=keyDate(date);
  return Cloud.getState().tasks.filter(t=>!t.archived&&taskOccurs(t,key)).sort((x,y)=>(parseTime(x.start)??9999)-(parseTime(y.start)??9999));
}
function renderCalendar(){
  const key=keyDate(calendarDate);
  document.querySelectorAll("[data-cal-mode]").forEach(b=>b.classList.toggle("selected",b.dataset.calMode===calendarMode));
  $("calendarReturnMonth").hidden=!(calendarMode==="day"&&calendarReturnToMonth);
  if(calendarMode==="month"){
    $("calendarDate").textContent=formatMonth(calendarDate);
    $("calendarGrid").className="calendar-grid month-grid";
    const first=new Date(calendarDate.getFullYear(),calendarDate.getMonth(),1,12), offset=first.getDay(), daysInMonth=new Date(first.getFullYear(),first.getMonth()+1,0).getDate();
    const cells=[];
    for(let i=0;i<offset;i++)cells.push(`<div class="month-empty"></div>`);
    for(let n=1;n<=daysInMonth;n++){
      const d=new Date(first.getFullYear(),first.getMonth(),n,12), k=keyDate(d), tasks=tasksForDate(d), isToday=k===keyDate(), selected=k===key;
      const dots=tasks.slice(0,5).map(t=>`<i style="--person-color:${personColor(t.assigneeIds?.[0])}"></i>`).join("");
      cells.push(`<button class="month-day ${isToday?"is-today":""} ${selected?"is-selected":""}" data-month-date="${k}"><span>${n}</span><small>${tasks.length?tasks.length+" task"+(tasks.length===1?"":"s"):""}</small><div class="month-dots">${dots}</div></button>`);
    }
    $("calendarGrid").innerHTML=`${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=>`<div class="month-weekday">${d}</div>`).join("")}${cells.join("")}`;
    return;
  }
  if(calendarMode==="week"){
    const start=addDays(calendarDate,-calendarDate.getDay()), days=Array.from({length:7},(_,i)=>addDays(start,i));
    $("calendarDate").textContent=`${days[0].toLocaleDateString(undefined,{month:"short",day:"numeric"})} – ${days[6].toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}`;
    $("calendarGrid").className="calendar-grid week-grid";
    $("calendarGrid").innerHTML=days.map(d=>{
      const k=keyDate(d), tasks=tasksForDate(d);
      return `<section class="week-day ${k===keyDate()?"is-today":""}"><button class="week-day-head" data-month-date="${k}"><strong>${shortDays[d.getDay()]}</strong><span>${d.getDate()}</span></button><div class="week-day-tasks">${tasks.length?tasks.map(t=>`<button class="week-task" data-calendar-task="${t.id}" data-task-date="${k}" style="--person-color:${personColor(t.assigneeIds?.[0])}"><strong>${esc(t.name)}</strong><small>${timeText(t.start)}</small></button>`).join(""):`<span class="week-no-tasks">—</span>`}</div></section>`;
    }).join("");
    return;
  }
  $("calendarDate").textContent=dateLabel(calendarDate);
  $("calendarGrid").className="calendar-grid day-grid";
  const tasks=tasksForDate(calendarDate);
  let html="";
  for(let h=6;h<23;h++){
    const label=new Date(2000,0,1,h).toLocaleTimeString([],{hour:"numeric"});
    const items=tasks.filter(t=>Math.floor((parseTime(t.start)??9*60)/60)===h);
    html+=`<div class="time-label">${label}</div><div class="time-slot" data-hour="${h}">${items.map(t=>`<button type="button" class="calendar-event calendar-event-button" data-calendar-task="${t.id}" data-task-date="${key}" style="--person-color:${personColor(t.assigneeIds?.[0])}"><strong>${esc(t.name)}</strong><small>${timeText(t.start)}${t.end?" – "+timeText(t.end):""} · ${esc((t.assigneeIds||[]).map(personName).join(", ")||"Unassigned")}</small></button>`).join("")}</div>`;
  }
  $("calendarGrid").innerHTML=html;
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
function taskEditorSnapshot() {
  return JSON.stringify({
    name:$("taskName").value.trim(),
    assignees:[...document.querySelectorAll("[data-assignee-option]:checked")].map(o=>o.value).sort(),
    repeat:$("taskRepeat").value,
    weekdays:[...selectedDays].sort((x,y)=>x-y),
    start:$("taskStart").value,
    end:$("taskEnd").value,
    notes:$("taskNotes").value.trim(),
    operations:operations.map(o=>({name:o.name,required:o.required!==false}))
  });
}
function taskEditorHasChanges() {
  return taskEditorSnapshot() !== ($("taskEditor").dataset.initialSnapshot || taskEditorSnapshot());
}
function openTask(task=null) {
  populatePeopleSelects(); $("taskEditor").reset(); operations=[]; selectedDays=new Set();
  $("taskId").value=task?.id||""; $("taskDialogTitle").textContent=task?"Edit task":"Create a task";
  $("taskFormError").hidden=true; $("taskFormError").textContent="";
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
  renderOperations();
  renderWeekdays();
  $("taskEditor").dataset.initialSnapshot=taskEditorSnapshot();
  const closeButton=$("closeTaskEditor");
  closeButton.onclick=async(event)=>{
    event.preventDefault();
    event.stopPropagation();
    if(!taskEditorHasChanges()){
      $("taskDialog").close();
      return;
    }
    const confirmed=await askWIWYConfirm(
      "Discard task changes?",
      "Are you sure you want to cancel task creation? Your unsaved information will be lost.",
      "Discard task"
    );
    if(confirmed)$("taskDialog").close();
  };
  $("taskDialog").showModal();
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
  const errorBox=$("taskFormError");errorBox.hidden=true;errorBox.textContent="";
  try { await Cloud.saveTask(task); $("taskDialog").close(); render(); toast("✓ Task created and saved to your household."); return true; }
  catch(error) { errorBox.textContent="Could not save task: "+error.message; errorBox.hidden=false; return false; }
}
function setup() {
  document.querySelectorAll(".nav-item[data-view]").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.view)));
  document.querySelectorAll("[data-go]").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.go)));
  $("todayAgenda").addEventListener("click",e=>{const button=e.target.closest("[data-agenda-task]");if(button)openTaskDetails(Cloud.getState().tasks.find(t=>t.id===button.dataset.agendaTask));});
  $("calendarGrid").addEventListener("click",async e=>{
    const taskButton=e.target.closest("[data-calendar-task]");
    if(taskButton){await openTaskDetails(Cloud.getState().tasks.find(t=>t.id===taskButton.dataset.calendarTask),taskButton.dataset.taskDate||keyDate(calendarDate));return;}
    const dayButton=e.target.closest("[data-month-date]");
    if(dayButton){calendarDate=new Date(dayButton.dataset.monthDate+"T12:00:00");calendarReturnToMonth=calendarMode==="month";calendarMode="day";renderCalendar();}
  });
  $("taskDetailContent").addEventListener("change",async e=>{
    const taskId=e.target.dataset.detailStepTask, operationId=e.target.dataset.detailStepId;
    if(taskId&&operationId){const date=e.target.dataset.detailStepDate||detailDateKey;try{await Cloud.setOperationCompletion(taskId,date,operationId,e.target.checked);render();await openTaskDetails(Cloud.getState().tasks.find(t=>t.id===taskId),date);const t=Cloud.getState().tasks.find(x=>x.id===taskId);if(t?.occurrences?.[date]?.status==="completed")toast("✓ All required steps completed. Task finished.");}catch(error){e.target.checked=!e.target.checked;toast("Could not update step: "+error.message);}}
  });
  $("taskDetailContent").addEventListener("click",async e=>{
    const complete=e.target.closest("[data-detail-complete]"); if(complete)await completeTaskFromDetails(complete.dataset.detailComplete);
    const reopen=e.target.closest("[data-detail-reopen]"); if(reopen&&await askWIWYConfirm("Reopen task?","This will clear the completed steps and return the task to not started.","Reopen task")){try{await Cloud.reopenTask(reopen.dataset.detailReopen,detailDateKey);render();await openTaskDetails(Cloud.getState().tasks.find(t=>t.id===reopen.dataset.detailReopen),detailDateKey);toast("Task reopened.");}catch(error){toast("Could not reopen task: "+error.message);}}
  });
  $("closeTaskDetail").onclick=()=>$("taskDetailDialog").close();
  $("pageBack").onclick=goBack;
  $("quickAddTask").onclick=$("newTaskButton").onclick=()=>openTask();
  $("taskRepeat").onchange=()=>{$("weekdayPicker").hidden=$("taskRepeat").value!=="weekdays";};
  document.querySelectorAll("[data-day]").forEach(b=>b.onclick=()=>{const d=Number(b.dataset.day);selectedDays.has(d)?selectedDays.delete(d):selectedDays.add(d);renderWeekdays();});
  $("addOperation").onclick=()=>{const v=$("newOperation").value.trim();if(v){operations.push({name:v,required:true});$("newOperation").value="";renderOperations();}};
  $("operationEditor").addEventListener("click",e=>{const i=e.target.dataset.opRemove;if(i!==undefined){operations.splice(Number(i),1);renderOperations();}});
  $("operationEditor").addEventListener("change",e=>{if(e.target.dataset.opRequired!==undefined)operations[Number(e.target.dataset.opRequired)].required=e.target.checked;if(e.target.dataset.opName!==undefined)operations[Number(e.target.dataset.opName)].name=e.target.value;});
  // Task editor close is bound when the dialog opens, so it cannot be skipped
  // by any later setup-time event wiring.
  $("taskEditor").addEventListener("submit",e=>{e.preventDefault();saveTaskFromForm();});
  $("deleteTaskButton").onclick=async()=>{const id=$("taskId").value;if(id&&await askWIWYConfirm("Delete task?","This removes the task definition. This action cannot be undone.","Delete task")){try{await Cloud.deleteTask(id);$("taskDialog").close();render();toast("Task deleted.");}catch(error){toast("Could not delete task: "+error.message);}}};
  $("taskList").addEventListener("click",async e=>{
    const edit=e.target.dataset.editTask;if(edit)openTask(Cloud.getState().tasks.find(t=>t.id===edit));
    const complete=e.target.dataset.complete;
    if(complete){const task=Cloud.getState().tasks.find(t=>t.id===complete);try{
      if(task.operations?.length>=2){if(!await askWIWYConfirm("Complete this task?","Are all steps for this task complete? Confirming will mark every step complete.","Complete task"))return;await Cloud.completeAllStepsAndTask(complete,keyDate());}
      else if(task.operations?.length===1){await Cloud.completeAllStepsAndTask(complete,keyDate());}
      else await Cloud.setOccurrence(complete,keyDate(),"completed");
      render();toast("✓ Task completed for everyone.");
    }catch(error){toast("Could not complete task: "+error.message);}}
    const reopen=e.target.dataset.reopenTask;
    if(reopen&&await askWIWYConfirm("Reopen task?","This will clear the completed steps and return the task to not started.","Reopen task")){try{await Cloud.reopenTask(reopen,keyDate());render();toast("Task reopened.");}catch(error){toast("Could not reopen task: "+error.message);}}
  });
  $("taskList").addEventListener("change",async e=>{
    const taskId=e.target.dataset.stepTask, operationId=e.target.dataset.stepId;
    if(taskId&&operationId){try{await Cloud.setOperationCompletion(taskId,keyDate(),operationId,e.target.checked);render();const t=Cloud.getState().tasks.find(x=>x.id===taskId);if(t?.occurrences?.[keyDate()]?.status==="completed")toast("✓ All required steps completed. Task finished.");}catch(error){e.target.checked=!e.target.checked;toast("Could not update step: "+error.message);}}
  });
  document.querySelectorAll("[data-task-filter]").forEach(b=>b.onclick=()=>{taskFilter=b.dataset.taskFilter;document.querySelectorAll("[data-task-filter]").forEach(x=>x.classList.toggle("selected",x===b));renderTasks();});
  document.querySelectorAll("[data-summary-filter]").forEach(card=>{card.setAttribute("role","button");card.setAttribute("tabindex","0");card.setAttribute("aria-label","Show "+card.dataset.summaryFilter+" tasks");const activate=()=>{taskFilter=card.dataset.summaryFilter;setView("tasks");document.querySelectorAll("[data-task-filter]").forEach(x=>x.classList.toggle("selected",x.dataset.taskFilter===taskFilter));renderTasks();};card.addEventListener("click",activate);card.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();activate();}});});
  $("addPersonButton").onclick=()=>{$("personEditor").reset();$("personFormError").hidden=true;$("personFormError").textContent="";$("personDialog").showModal();};
  $("personEditor").addEventListener("submit",async e=>{e.preventDefault();const name=$("personName").value.trim();if(name){const errorBox=$("personFormError");errorBox.hidden=true;errorBox.textContent="";try{await Cloud.addPerson({name,color:$("personColor").value});$("personDialog").close();populatePeopleSelects();render();toast("✓ Household member added.");}catch(error){errorBox.textContent="Could not add person: "+error.message;errorBox.hidden=false;}}});
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
      if (!await askWIWYConfirm("Sign out?","Sign out of WIWY on this device?","Sign out")) return;
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
  document.querySelectorAll("[data-cal-mode]").forEach(b=>b.onclick=()=>{calendarMode=b.dataset.calMode;calendarReturnToMonth=false;renderCalendar();});
  $("prevDay").onclick=()=>{if(calendarMode==="day")calendarDate=addDays(calendarDate,-1);else if(calendarMode==="week")calendarDate=addDays(calendarDate,-7);else{const day=calendarDate.getDate();calendarDate.setDate(1);calendarDate.setMonth(calendarDate.getMonth()-1);calendarDate.setDate(Math.min(day,new Date(calendarDate.getFullYear(),calendarDate.getMonth()+1,0).getDate()));}renderCalendar();};
  $("nextDay").onclick=()=>{if(calendarMode==="day")calendarDate=addDays(calendarDate,1);else if(calendarMode==="week")calendarDate=addDays(calendarDate,7);else{const day=calendarDate.getDate();calendarDate.setDate(1);calendarDate.setMonth(calendarDate.getMonth()+1);calendarDate.setDate(Math.min(day,new Date(calendarDate.getFullYear(),calendarDate.getMonth()+1,0).getDate()));}renderCalendar();};
  $("calendarReturnMonth").onclick=()=>{calendarMode="month";calendarReturnToMonth=false;renderCalendar();};
  $("calendarToday").onclick=()=>{calendarDate=new Date();calendarDate.setHours(12,0,0,0);calendarMode="day";calendarReturnToMonth=false;renderCalendar();};
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
