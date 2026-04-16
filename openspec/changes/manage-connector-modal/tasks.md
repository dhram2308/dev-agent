## 1. Settings Store — Add Missing Config Groups

- [x] 1.1 Add `figma` config group with FIGMA_TOKEN, OAUTH_FIGMA_CLIENT_ID, OAUTH_FIGMA_CLIENT_SECRET fields
- [x] 1.2 Add `google-drive` config group with GDRIVE_SERVICE_ACCOUNT_JSON, OAUTH_GOOGLE_CLIENT_ID, OAUTH_GOOGLE_CLIENT_SECRET fields
- [x] 1.3 Add `postman` config group with POSTMAN_API_KEY field
- [x] 1.4 Export `CONNECTOR_GROUP_IDS` set containing all 8 connector group IDs

## 2. ConnectorCard — Manage Modal with Config Fields

- [x] 2.1 Add `ConnectorConfigField` interface and new props: configFields, configValues, onSaveConnectorConfig
- [x] 2.2 Add local state for modal config editing (localConfig, localOriginal, localDirty, localSaving)
- [x] 2.3 Initialize local config snapshot from store values when modal opens
- [x] 2.4 Add handleLocalFieldChange, handleLocalSave, handleLocalReset handlers
- [x] 2.5 Render ConfigField components inside the modal for each connector's fields
- [x] 2.6 Add Save/Reset buttons with dirty state tracking in modal actions
- [x] 2.7 Remove "Configure" button from card footer (config now in modal)
- [x] 2.8 Keep status display, OAuth controls, Test Now, and Disconnect in modal

## 3. ConnectorsTab — Pass Config Data to Cards

- [x] 3.1 Import CONFIG_GROUPS and build configFieldsMap (connector ID → config fields)
- [x] 3.2 Add handleSaveConnectorConfig callback (calls api.saveConfig + refreshes store)
- [x] 3.3 Pass configFields, configValues, onSaveConnectorConfig to each ConnectorCard
- [x] 3.4 Remove handleConfigure, setActiveTab, setFocusGroup, canConfigure (no longer needed)

## 4. ConfigTab — Filter Out Connector Groups

- [x] 4.1 Import CONNECTOR_GROUP_IDS from settings store
- [x] 4.2 Filter configGroups to exclude connector groups (jira, gitlab, slack, claude, browser, figma, google-drive, postman)

## 5. Verification

- [x] 5.1 TypeScript compiles clean (npx tsc --noEmit)
- [x] 5.2 Vite build succeeds
- [ ] 5.3 Verify Manage modal shows config fields pre-loaded for a PAT connector (Jira)
- [ ] 5.4 Verify Manage modal shows OAuth status + config fields for Figma/Google Drive
- [ ] 5.5 Verify Config tab no longer shows connector groups (only non-connector groups remain)
- [ ] 5.6 Verify Save in modal persists changes and refreshes store
