## 1. Locate & Verify Scope

- [ ] 1.1 Identify the Compare Screen Step 3 container file under `apps/enterprise/src/app/**/Compare/**` that constructs the triple-dot menu `items` array / JSX
- [ ] 1.2 Confirm the two menu entries are `View Data` and `Fetch Data` and inspect each entry's existing props: `key`, `icon`, `label`, `onClick`, `disabled`, permission guard, `aria-label`
- [ ] 1.3 Grep the repo for the shared menu component (e.g., antd `Dropdown`/`Menu`, `MoreActions`, `AppIcon` overflow) to confirm the edit target is the Step 3 caller, not the shared component
- [ ] 1.4 Identify all render locations of the triple-dot menu on Compare Step 3 (per-row, per-section, header) where both options coexist
- [ ] 1.5 Confirm existing `VITE_PRODUCT_ID` enterprise gating around the menu and note its location so it remains untouched

## 2. Implement Reorder

- [ ] 2.1 In the Compare Step 3 caller, swap the `Fetch Data` and `View Data` entries so `Fetch Data` renders first and `View Data` renders second, preserving every existing prop on both entries
- [ ] 2.2 If the menu is rendered in multiple places on Step 3 where both options coexist, apply the same reorder consistently at each caller site
- [ ] 2.3 Verify no shared menu component file was edited (git diff should touch only Compare Step 3 caller files)
- [ ] 2.4 Verify no changes to onClick handlers, disabled conditions, permission guards, `VITE_PRODUCT_ID` gating, icons, labels, `aria-label`s, or `key`s

## 3. Harden Tests

- [ ] 3.1 Grep Compare Step 3 test specs (Jest/RTL + Cypress) for positional selectors: `nth-child`, `[0]`, `.first()`, `getAllByRole('menuitem')[`, `option_index`
- [ ] 3.2 Migrate each positional selector to a text-based query (e.g., `getByText('Fetch Data')`, `findByRole('menuitem', { name: /fetch data/i })`)
- [ ] 3.3 Add or update a single RTL test asserting rendered order: first menu item text is `Fetch Data`, second is `View Data`
- [ ] 3.4 Run `nx test enterprise` and confirm all Compare Step 3 tests pass

## 4. Manual QA

- [ ] 4.1 Verify pre-fetch state: both options visible, `Fetch Data` first and enabled, `View Data` second with prior disabled/hidden rule preserved
- [ ] 4.2 Verify post-fetch state: order preserved, `Fetch Data` first, `View Data` second and enabled
- [ ] 4.3 Verify permission-hidden state: if one option is hidden, the remaining option renders without empty slot
- [ ] 4.4 Verify keyboard navigation: Tab / arrow keys land on `Fetch Data` first, then `View Data`
- [ ] 4.5 Verify screen reader announces `Fetch Data` before `View Data` with unchanged `aria-label`s
- [ ] 4.6 Verify `VITE_PRODUCT_ID` gating: menu still hidden in non-enterprise builds
- [ ] 4.7 Verify Compare Step 1, Step 2, and other PAN-level Filing screens show their original (pre-change) menu order — no regression

## 5. Lint, Review, Ship

- [ ] 5.1 Run `nx lint enterprise` and resolve any lint issues
- [ ] 5.2 Run `nx build enterprise --configuration=production` and confirm clean build
- [ ] 5.3 Open PR referencing AUT-8467 with before/after screenshots of the Compare Step 3 triple-dot menu
- [ ] 5.4 Confirm PR diff is minimal — no refactor, no new abstractions, no unrelated file changes
- [ ] 5.5 After merge, monitor QA Main / QA1 regression suites for any Compare Step 3 menu selector failures and address promptly