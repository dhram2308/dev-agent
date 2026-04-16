# React Settings Page Spec

## Domain: packages/frontend/src/pages/Settings/

## Status: ADDED

## Overview
Settings page with 3 tabs: API Config (grouped config fields with test connection),
Notifications (9 gates x 5 channels grid), and Connectors (9 cards with status badges).

## Requirements

### ADDED: Page Layout and Tab Navigation
- WHEN navigating to `#/settings` THEN the Settings page renders with 3 tabs: "API Config", "Notifications", "Connectors".
- WHEN a tab is clicked THEN the tab content switches without a page reload.
- WHEN the page first loads THEN the "API Config" tab is selected by default.

### ADDED: API Config Tab
- WHEN viewing the API Config tab THEN 20+ config fields are shown grouped by service: Jira, GitLab, Slack, Claude, GDrive, Figma, Postman.
- WHEN a config field is marked `sensitive: true` THEN it renders as a password input with an eye-toggle button to reveal/hide.
- WHEN the eye-toggle is clicked THEN the input type switches between `password` and `text`.
- WHEN a field value is changed THEN the local state updates and the Save button becomes enabled.
- WHEN "Test Connection" is clicked for a service THEN `POST /api/config/test` is called with `{ service }` payload.
- WHEN the test connection succeeds THEN a green checkmark and "Connected" label appear next to the service group.
- WHEN the test connection fails THEN a red X and error message appear next to the service group.
- WHEN "Save" is clicked THEN `POST /api/config/save` is called with all field key-value pairs.
- WHEN save succeeds THEN a success toast is shown and the Save button returns to disabled state.

### ADDED: Notifications Tab
- WHEN viewing the Notifications tab THEN a 9 rows x 5 columns grid renders.
- WHEN viewing the grid THEN rows are the 9 pipeline gates and columns are 5 notification channels (Slack, Email, Jira Comment, Webhook, In-App).
- WHEN a toggle switch is flipped THEN the corresponding gate-channel boolean updates in the Zustand settings store.
- WHEN "Save Notification Config" is clicked THEN `POST /api/notification-config` is called with the full 9x5 matrix.

### ADDED: Connectors Tab
- WHEN viewing the Connectors tab THEN 9 connector cards are shown in a responsive grid.
- WHEN a connector is connected THEN its card shows a green "Connected" badge.
- WHEN a connector is disconnected THEN its card shows a gray "Disconnected" badge.
- WHEN a connector is not yet supported THEN its card shows a blue "Coming Soon" badge and the card is non-interactive.
- WHEN config data loads via `GET /api/config` THEN connector status is inferred from whether required fields for that service are non-empty.

### ADDED: Data Loading
- WHEN the Settings page mounts THEN `GET /api/config` is called to fetch current configuration.
- WHEN the API call is in-flight THEN a loading skeleton renders in place of form fields.
- WHEN the API call fails THEN an error message renders with a "Retry" button.
