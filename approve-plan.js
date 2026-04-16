#!/usr/bin/env node
"use strict";
require('./packages/backend/register-aliases');
const sm = require('./packages/backend/dist/state/state-manager');

const state = sm.readForDisplay('AUT-8462');
if (state === null || state === undefined) {
  console.error('No state found');
  process.exit(1);
}

console.log('Current stage:', state.stage);
console.log('Before: explore_plan_ui_approved =', (state.data || {}).explore_plan_ui_approved);

const patched = sm.applyUIPatch(state, 'explore_plan', { '_ui_approved': true });
console.log('After patch: explore_plan_ui_approved =', (patched.data || {}).explore_plan_ui_approved);

sm.save(patched);
console.log('Saved with _seq:', patched._seq);
