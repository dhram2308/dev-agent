## Why

Users of the Pan-level Filing wizard intermittently see previously entered field values disappear when navigating between steps (Next → Previous, Previous → Next). Because filing data drives regulatory submissions, silent data loss forces users to re-enter values, erodes trust, and risks incorrect filings.

## What Changes

- Fix state-lifecycle defect in the Pan-level Filing wizard so every step's field values persist across Next/Back navigation for the entire wizard session.
- Commit current step values to the shared wizard store in `onNext` / `onPrevious` BEFORE the step unmounts.
- Hydrate step forms from the shared store on mount with guards that never overwrite existing values with empty defaults (`reset`/`defaultValues`/`setValue` on initial wizard load only).
- Remove/guard async `useEffect` hooks that seed fields so late responses never blank user-edited values; add `AbortController` on step-change where a refetch is in flight.
- Audit stepper JSX for unstable `key` props (no `Math.random()`, `Date.now()`, or derived identities that cause remounts).
- Add a Jest/RTL regression test that fills a step, navigates next → back, and asserts values persist.
- No UI redesign, no new endpoints, no new store, no new context, no new utility abstractions.

## Capabilities

### New Capabilities
<!-- None; this is a defect fix against existing behavior. -->

### Modified Capabilities
- `pan-level-filing-wizard`: persistence-across-navigation requirement is being corrected — step field values MUST survive Next/Back navigation and MUST NOT be overwritten by remount defaults or late async responses.

## Impact

- **Affected code** (Enterprise app — scope of AUT-7382):
  - `apps/enterprise/src/app/GSTReturn/**` Pan-level Filing wizard container and step components.
  - Step-level form hooks (react-hook-form `reset`/`defaultValues`/`setValue`) and any `useEffect` that seeds fields.
  - `onNext` / `onPrevious` handlers in the wizard container.
- **APIs**: No changes. Existing draft read/save endpoints audited only for mapping correctness.
- **State**: Existing wizard slice/form root reused; no new store, context, or persistence layer.
- **Other stepper flows** (IMS, Reco, other GSTR flows): out of scope — fix MUST NOT touch a shared stepper primitive without verifying all consumers.
- **Tests**: New regression test; no existing test removals.