// WIWY cloud-first task and member data layer.
let client = null;
let workspace = null;
let membership = null;
let user = null;
let state = { people: [], tasks: [], meals: [], groceries: [] };
let activity = [];
let awayPeriods = [];
let notifications = [];
let removalRequests = [];
let householdSettings = { observance_preferences:{federal:true,catholic:true,family:true,civic:true,items:{}}, custom_observances:[], reminder_rules:[] };
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
const mapTask = (row, ops, assignments, occurrences, completions) => {
  const r = row.recurrence || { type: "once" };
  const assigneeIds = assignments.filter(a => a.task_id === row.id).map(a => a.member_profile_id);
  const taskOccurrences = occurrences.filter(o => o.task_id === row.id);
  const occurrenceMap = Object.fromEntries(taskOccurrences.map(o => [o.occurrence_date, {
    id:o.id, status:o.status === "in_progress" ? "progress" : o.status,
    completedAt:o.completed_at, completedBy:o.completed_by,
    completedByProfileId:o.completed_by_profile_id
  }]));
  return {
    id: row.id, name: row.name, linkedMealId: row.linked_meal_id || null, assigneeId: assigneeIds[0] || row.assignee_profile_id || null,
    assigneeIds, repeat: r.type || "once", weekdays: r.weekdays || [],
    date: r.date || null, start: row.start_time || null, end: row.end_time || null,
    notes: row.notes || "", archived: Boolean(row.archived_at),
    advanceReminderOffsets: row.advance_reminder_offsets || [], completionPushEnabled: !!row.completion_push_enabled,
    createdBy: row.created_by, createdAt: row.created_at,
    operations: ops.filter(o => o.task_id === row.id)
      .sort((a,b) => a.sort_order - b.sort_order)
      .map(o => {
        const completedDates = {};
        for (const occurrence of taskOccurrences) {
          if (completions.some(x => x.operation_id === o.id && x.occurrence_id === occurrence.id))
            completedDates[occurrence.occurrence_date] = true;
        }
        return {id:o.id,name:o.label,required:o.is_required,completed:!!completedDates[todayKey()],completedDates};
      }),
    occurrences: occurrenceMap
  };
};

export function getState() { return structuredClone(state); }
export function getActivity() { return structuredClone(activity); }
export function getAwayPeriods() { return structuredClone(awayPeriods); }
export function getNotifications() { return structuredClone(notifications); }
export function getHouseholdSettings() { return structuredClone(householdSettings); }
export async function saveHouseholdSettings(patch) {
  if (!client || !workspace) throw new Error("WIWY cloud connection is not initialized.");
  if (!(isAdmin() || membership?.role === "Manager")) throw new Error("Only a household Admin or Manager can change shared calendar settings.");
  const next = { observance_preferences:patch.observance_preferences ?? householdSettings.observance_preferences, custom_observances:patch.custom_observances ?? householdSettings.custom_observances, workspace_id:workspace.id, updated_by:user?.id || null, updated_at:new Date().toISOString() };
  const { data, error } = await client.from("wiwy_household_settings").upsert(next,{onConflict:"workspace_id"}).select("observance_preferences,custom_observances").single();
  if (error) throw error;
  householdSettings = { ...householdSettings, ...data };
  document.dispatchEvent(new CustomEvent("wiwy-cloud-updated"));
  return getHouseholdSettings();
}
export function getRemovalRequests() { return structuredClone(removalRequests); }
export async function saveReminderRule(ruleId, patch) {
  if (!client || !workspace) throw new Error("WIWY cloud connection is not initialized.");
  if (!(isAdmin() || membership?.role === "Manager")) throw new Error("Only a household Admin or Manager can change reminder rules.");
  const allowed = { offsets_minutes:patch.offsets_minutes, note:patch.note, recipient_profile_ids:patch.recipient_profile_ids, enabled:patch.enabled };
  const { error } = await client.from("wiwy_reminder_rules").update(allowed).eq("id",ruleId).eq("workspace_id",workspace.id);
  if (error) throw error;
  await refresh();
  document.dispatchEvent(new CustomEvent("wiwy-cloud-updated"));
}
export async function deleteReminderRule(ruleId) {
  if (!client || !workspace) throw new Error("WIWY cloud connection is not initialized.");
  if (!(isAdmin() || membership?.role === "Manager")) throw new Error("Only a household Admin or Manager can delete reminder rules.");
  const { error } = await client.from("wiwy_reminder_rules").delete().eq("id",ruleId).eq("workspace_id",workspace.id);
  if (error) throw error;
  await refresh();
  document.dispatchEvent(new CustomEvent("wiwy-cloud-updated"));
}
export async function markNotificationRead(id) {
  const { error } = await client.from("notifications").update({read_at:new Date().toISOString()}).eq("id",id);
  if (error) throw error;
  const row = notifications.find(n=>n.id===id); if (row) row.read_at = new Date().toISOString();
}
export function canManageAway() { return isAdmin() || membership?.role === "Manager"; }
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
async function recordActivity(action, entityType, entityId, detail={}) {
  try {
    const { error } = await client.from("activity_ledger").insert({
      workspace_id: workspace.id,
      actor_user_id: user?.id || null,
      actor_profile_id: membership?.member_profile_id || null,
      action, entity_type: entityType, entity_id: entityId,
      detail
    });
    if (error) console.warn("WIWY activity record was not saved:", error);
  } catch (error) {
    console.warn("WIWY activity record was not saved:", error);
  }
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
    .on("postgres_changes", { event:"*", schema:"public", table:"meals", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"grocery_items", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"member_profiles", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"profile_removal_requests", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"task_occurrences", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"task_assignments" }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"task_operations" }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"task_operation_completions", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"activity_ledger", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"away_periods", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"notifications", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"wiwy_household_settings", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
    .on("postgres_changes", { event:"*", schema:"public", table:"wiwy_reminder_rules", filter:`workspace_id=eq.${workspace.id}` }, () => refreshQuietly())
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
    // Members do not have removal-request read permission; do not query that table for them.
    const requestQuery = (membership?.role === "Admin" || membership?.role === "Manager")
      ? client.from("profile_removal_requests").select("id,workspace_id,profile_id,requested_by,status,requested_at,reviewed_by,reviewed_at,review_note").eq("workspace_id", workspace.id).eq("status", "pending").order("requested_at", {ascending:true})
      : Promise.resolve({ data: [], error: null });
    const [peopleRes, taskRes, activityRes, awayRes, notificationRes, requestRes, mealsRes, groceriesRes, membershipsRes, settingsRes, rulesRes] = await Promise.all([
      client.from("member_profiles").select("id,workspace_id,display_name,color,birth_date,is_active,created_at").eq("workspace_id", workspace.id).order("created_at"),
      client.from("tasks").select("id,workspace_id,name,assignee_profile_id,linked_meal_id,recurrence,start_time,end_time,notes,archived_at,created_by,created_at,updated_at,advance_reminder_offsets,completion_push_enabled").eq("workspace_id", workspace.id).order("created_at", {ascending:false}),
      client.from("activity_ledger").select("id,workspace_id,actor_user_id,actor_profile_id,action,entity_type,entity_id,detail,created_at").eq("workspace_id", workspace.id).order("created_at", {ascending:false}).limit(100),
      client.from("away_periods").select("id,workspace_id,member_profile_id,starts_at,ends_at,is_active,created_by").eq("workspace_id", workspace.id).eq("is_active", true).order("starts_at", {ascending:false}),
      client.from("notifications").select("id,notification_type,title,body,task_id,occurrence_id,occurrence_date,push_requested,created_at,read_at,event_key").eq("workspace_id", workspace.id).order("created_at", {ascending:false}).limit(100),
      requestQuery,
      client.from("meals").select("id,workspace_id,meal_date,meal_type,name,notes,recipe,created_by,created_at").eq("workspace_id", workspace.id).order("meal_date"),
      client.from("grocery_items").select("id,workspace_id,name,category,quantity,notes,is_completed,linked_meal_id,added_by,created_at").eq("workspace_id", workspace.id).order("created_at", {ascending:true}),
      client.from("workspace_memberships").select("member_profile_id,user_id,role").eq("workspace_id", workspace.id),
      client.from("wiwy_household_settings").select("observance_preferences,custom_observances").eq("workspace_id",workspace.id).maybeSingle(),
      client.from("wiwy_reminder_rules").select("id,event_type,event_key,offsets_minutes,note,recipient_profile_ids,enabled,created_at,updated_at").eq("workspace_id",workspace.id).order("created_at")
    ]);
    if (peopleRes.error) throw peopleRes.error;
    if (settingsRes.error) throw settingsRes.error;
    if (rulesRes.error) throw rulesRes.error;
    householdSettings = { observance_preferences:{federal:true,catholic:true,family:true,civic:true,items:{}}, custom_observances:[], reminder_rules:[], ...(settingsRes.data||{}), reminder_rules:rulesRes.data||[] };
    if (taskRes.error) throw taskRes.error;
    if (activityRes.error) throw activityRes.error;
    if (awayRes.error) throw awayRes.error;
    if (notificationRes.error) throw notificationRes.error;
    if (requestRes.error) throw requestRes.error;
    if (mealsRes.error) throw mealsRes.error;
    if (groceriesRes.error) throw groceriesRes.error;
    if (membershipsRes.error) throw membershipsRes.error;
    notifications = notificationRes.data || [];
    removalRequests = requestRes.data || [];

    awayPeriods = (awayRes.data || []).filter(p => !p.ends_at || new Date(p.ends_at) > new Date());
    const profileNames = new Map((peopleRes.data || []).map(p => [p.id,p.display_name]));
    activity = (activityRes.data || []).map(row => ({
      ...row,
      actorName: row.detail?.actor_display_name || (row.actor_profile_id ? (profileNames.get(row.actor_profile_id) || "Household member") : "Household member")
    }));
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
        client.from("task_occurrences").select("id,task_id,occurrence_date,status,completed_at,completed_by,completed_by_profile_id").eq("workspace_id", workspace.id).in("task_id", taskIds)
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
    const linkedByProfile = new Map((membershipsRes.data || []).filter(m=>m.member_profile_id).map(m=>[m.member_profile_id,m]));
    state = {
      people: (peopleRes.data || []).map(p => { const linked=linkedByProfile.get(p.id); return {id:p.id,name:p.display_name,color:p.color,birthDate:p.birth_date||null,active:p.is_active !== false,role:linked?.role || "Household member",accountRole:linked?.role || null,accountId:linked?.user_id || null,accountUserId:linked?.user_id || null}; }),
      tasks: taskRows.map(t => mapTask(t, ops, assignments, occurrences, completions)),
      meals: (mealsRes.data || []).map(m => ({id:m.id,date:m.meal_date,type:m.meal_type,name:m.name,notes:m.notes || "",recipe:m.recipe || {},createdAt:m.created_at})),
      groceries: (groceriesRes.data || []).map(g => ({id:g.id,name:g.name,category:g.category,quantity:g.quantity || "",notes:g.notes || "",done:!!g.is_completed,linkedMealId:g.linked_meal_id || null,createdAt:g.created_at}))
    };
    return getState();
  } finally { refreshBusy = false; }
}
export async function requestProfileRemoval(profileId) {
  if (membership?.role !== "Manager") throw new Error("Only a household Manager may request profile removal.");
  const { error } = await client.rpc("wiwy_request_profile_removal", { target_profile: profileId });
  if (error) throw error;
  await recordActivity("Requested household member removal", "member_profile", profileId, {});
  await refresh();
}
export async function setProfileActive(profileId, active) {
  if (!isAdmin()) throw new Error("Only this household's Admin can change profile activation.");
  const rpc = active ? "wiwy_admin_reactivate_profile" : "wiwy_admin_deactivate_profile";
  const { error } = await client.rpc(rpc, { target_profile: profileId });
  if (error) throw error;
  await recordActivity(active ? "Reactivated household member" : "Deactivated household member", "member_profile", profileId, {});
  await refresh();
}
export async function reviewProfileRemoval(requestId, approve) {
  if (!isAdmin()) throw new Error("Only this household's Admin can review removal requests.");
  const { error } = await client.rpc("wiwy_admin_review_profile_removal", {
    target_request: requestId, approve: !!approve, decision_note: null
  });
  if (error) throw error;
  await recordActivity(approve ? "Approved household member removal" : "Declined household member removal", "profile_removal_request", requestId, {});
  await refresh();
}

export async function addPerson(person) {
  if (!canManageProfiles()) throw new Error("You don't have permission to add household profiles.");
  const { data, error } = await client.from("member_profiles").insert({
    workspace_id: workspace.id, display_name: person.name.trim(), color: person.color || "#789a80"
  }).select("id,display_name,color,created_at").single();
  if (error) throw error;
  await recordActivity("Added a household member", "member_profile", data.id, {name:data.display_name});
  await refresh();
  return data;
}
export async function saveMeal(meal) {
  if (!meal.name?.trim()) throw new Error("A meal name is required.");
  const payload = {workspace_id:workspace.id,meal_date:meal.date,meal_type:meal.type,name:meal.name.trim(),notes:meal.notes || ""};
  const result = meal.id
    ? await client.from("meals").update(payload).eq("id",meal.id).select("id").single()
    : await client.from("meals").insert({...payload,recipe:{},created_by:user?.id || null}).select("id").single();
  if (result.error) throw result.error;
  await recordActivity(meal.id ? "Updated a meal" : "Added a meal", "meal", result.data.id, {meal_name:meal.name.trim()});
  await refresh();
  return result.data.id;
}
export async function deleteMeal(id) {
  const {error}=await client.from("meals").delete().eq("id",id).eq("workspace_id",workspace.id);
  if(error) throw error;
  await recordActivity("Removed a meal", "meal", id, {});
  await refresh();
}
export async function saveGrocery(item) {
  if(!item.name?.trim()) throw new Error("Enter an item name.");
  const payload={workspace_id:workspace.id,name:item.name.trim(),category:item.category||"General",quantity:item.quantity?.trim()||"1",notes:item.notes?.trim()||"",is_completed:false,added_by:user?.id||null};
  const {error}=await client.from("grocery_items").insert(payload);
  if(error) throw error;
  await recordActivity("Added a shopping item","grocery_item",null,{name:payload.name});
  await refresh();
}
export async function updateGrocery(id,item) {
  if(!item.name?.trim()) throw new Error("Enter an item name.");
  const {error}=await client.from("grocery_items").update({name:item.name.trim(),quantity:item.quantity?.trim()||"1",category:item.category||"General",notes:item.notes?.trim()||""}).eq("id",id).eq("workspace_id",workspace.id);
  if(error) throw error;
  await refresh();
}
export async function toggleGrocery(id,completed) {
  const {error}=await client.from("grocery_items").update({is_completed:!!completed}).eq("id",id).eq("workspace_id",workspace.id);
  if(error) throw error; await refresh();
}
export async function deleteGrocery(id) {
  const {error}=await client.from("grocery_items").delete().eq("id",id).eq("workspace_id",workspace.id);
  if(error) throw error; await refresh();
}
export async function clearCompletedGroceries() {
  const {error}=await client.from("grocery_items").delete().eq("workspace_id",workspace.id).eq("is_completed",true);
  if(error) throw error; await refresh();
}
export async function permanentlyDeleteProfile(profileId,removeHouseholdAccess=false) {
  if(!isAdmin()) throw new Error("Only a household Admin can permanently delete a member profile.");
  const {error}=await client.rpc("wiwy_admin_delete_profile",{target_profile:profileId,p_remove_household_access:!!removeHouseholdAccess});
  if(error) throw error; await refresh();
}
export async function removeHouseholdAccess(profileId) {
  if(!isAdmin()) throw new Error("Only a household Admin can remove household login access.");
  const {error}=await client.rpc("wiwy_admin_remove_household_access",{target_profile:profileId});
  if(error) throw error; await refresh();
}

function taskPayload(task) {
  const recurrence = task.repeat === "daily" ? {type:"daily"}
    : task.repeat === "weekdays" ? {type:"weekdays",weekdays:task.weekdays || []}
    : {type:"once",date:task.date || todayKey()};
  return {
    workspace_id: workspace.id, name: task.name.trim(),
    linked_meal_id: task.linkedMealId || null,
    assignee_profile_id: (task.assigneeIds || []).length ? task.assigneeIds[0] : null,
    recurrence, start_time: task.start || null, end_time: task.end || null,
    notes: task.notes || "",
    advance_reminder_offsets: task.advanceReminderOffsets || [],
    completion_push_enabled: !!task.completionPushEnabled,
    updated_at: new Date().toISOString()
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
  let savedTaskId = task.id || null;
  if (task.id) {
    const existing = state.tasks.find(t => t.id === task.id);
    if (!canManageTask(existing)) throw new Error("You can only edit tasks you created. A Manager or Admin can edit other tasks.");
    const { error } = await client.from("tasks").update(taskPayload({...task,assigneeIds:ids})).eq("id", task.id);
    if (error) throw error;
    await replaceChildren(task.id, task, ids);
    await recordActivity("Updated a task", "task", task.id, {task_name:task.name});
  } else {
    const payload = {...taskPayload({...task,assigneeIds:ids}),created_by:user.id};
    const { data, error } = await client.from("tasks").insert(payload).select("id").single();
    if (error) throw error;
    savedTaskId = data.id;
    try { await replaceChildren(data.id, task, ids); }
    catch (e) {
      await client.from("tasks").delete().eq("id", data.id);
      throw e;
    }
    await recordActivity("Created a task", "task", data.id, {task_name:task.name});
  }
  await refresh();
  return savedTaskId;
}
export async function deleteTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!canManageTask(task)) throw new Error("You can only delete tasks you created. A Manager or Admin can delete other tasks.");
  const { error } = await client.from("tasks").delete().eq("id", id);
  if (error) throw error;
  await recordActivity("Deleted a task", "task", id, {task_name:task?.name || "Task"});
  await refresh();
}
export async function ensureOccurrence(taskId, dateKey) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || !dateOccurs({recurrence:{type:task.repeat,weekdays:task.weekdays,date:task.date}}, dateKey))
    throw new Error("This task is not scheduled for that date.");
  const { error } = await client.rpc("ensure_task_occurrence", {target_task:taskId,target_date:dateKey});
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
  const operation = (task.operations || []).find(o => o.id === operationId);
  await recordActivity(completed ? "Completed a task step" : "Reopened a task step", "task_operation", operationId, {task_id:taskId,task_name:task.name,step_name:operation?.name || "Step",date:dateKey});
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


function tomorrowAtFiveInWorkspaceTimezone() {
  const zone = workspace?.timezone || "America/Chicago";
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone:zone, year:"numeric", month:"2-digit", day:"2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(p=>[p.type,p.value]));
  const localTomorrow = new Date(Date.UTC(Number(values.year),Number(values.month)-1,Number(values.day)+1,5,0,0));
  // Convert the intended workspace-local 05:00 to UTC, accounting for DST.
  const getOffset = date => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone:zone, year:"numeric",month:"2-digit",day:"2-digit",
      hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"
    }).formatToParts(date).map(x=>[x.type,x.value]));
    return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-date.getTime();
  };
  let target = new Date(localTomorrow.getTime()-getOffset(localTomorrow));
  target = new Date(localTomorrow.getTime()-getOffset(target));
  return target.toISOString();
}
export async function enableAway({scope, memberProfileId, duration}) {
  if (!canManageAway()) throw new Error("Only a Manager or Admin can manage Away Mode.");
  if (scope === "person" && !memberProfileId) throw new Error("Choose a household member.");
  const duplicate=awayPeriods.some(p=>scope==="workspace"
    ? p.member_profile_id===null
    : p.member_profile_id===memberProfileId);
  if(duplicate) throw new Error(scope==="workspace"
    ? "Away Mode is already active for the entire household."
    : "Away Mode is already active for this person.");
  const endsAt = duration === "indefinite" ? null : tomorrowAtFiveInWorkspaceTimezone();
  const {error} = await client.from("away_periods").insert({
    workspace_id:workspace.id,
    member_profile_id:scope === "person" ? memberProfileId : null,
    starts_at:new Date().toISOString(), ends_at:endsAt, is_active:true, created_by:user.id
  });
  if(error) throw error;
  await recordActivity("Enabled Away Mode","away_period",null,{
    scope, member_profile_id:memberProfileId || null, ends_at:endsAt
  });
  await refresh();
  document.dispatchEvent(new CustomEvent("wiwy-cloud-updated"));
}
export async function disableAway({periodId}={}) {
  if (!canManageAway()) throw new Error("Only a Manager or Admin can manage Away Mode.");
  if (!periodId) throw new Error("Choose an active Away Mode period to turn off.");
  const period=awayPeriods.find(p=>p.id===periodId);
  if (!period) throw new Error("That Away Mode period is no longer active. Refresh and try again.");
  const {error}=await client.from("away_periods").update({is_active:false})
    .eq("id",periodId).eq("workspace_id",workspace.id).eq("is_active",true);
  if(error) throw error;
  await recordActivity("Turned off Away Mode","away_period",null,{
    scope:period.member_profile_id?"person":"workspace",
    member_profile_id:period.member_profile_id || null,
    period_id:periodId
  });
  await refresh();
  document.dispatchEvent(new CustomEvent("wiwy-cloud-updated"));
}

// Export a complete, portable cloud backup. The RPC excludes authentication,
// membership, permissions, notifications, and other account/security records.
export async function createMemberInvitation(profileId,email,role="Member") {
  if (!client || !workspace || !isAdmin()) throw new Error("Only a household Admin can invite accounts.");
  const {data,error}=await client.rpc("wiwy_create_member_invitation",{
    target_workspace:workspace.id,target_profile:profileId,target_email:email,target_role:role
  });
  if(error)throw error;
  return `${location.origin}${location.pathname}?invite=${encodeURIComponent(data)}`;
}
export async function setMemberRole(userId,role) {
  if (!client || !workspace || !isAdmin()) throw new Error("Only a household Admin can change roles.");
  const {data,error}=await client.rpc("wiwy_set_member_role",{
    target_workspace:workspace.id,target_user:userId,new_role:role
  });
  if(error)throw error;
  await refresh();
  return data;
}

export async function prepareForUpdate() {
  if (!client || !workspace || !user?.id) throw new Error("Sign in before updating WIWY.");
  if (typeof navigator!=="undefined" && !navigator.onLine) throw new Error("WIWY is offline. Pending cloud changes cannot be verified.");
  // Current WIWY mutations are awaited Supabase writes, not a local offline queue.
  // A successful refresh verifies that the household cloud endpoint is reachable.
  await refresh();
  return {ready:true,workspaceId:workspace.id};
}

export async function exportHouseholdBackup() {
  if (!client || !workspace) throw new Error("WIWY cloud connection is not initialized.");
  if (!user?.id) throw new Error("You must be signed in to export household data.");
  const { data, error } = await client.rpc("wiwy_export_household_backup", {
    target_workspace: workspace.id
  });
  if (error) throw error;
  if (!data || data.format !== "wiwy-household-backup" ||
      data.schemaVersion !== 1 || !data.data) {
    throw new Error("The server returned an invalid WIWY backup.");
  }
  const { data: settings, error: settingsError } = await client.rpc("wiwy_export_household_settings", { target_workspace:workspace.id });
  if (settingsError) throw settingsError;
  data.settings = settings || { observance_preferences:{}, custom_observances:[], reminder_rules:[] };
  return data;
}

// Import a reviewed portable backup through the transactional server-side RPC.
// The database function enforces Admin access and keeps account identity separate
// from portable household content.
export async function importHouseholdBackup(backup, importMode, profileMapping = {}) {
  if (!client || !workspace) throw new Error("WIWY cloud connection is not initialized.");
  if (!user?.id) throw new Error("You must be signed in to import household data.");
  if (!["merge", "replace"].includes(importMode)) throw new Error("Choose Merge or Replace.");
  const { data, error } = await client.rpc("wiwy_import_household_backup_v2", {
    target_workspace: workspace.id,
    backup,
    import_mode: importMode,
    profile_mapping: profileMapping,
    confirmed: true
  });
  if (error) throw error;
  if (!data?.success) throw new Error(data?.message || "The household import did not complete.");
  await refresh();
  return data;
}

