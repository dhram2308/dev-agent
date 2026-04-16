# React UI Shell Spec

## Domain: packages/frontend/src/components/ (Shell, Toast, Modal, Router)

## Status: ADDED

## Overview
Application shell providing hash-based URL routing, a toast notification system,
confirm/error modals, and keyboard shortcut handling.

## Requirements

### ADDED: Hash-Based URL Routing
- WHEN navigating THEN hash-based routing switches between `#/dashboard`, `#/settings`, and `#/review`.
- WHEN the URL hash is empty or `#/` THEN the application redirects to `#/dashboard` as the default route.
- WHEN an unknown hash is navigated to THEN a "404 - Page Not Found" view renders with a link back to dashboard.
- WHEN the browser back/forward buttons are used THEN the correct page renders based on the hash.

### ADDED: Toast Notifications
- WHEN an API call succeeds THEN a toast shows a success message with green styling and auto-dismisses after 3 seconds.
- WHEN an API call fails THEN a toast shows an error message with red styling and auto-dismisses after 5 seconds.
- WHEN a toast is shown THEN it includes a close button for manual dismissal before auto-dismiss.
- WHEN multiple toasts fire simultaneously THEN they stack vertically anchored to the bottom-left of the viewport.
- WHEN a toast is dismissed (manually or auto) THEN it animates out with a fade-slide transition.

### ADDED: Confirm Dialog
- WHEN a destructive action is triggered (e.g., reset config, discard changes) THEN a confirm dialog modal appears.
- WHEN the confirm dialog appears THEN it has "Cancel" and "Confirm" buttons with the action description.
- WHEN "Cancel" is clicked THEN the modal closes and no action is taken.
- WHEN "Confirm" is clicked THEN the destructive action executes and the modal closes.
- WHEN the confirm dialog is open THEN the background content is dimmed and non-interactive (focus trap).

### ADDED: Error Overlay Modal
- WHEN a fatal error occurs (unhandled exception, SSE disconnect) THEN an error overlay modal appears covering the viewport.
- WHEN the error overlay renders THEN it displays the error message and a "Dismiss" button.
- WHEN "Dismiss" is clicked THEN the error overlay closes and the application returns to its previous state.

### ADDED: Keyboard Shortcuts
- WHEN Esc is pressed while a modal is open THEN the modal closes (same as clicking Cancel/Dismiss).
- WHEN Esc is pressed while no modal is open THEN nothing happens.
- WHEN a modal is open THEN Tab key cycles focus only within the modal (focus trap).
