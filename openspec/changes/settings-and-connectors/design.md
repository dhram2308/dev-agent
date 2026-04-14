# Design

## Architecture

```
Settings Page (#/settings)
  ├─ Tab: API Keys & Config (.env management)
  │   └─ GET/POST /api/config → reads/writes .env file
  ├─ Tab: Notifications (per-gate toggles)
  │   └─ GET/POST /api/notification-config → reads/writes notification-config.json
  └─ Tab: App Connectors (service status)
      └─ POST /api/config/test/:service → tests connectivity
```

## Key Decisions

1. **Config storage**: `.env` file for env vars (existing pattern), `notification-config.json` for notification prefs (new file, same dir)
2. **No OAuth for connectors yet**: Phase 1 shows status of existing services (Jira/GitLab/Slack/Claude). Future connectors (Google/Figma) are shown as "Coming Soon" cards.
3. **Atomic .env writes**: Use tmp-file + rename pattern (same as state files)
4. **Config reload**: After save, call existing `reloadConfig()` if available, otherwise require server restart
5. **Secret masking**: API returns `"****"` for sensitive fields. POST accepts new values or `"****"` (skip update).
6. **Notification defaults**: All notifications ON by default — backwards compatible
