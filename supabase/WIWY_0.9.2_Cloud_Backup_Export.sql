-- WIWY 0.9.2 — Cloud Household Backup Export
-- Filename: WIWY_0.9.2_Cloud_Backup_Export.sql
-- Safe, read-only household export. Does not modify household records.

BEGIN;

CREATE OR REPLACE FUNCTION public.wiwy_export_household_backup(target_workspace uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_user uuid := auth.uid();
    v_workspace public.workspaces%rowtype;
    v_data jsonb;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'You must be signed in to export household data.';
    END IF;

    IF target_workspace IS NULL OR NOT public.is_workspace_member(target_workspace) THEN
        RAISE EXCEPTION 'You do not have access to this workspace.';
    END IF;

    SELECT * INTO v_workspace
    FROM public.workspaces
    WHERE id = target_workspace;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Workspace not found.';
    END IF;

    SELECT jsonb_build_object(
        'people', COALESCE((
            SELECT jsonb_agg(
                to_jsonb(p) - 'workspace_id'
                ORDER BY p.created_at, p.display_name
            )
            FROM public.member_profiles p
            WHERE p.workspace_id = target_workspace
        ), '[]'::jsonb),

        'tasks', COALESCE((
            SELECT jsonb_agg(
                to_jsonb(t) - ARRAY['workspace_id','created_by']::text[]
                ORDER BY t.created_at, t.id
            )
            FROM public.tasks t
            WHERE t.workspace_id = target_workspace
        ), '[]'::jsonb),

        'taskOperations', COALESCE((
            SELECT jsonb_agg(
                to_jsonb(o) - 'workspace_id'
                ORDER BY o.task_id, o.sort_order, o.created_at
            )
            FROM public.task_operations o
            WHERE o.workspace_id = target_workspace
        ), '[]'::jsonb),

        'taskAssignments', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'task_id', a.task_id,
                    'member_profile_id', a.member_profile_id,
                    'created_at', a.created_at
                )
                ORDER BY a.task_id, a.member_profile_id
            )
            FROM public.task_assignments a
            JOIN public.tasks t ON t.id = a.task_id
            WHERE t.workspace_id = target_workspace
        ), '[]'::jsonb),

        'taskOccurrences', COALESCE((
            SELECT jsonb_agg(
                to_jsonb(o) - ARRAY['workspace_id','completed_by']::text[]
                ORDER BY o.occurrence_date, o.task_id
            )
            FROM public.task_occurrences o
            WHERE o.workspace_id = target_workspace
        ), '[]'::jsonb),

        'taskOccurrenceAssignees', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'occurrence_id', a.occurrence_id,
                    'member_profile_id', a.member_profile_id,
                    'created_at', a.created_at
                )
                ORDER BY a.occurrence_id, a.member_profile_id
            )
            FROM public.task_occurrence_assignees a
            JOIN public.task_occurrences o ON o.id = a.occurrence_id
            WHERE o.workspace_id = target_workspace
        ), '[]'::jsonb),

        'taskOperationCompletions', COALESCE((
            SELECT jsonb_agg(
                to_jsonb(c) - ARRAY['workspace_id','completed_by']::text[]
                ORDER BY c.occurrence_id, c.operation_id
            )
            FROM public.task_operation_completions c
            WHERE c.workspace_id = target_workspace
        ), '[]'::jsonb),

        'meals', COALESCE((
            SELECT jsonb_agg(
                to_jsonb(m) - ARRAY['workspace_id','created_by']::text[]
                ORDER BY m.meal_date, m.created_at
            )
            FROM public.meals m
            WHERE m.workspace_id = target_workspace
        ), '[]'::jsonb),

        'groceries', COALESCE((
            SELECT jsonb_agg(
                to_jsonb(g) - ARRAY['workspace_id','added_by']::text[]
                ORDER BY g.created_at, g.id
            )
            FROM public.grocery_items g
            WHERE g.workspace_id = target_workspace
        ), '[]'::jsonb),

        'events', COALESCE((
            SELECT jsonb_agg(
                to_jsonb(e) - ARRAY['workspace_id','created_by']::text[]
                ORDER BY e.starts_at, e.id
            )
            FROM public.workspace_events e
            WHERE e.workspace_id = target_workspace
        ), '[]'::jsonb),

        'awayPeriods', COALESCE((
            SELECT jsonb_agg(
                to_jsonb(a) - ARRAY['workspace_id','created_by']::text[]
                ORDER BY a.starts_at, a.id
            )
            FROM public.away_periods a
            WHERE a.workspace_id = target_workspace
        ), '[]'::jsonb),

        'activity', COALESCE((
            SELECT jsonb_agg(
                to_jsonb(a) - ARRAY['workspace_id','actor_user_id']::text[]
                ORDER BY a.created_at, a.id
            )
            FROM public.activity_ledger a
            WHERE a.workspace_id = target_workspace
        ), '[]'::jsonb)
    )
    INTO v_data;

    RETURN jsonb_build_object(
        'format', 'wiwy-household-backup',
        'schemaVersion', 1,
        'exportedAt', now(),
        'source', jsonb_build_object(
            'workspaceId', v_workspace.id,
            'workspaceName', v_workspace.name,
            'timezone', v_workspace.timezone
        ),
        'data', v_data
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.wiwy_export_household_backup(uuid)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.wiwy_export_household_backup(uuid)
TO authenticated;

COMMIT;
