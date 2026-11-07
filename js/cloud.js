// WIWY cloud-first task and member data layer.
let client = null;
let workspace = null;
let membership = null;
let user = null;
let state = { people: [], tasks: [] };
let permissions = new Set();
let channel = null;
let refreshBusy = false;
let refreshTimer = null;

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};
const dateOccurs = (task, date) => {
  const r = task.recurrence || { type: "once" };
  if (r.type === "daily") return true;
  if (r.type === "weekdays") {
    const day = new Date(`${date}T12:00:00`).getDay();
    return (r.weekdays || []).includes(day);
  }
  return r.date === date;
};
const mapTask = (row, ops, assignments, occurrences) => {
  const r = row.recurrence || { type: "once" };
  const assigneeIds = assignments.filter(a => a.task_id === row.id).map(a => a.member_profile_id);
  const occurrence = occurrences.find(o => o.task_id === row.id);
  return {
    id: row.id, name: row.name, assigneeId: assigneeIds[0] || row.assignee_profile_id || null,
    assigneeIds, repeat: r.type || "once", weekdays: r.weekdays || [],
    date: r.date || null, start: row.start_time || null, end: row.end_time || null,
    notes: row.notes || "", archived: Boolean(row.archived_at),
    createdBy: row.created_by, createdAt: row.created_at,
    operations: ops.filter(o => o.task_id === row.id)
      .sort((a,b) => a.sort_order - b.sort_order)
      .map(o => ({ id:o.id, name:o.label, required:o.is_required,
        completed:Boolean(o.completion?.completed_at), completedAt:o.completion?.completed_at })),
    occurrences: occurrence ? {
      [occurrence.occurrence_date]: {
        id: occurrence.id,
        status: occurrence.status === "in_progress" ? "progress" : occurrence.status,
        completedAt: occurrence.completed_at, completedBy: occurrence.completed_by,
        completedByProfileId: occurrence.completed_by_profile_id
      }
    } : {}
  };
};

export function getState() { return structuredClone(state); }
export function getCurrentUser() { return user; }
export function getMembership() { return membership; }
export function isAdmin() { return membership?.role === "Admin"; }
export function canManageTask(task) {
  return Boolean(task && (task.createdBy === user?.id || isAdmin() ||
    (membership?.role === "Manager" && permissions.has("tasks.manage_all"))));
}
export function canAssignAnyone() {
  return isAdmin() || (membership?.role === "Manager" && permissions.has("tasks.assign_anyone"));
}
export function canManageProfiles() {
  return isAdmin() || (membership?.role === "Manager" && permissions.has("members.manage"));
}
export function isAssignedToCurrentUser(task) {
  return Boolean(membership?.member_profile_id &&
    (task?.assigneeIds || []).includes(membership.member_profile_id));
}
export function canCompleteTask(task) {
  return isAssignedToCurrentUser(task) || isAdmin() ||
    (membership?.role === "Manager" && permissions.has("tasks.manage_all"));
}
export async function initialize(authClient, activeWorkspace, activeMembership, signedInUser) {
  client = authClient; workspace = activeWorkspace; membership = activeMembership; user = signedInUser;
  const { data: grants, error: grantError } = await client
    .from("workspace_member_permissions")
    .select("permission_key")
    .eq("workspace_id", workspace.id)
    .eq("user_id", user.id);
  if (grantError) throw grantError;
  permissions = new Set((grants || []).map(x => x.permission_key));
  await refresh();
  if (channel) client.removeChannel(channel);
  channel = client.channel(`wiwy-workspace-${workspace.id}`)
    .on("postgres_changes", { event:"*", schema:"public", table:"tasks", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"member_profiles", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"task_occurrences", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"task_assignments" }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"task_operations" }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"task_operation_completions", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
    .subscribe();
  // Polling is a fallback if Realtime is not enabled for these tables.
  refreshTimer = setInterval(() => refreshQuietly(), 20000);
  return getState();
}
async function refreshQuietly() {
  if (refreshBusy) return;
  try { await refresh(); document.dispatchEvent(new CustomEvent("wiwy-cloud-updated")); }
  catch (e) { console.warn("WIWY background refresh:", e); }
}
export async function refresh() {
  if (!client || !workspace) throw new Error("WIWY cloud connection is not initialized.");
  if (refreshBusy) return getState();
  refreshBusy = true;
  try {
    const [peopleRes, taskRes] = await Promise.all([
      client.from("member_profiles").select("id,workspace_id,display_name,color,created_at").eq("workspace_id", workspace.id).order("created_at"),
      client.from("tasks").select("id,workspace_id,name,assignee_profile_id,recurrence,start_time,end_time,notes,archived_at,created_by,created_at,updated_at").eq("workspace_id", workspace.id).order("created_at", {ascending:false})
    ]);
    if (peopleRes.error) throw peopleRes.error;
    if (taskRes.error) throw taskRes.error;
    const taskRows = taskRes.data || [];
    const activeToday = taskRows.filter(t => !t.archived_at && dateOccurs(t, todayKey()));
    for (const task of activeToday) {
      const { error } = await client.rpc("ensure_task_occurrence", {
        target_task: task.id, target_date: todayKey()
      });
      if (error) throw error;
    }
    const taskIds = taskRows.map(t => t.id);
    let ops = [], assignments = [], occurrences = [], completions = [];
    if (taskIds.length) {
      const [opRes, assignRes, occRes] = await Promise.all([
        client.from("task_operations").select("id,task_id,label,sort_order,is_required").in("task_id", taskIds),
        client.from("task_assignments").select("task_id,member_profile_id").in("task_id", taskIds),
        client.from("task_occurrences").select("id,task_id,occurrence_date,status,completed_at,completed_by,completed_by_profile_id").eq("workspace_id", workspace.id).eq("occurrence_date", todayKey()).in("task_id", taskIds)
      ]);
      if (opRes.error) throw opRes.error;
      if (assignRes.error) throw assignRes.error;
      if (occRes.error) throw occRes.error;
      ops = opRes.data || []; assignments = assignRes.data || []; occurrences = occRes.data || [];
      const occurrenceIds = occurrences.map(o => o.id);
      if (occurrenceIds.length) {
        const completionRes = await client.from("task_operation_completions")
          .select("id,occurrence_id,operation_id,completed_at,completed_by")
          .in("occurrence_id", occurrenceIds);
        if (completionRes.error) throw completionRes.error;
        completions = completionRes.data || [];
      }
    }
    const opsWithCompletion = ops.map(op => ({...op, completion:completions.find(x => x.operation_id === op.id && occurrences.some(o => o.id === x.occurrence_id)) || null}));
    state = {
      people: (peopleRes.data || []).map(p => ({id:p.id,name:p.display_name,color:p.color,role:"Household member",accountId:null})),
      tasks: taskRows.map(t => mapTask(t, opsWithCompletion, assignments, occurrences))
    };
    return getState();
  } finally { refreshBusy = false; }
}
export async function addPerson(person) {
  if (!canManageProfiles()) throw new Error("You don't have permission to add household profiles.");
  const { data, error } = await client.from("member_profiles").insert({
    workspace_id: workspace.id, display_name: person.name.trim(), color: person.color || "#789a80"
  }).select("id,display_name,color,created_at").single();
  if (error) throw error;
  await refresh();
  return data;
}
function taskPayload(task) {
  const recurrence = task.repeat === "daily" ? {type:"daily"}
    : task.repeat === "weekdays" ? {type:"weekdays",weekdays:task.weekdays || []}
    : {type:"once",date:task.date || todayKey()};
  return {
    workspace_id: workspace.id, name: task.name.trim(),
    assignee_profile_id: (task.assigneeIds || []).length ? task.assigneeIds[0] : null,
    recurrence, start_time: task.start || null, end_time: task.end || null,
    notes: task.notes || "", updated_at: new Date().toISOString()
  };
}
async function replaceChildren(taskId, task, assigneeIds) {
  const { error: delOpsError } = await client.from("task_operations").delete().eq("task_id", taskId);
  if (delOpsError) throw delOpsError;
  const ops = (task.operations || []).filter(o => String(o.name || "").trim()).map((o,i) => ({
    workspace_id: workspace.id,
    task_id:taskId,
    label:String(o.name).trim(),
    sort_order:i,
    is_required:o.required !== false
  }));
  if (ops.length) {
    const { error } = await client.from("task_operations").insert(ops);
    if (error) throw error;
  }
  const { error: delAssignError } = await client.from("task_assignments").delete().eq("task_id", taskId);
  if (delAssignError) throw delAssignError;
  const uniqueIds = [...new Set((assigneeIds || []).filter(Boolean))];
  if (uniqueIds.length) {
    const { error } = await client.from("task_assignments").insert(uniqueIds.map(member_profile_id => ({task_id:taskId,member_profile_id})));
    if (error) throw error;
  }
}
export async function saveTask(task) {
  const ids = task.assigneeIds || (task.assigneeId ? [task.assigneeId] : []);
  if (!task.name?.trim()) throw new Error("Task name is required.");
  if (!task.id && !isAdmin() && !canAssignAnyone()) {
    if (!membership?.member_profile_id) throw new Error("Your account is not linked to a household profile yet.");
    if (ids.some(id => id !== membership.member_profile_id)) throw new Error("Members can create tasks assigned only to themselves.");
  }
  if (task.id) {
    const existing = state.tasks.find(t => t.id === task.id);
    if (!canManageTask(existing)) throw new Error("You can only edit tasks you created. A Manager or Admin can edit other tasks.");
    const { error } = await client.from("tasks").update(taskPayload({...task,assigneeIds:ids})).eq("id", task.id);
    if (error) throw error;
    await replaceChildren(task.id, task, ids);
  } else {
    const payload = {...taskPayload({...task,assigneeIds:ids}),created_by:user.id};
    const { data, error } = await client.from("tasks").insert(payload).select("id").single();
    if (error) throw error;
    try { await replaceChildren(data.id, task, ids); }
    catch (e) {
      await client.from("tasks").delete().eq("id", data.id);
      throw e;
    }
  }
  await refresh();
}
export async function deleteTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!canManageTask(task)) throw new Error("You can only delete tasks you created. A Manager or Admin can delete other tasks.");
  const { error } = await client.from("tasks").delete().eq("id", id);
  if (error) throw error;
  await refresh();
}
export async function setOccurrence(taskId, dateKey, status) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || !(canCompleteTask(task) || (status === "not_started" && canManageTask(task)))) throw new Error("You must be assigned to this task to change its progress.");
  const { error } = await client.rpc("set_task_occurrence_status", {
    target_task: taskId, target_date: dateKey, new_status: status
  });
  if (error) throw error;
  await refresh();
}
export async function setOperationCompletion(taskId, dateKey, operationId, completed) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || !canCompleteTask(task)) throw new Error("You must be assigned to this task to update its steps.");
  const occurrenceId = task.occurrences?.[dateKey]?.id;
  if (!occurrenceId) throw new Error("The task occurrence has not been created yet. Refresh and try again.");
  if (task.occurrences?.[dateKey]?.status === "completed" && !canManageTask(task))
    throw new Error("This task is already completed. Ask its creator or a Manager/Admin to reopen it before changing steps.");
  if (completed) {
    const { error } = await client.from("task_operation_completions").upsert({
      workspace_id:workspace.id, occurrence_id:occurrenceId, operation_id:operationId,
      completed_at:new Date().toISOString(), completed_by:user.id
    }, {onConflict:"occurrence_id,operation_id"});
    if (error) throw error;
  } else {
    const { error } = await client.from("task_operation_completions").delete()
      .eq("occurrence_id", occurrenceId).eq("operation_id", operationId);
    if (error) throw error;
  }
  await refresh();
  const updated = state.tasks.find(t => t.id === taskId);
  const required = (updated?.operations || []).filter(o => o.required);
  if (required.length && required.every(o => o.completed) && updated.occurrences?.[dateKey]?.status !== "completed") {
    await setOccurrence(taskId, dateKey, "completed");
  } else if (completed && updated.occurrences?.[dateKey]?.status === "not_started") {
    await setOccurrence(taskId, dateKey, "in_progress");
  }
  await refresh();
}
export async function completeAllStepsAndTask(taskId, dateKey) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || !canCompleteTask(task)) throw new Error("You must be assigned to this task to complete it.");
  const occurrenceId = task.occurrences?.[dateKey]?.id;
  if (!occurrenceId) throw new Error("The task occurrence has not been created yet. Refresh and try again.");
  const rows = (task.operations || []).map(o => ({workspace_id:workspace.id,occurrence_id:occurrenceId,operation_id:o.id,completed_at:new Date().toISOString(),completed_by:user.id}));
  if (rows.length) {
    const { error } = await client.from("task_operation_completions").upsert(rows,{onConflict:"occurrence_id,operation_id"});
    if (error) throw error;
  }
  await setOccurrence(taskId,dateKey,"completed");
}
export async function reopenTask(taskId, dateKey) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || !canManageTask(task)) throw new Error("Only the task creator or an authorized Manager/Admin can reopen this task.");
  const occurrenceId = task.occurrences?.[dateKey]?.id;
  if (!occurrenceId) throw new Error("The task occurrence could not be found.");
  const { error } = await client.from("task_operation_completions").delete().eq("occurrence_id",occurrenceId);
  if (error) throw error;
  await setOccurrence(taskId,dateKey,"not_started");
}
export function destroy() {
  if (channel && client) client.removeChannel(channel);
  channel = null;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}
