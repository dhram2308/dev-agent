# Spec: Route Detection

## Route Detection Algorithm

### ADDED: detectRoutes(changedFiles, clonePath)

**WHEN** Part 2 begins AND changed files are available from `localGetChanges()`
**THEN** extract file paths and run 5-tier route detection algorithm

**WHEN** multiple tiers return results for the same route
**THEN** use highest confidence result (Tier 1 > Tier 2 > Tier 3 > Tier 4 > Tier 5)
**THEN** deduplicate by route path

**WHEN** detection returns results
**THEN** return array of `{ route: string, confidence: number, source: string, tier: number }`
**THEN** sort by confidence descending

## Tier 1: Direct File Path Mapping (95% confidence)

### ADDED: mapFilePathToRoute(filePath)

**WHEN** changed file matches pattern `libs/entp/src/lib/{module}/{feature}/**`
**THEN** map to route: `/{module}/{feature}` (lowercase, kebab-case)
**THEN** confidence: 0.95, source: "file-path"

**WHEN** changed file matches pattern `apps/enterprise/src/**/{module}/**`
**THEN** map to route: `/{module}` (lowercase, kebab-case)
**THEN** confidence: 0.95, source: "file-path"

**WHEN** changed file is in `libs/shared/`, `libs/helpers/`, `libs/services/`
**THEN** these are utility files — no direct route mapping
**THEN** skip to Tier 3 (AC text extraction)

**WHEN** module name contains capitalized words (e.g., "GstReturn")
**THEN** convert to kebab-case: `gst-return`

### Known module-to-route mappings

**WHEN** applying Tier 1 mapping
**THEN** use these verified mappings (from 17 route files):
```
libs/entp/src/lib/gst-return/    → /gst-return/*
libs/entp/src/lib/reports/        → /reports/*
libs/entp/src/lib/dashboard/      → /dashboard
libs/entp/src/lib/configuration/  → /config/*
libs/entp/src/lib/import/         → /import/*
libs/entp/src/lib/reconcile/      → /reconcile/*
libs/entp/src/lib/ims/            → /ims/*
libs/entp/src/lib/auth/           → /login, /signup, /enable-2fa
libs/entp/src/lib/profile/        → /profile/*
libs/entp/src/lib/tds/            → /tds/*
libs/entp/src/lib/e-invoice/      → /e-invoice/*
libs/entp/src/lib/e-way-bill/     → /e-way-bill/*
```

## Tier 2: Import Chain Analysis (80% confidence)

### ADDED: traceComponentToRoute(componentName, clonePath)

**WHEN** Tier 1 returns no results for a changed file
**THEN** extract the default export name from the changed file
**THEN** grep route files for that component name

**WHEN** route file contains `<Route path="{path}" element={<{ComponentName}>}`
**THEN** map to that route path
**THEN** confidence: 0.80, source: "import-chain"

**WHEN** route file contains lazy import: `lazy(() => import('{path}'))`
**THEN** resolve the import path to the changed file
**THEN** if match: map to the Route's path prop
**THEN** confidence: 0.80, source: "lazy-import"

**WHEN** component is imported through an index.ts barrel export
**THEN** trace through barrel: `index.ts → Component.tsx → route file`
**THEN** confidence: 0.75, source: "barrel-import"

### Route files to search

**WHEN** performing Tier 2 search
**THEN** search these known route file patterns:
```
libs/entp/src/lib/**/routes.tsx
libs/entp/src/lib/**/AppRoutes.tsx
libs/entp/src/lib/**/*Routes.tsx
apps/enterprise/src/**/*Routes.tsx
```

## Tier 3: AC Text Extraction (70% confidence)

### ADDED: extractRoutesFromAC(acceptanceCriteria)

**WHEN** Tier 1 and Tier 2 return no results
**THEN** parse acceptance criteria text for route/URL mentions

**WHEN** AC contains "Navigate to {Module} > {Feature}"
**THEN** map to route: `/{module}/{feature}` (lowercase, kebab-case)
**THEN** confidence: 0.70, source: "ac-text"

**WHEN** AC contains "/path/to/page" (explicit URL)
**THEN** use that route directly
**THEN** confidence: 0.90, source: "ac-explicit-url"

**WHEN** AC contains module name mentions (e.g., "GST Return", "Reports", "Dashboard")
**THEN** map to known module routes using Tier 1's mapping table
**THEN** confidence: 0.70, source: "ac-module-name"

## Tier 4: Module Name Grep (50% confidence)

### ADDED: grepRoutesForModule(moduleName, clonePath)

**WHEN** Tiers 1-3 return no results
**THEN** extract module/feature name from changed file path
**THEN** grep all route files for that name (case-insensitive)

**WHEN** grep finds a match in a route file
**THEN** extract the nearest `path=` prop from the JSX context
**THEN** confidence: 0.50, source: "grep-match"

**WHEN** grep finds multiple matches
**THEN** return all matches (let Gap Analysis Agent decide which is relevant)

## Tier 5: Fallback to Dashboard (30% confidence)

### ADDED: fallbackToDashboard()

**WHEN** Tiers 1-4 return no results
**THEN** return `{ route: "/dashboard", confidence: 0.30, source: "fallback" }`
**THEN** log: `"No specific route detected — falling back to /dashboard"`

**WHEN** /dashboard is used as fallback
**THEN** verification still catches:
- Global provider/context breaks
- Navigation/auth issues
- Shared component failures
- Missing imports that break the entire app

## Route Validation

### ADDED: validateDetectedRoutes(routes, clonePath)

**WHEN** routes are detected from any tier
**THEN** validate each route exists in at least one route file
**THEN** if route not found in any route file AND confidence < 0.70: discard

**WHEN** route starts with `/login`, `/signup`, `/reset-password`
**THEN** discard (these are auth routes, not feature routes)
**THEN** log: `"Discarding auth route: {route}"`

**WHEN** duplicate routes detected from different tiers
**THEN** keep the one with highest confidence
**THEN** deduplicate by normalizing path (remove trailing slash, lowercase)

## Output Format

### ADDED: Route detection result

**WHEN** route detection completes
**THEN** store in `state.data._routes_detected`:
```javascript
[
  {
    route: "/gst-return/filing",
    confidence: 0.95,
    source: "file-path",
    tier: 1,
  },
  {
    route: "/reports/gstr-1",
    confidence: 0.70,
    source: "ac-text",
    tier: 3,
  }
]
```

**WHEN** storing detected routes in state
**THEN** max 5 routes (to keep verification time bounded)
**THEN** sorted by confidence descending
**THEN** always include at least one route (fallback to /dashboard)
