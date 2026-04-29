## Context

Compare Screen Step 3 is part of the enterprise PAN-level Filing flow (related to AUT-7382). It renders a per-row (and/or per-section) triple-dot overflow menu that currently exposes two actions: `View Data` and `Fetch Data`. The existing order (`View Data` → `Fetch Data`) does not match the intended user workflow where a user first fetches data and then views it. This is a Medium-severity presentational defect with no Acceptance Criteria attached, so the change must stay minimal and strictly presentational.

The Compare Screen lives under the enterprise app (`apps/enterprise/**`) and is gated by the enterprise `VITE_PRODUCT_ID`. The triple-dot menu may be built from a shared overflow/menu component (e.g., `AppIcon`, antd `Dropdown` + `Menu`, or a custom `MoreActions` wrapper) that is also used by Step 1 / Step 2 and other screens; therefore any change must be made at the Step 3 caller, not inside the shared component.

## Goals / Non-Goals

**Goals:**
- Render `Fetch Data` as the first menu item and `View Data` as the second on Compare Screen Step 3's triple-dot menu.
- Preserve all existing behavior: click handlers, icons, disabled/hidden conditionals, permission + product-ID gating, keyboard/focus order, and `aria-label`s.
- Keep the change localized to the Step 3 caller so other screens are unaffected.
- Make Compare Step 3 test selectors order-independent (text-based) to prevent silent regressions in QA automation.

**Non-Goals:**
- No changes to Compare Step 1, Step 2, or any non-Compare screen.
- No refactor, extraction, or generalization of the shared menu component.
- No new menu items, icons, labels, analytics events, styling, or API calls.
- No business-logic changes, no snake_case field renames, no type migrations.
- No changes to SME / GST non-enterprise / TaxPro product lines.

## Decisions

**1. Change at the caller, not the shared component.**
The existing triple-dot menu is likely a shared overflow wrapper receiving an `items` array (antd `Dropdown menu={{ items }}` or similar). Reordering inside the shared component would ripple to every caller. We reorder the two entries at the Compare Step 3 container that constructs the `items` array.
*Alternatives considered:* (a) adding a `sortedItems` prop to the shared component — rejected as scope creep for a Medium defect; (b) adding a "priority" field per item — rejected as premature abstraction.

**2. Swap-in-place, preserve every prop.**
The two existing items retain their exact `key`, `icon`, `label`, `onClick`, `disabled`, permission guard, and `aria-label`. Only the array/JSX order changes. This matches CLAUDE.md's "no unnecessary abstractions" and "reuse existing code" rules.
*Alternatives considered:* extracting a typed `CompareStep3MenuItem` constant — rejected; adds churn without value for a 2-item list.

**3. Test selector hardening.**
Any Compare Step 3 test (Jest/RTL/Cypress) that asserts menu behavior via positional selectors (`nth-child(1)`, `[0]`, `.first()`, `getAllByRole('menuitem')[0]`) will be rewritten to text-based queries (`getByText('Fetch Data')` / `findByRole('menuitem', { name: /fetch data/i })`). This decouples test stability from UI ordering and prevents future re-swap regressions.
*Alternatives considered:* only fixing broken tests reactively — rejected; pre-emptive hardening is cheap and aligns with the risk analysis.

**4. Add one RTL guard test.**
A single rendered-order assertion ("first menu item = Fetch Data, second = View Data") is added to the Compare Step 3 component test (or created if absent). Guards against accidental re-swap in future refactors.

**5. Preserve `VITE_PRODUCT_ID` enterprise gating exactly.**
The existing product-ID check (per Z6) wrapping the menu or its items must be unchanged — no new conditional, no moved check. The reorder happens inside whatever branch the items already render in.

## Risks / Trade-offs

- **[MEDIUM] E2E/regression selectors using positional indexing** → Mitigation: grep Cypress/Playwright/RTL specs for `nth-child`, `[0]`, `.first()`, `getAllByRole('menuitem')` in Compare Step 3 paths and migrate to text-based queries before merge.
- **[MEDIUM] Shared menu component leaking change to other screens** → Mitigation: verify the edit is at the Step 3 caller only; if the menu is defined in a shared file, locate the Step 3 `items` array and swap there.
- **[MEDIUM] Conditional rendering (disabled/hidden) interaction** → Mitigation: manually QA three states — pre-fetch (Fetch Data enabled, View Data disabled), post-fetch (both enabled), permission-hidden (only one visible). Confirm first-visible item still matches the intent.
- **[LOW] Analytics keyed on menu index** → Mitigation: grep for `option_index`, `menu_index`, `position` in tracking calls around Compare Step 3; none expected, but verified.
- **[LOW] Accessibility: focus order / SR announcement** → Mitigation: Tab/arrow-key nav lands on Fetch Data first; screen reader announces Fetch Data first (intentional); `aria-label` values unchanged.
- **[LOW] i18n ordering** → Mitigation: confirm translation keys resolve per item (not per index); since we swap JSX/array entries (each carrying its own key), i18n is unaffected.
- **[LOW] User muscle memory** → Accepted; minor UX friction offset by intent alignment.

## Migration Plan

1. Identify the Compare Step 3 container file (`apps/enterprise/src/app/**/Compare/**/Step3*.tsx` or equivalent) and the triple-dot menu `items` array / JSX.
2. Swap the two entries so `Fetch Data` precedes `View Data`, keeping all props intact.
3. Update Compare Step 3 test selectors to text-based queries.
4. Add/update one RTL test asserting the rendered order.
5. Run `nx lint enterprise` and `nx test enterprise`.
6. Manual QA on enterprise build: pre-fetch, post-fetch, permission-hidden, keyboard nav, screen-reader states.
7. Deploy with standard enterprise release; no data migration, no feature flag, no backfill.
8. **Rollback**: revert the single commit — purely presentational, zero side effects.

## Open Questions

- **AC empty** — confirm with PM: is the required order exactly `Fetch Data` → `View Data`, and is it scoped to Step 3 only? (Requirements analysis treats this as confirmed; flag if PM clarifies otherwise.)
- **Figma reference** — the linked PAN-level Filing Figma is generic; confirm the Step 3-specific frame shows the new order, same icons/labels, and no dividers or "primary" styling on the first item.
- **Menu render locations on Step 3** — is the triple-dot menu rendered in one place (per-row) or multiple (header + per-row)? If multiple, apply the reorder wherever both options coexist.