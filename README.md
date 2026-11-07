# WIWY — Wherever I'm With You
Early foundation build · 0.1.0

This is a tablet-friendly, installable PWA starter for the WIWY household/workspace organizer. It is intentionally a static site so it can be uploaded directly to GitHub Pages without a computer-based build process.

## What is included in this first build
- Dark responsive interface for phone and tablet.
- Today dashboard with schedule counts and agenda.
- Task builder with assignee, one-time/daily/selected-weekday recurrence, start/end time, optional required steps, and notes.
- Task occurrence completion state for the current date.
- Basic day timeline.
- Workspace member profiles with customizable identity colors and roles.
- Weekly meal entries.
- Shared grocery list with categories and completion.
- Activity ledger.
- Away-mode settings model (reminder suppression is not active yet because notifications are not implemented).
- Local persistence on the current browser/device.
- JSON export/import backup.
- PWA manifest and service worker.
- Supabase client connection placeholder and initial SQL schema.

## Important: current data behavior
This build saves data in the browser's local storage on the device where it is used. It does **not yet synchronize data between devices**. The Supabase client can initialize, but actual authentication, row-level security, and database sync are a later integration step. Do not treat local browser storage as a shared family database.

## Deploy to GitHub Pages
1. Extract this ZIP.
2. Open your `household_management` GitHub repository in the browser.
3. Upload the contents of this folder (not the outer folder itself) to the repository root.
4. Commit the upload to the `main` branch.
5. In the repository, open **Settings → Pages**.
6. Under Build and deployment, choose **Deploy from a branch**, branch `main`, folder `/ (root)`, then Save.
7. Wait for GitHub Pages to publish. The address should use your all-lowercase repository path.

## Supabase setup
The SQL file `supabase/schema.sql` creates the first normalized workspace tables and enables RLS. The first PWA build does not yet write to those tables. We'll connect sign-in and data synchronization after the shell has been deployed and tested.

In `js/config.js`, the two empty strings can later be filled with:
- Supabase Project URL
- Supabase Publishable key

A publishable key is intended for client-side use. Never put a service-role key or database password in frontend files.

## Current limitations / next engineering stages
This is a foundation, not the finished product. Known next steps:
1. Add secure Supabase Auth and workspace membership/invitations.
2. Implement database-backed sync and conflict-safe updates.
3. Expand calendar into true day/week time-block views with navigation and overlapping events.
4. Implement task operation completion, occurrence generation, status derivation, and editable recurrence rules.
5. Implement Away Mode expiry and notification suppression.
6. Add meal planning, recipe details, ingredient-to-grocery links, prep reminders, and shared editing.
7. Add family calendar events and Android push notifications.
8. Add read-only TV display route and future native app compatibility.

## Project principles
- Workspace data is isolated by `workspace_id`.
- A member profile is distinct from a login account.
- Roles belong to a workspace membership, not globally to an account.
- Keep household-specific routines as user-created data, not hardcoded application behavior.
- Preserve history when task definitions or assignments change.
