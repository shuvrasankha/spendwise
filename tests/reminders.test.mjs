// Run: node --test tests/*.test.mjs — the daily-reminder switch follows the account to every device
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reminderSync } from '../assets/js/utils/helpers.js';

test('turned off on another device: this one turns off too', () => {
  assert.equal(reminderSync(false, true, 'granted'), 'off');
});

test('turned on elsewhere: subscribes here only if notifications are already allowed', () => {
  assert.equal(reminderSync(true, false, 'granted'), 'on');
  assert.equal(reminderSync(true, false, 'default'), 'ask'); // needs a tap on the switch
  assert.equal(reminderSync(true, false, 'denied'), null);   // Settings already says they're blocked
});

test('already matching: nothing to do', () => {
  assert.equal(reminderSync(true, true, 'granted'), null);
  assert.equal(reminderSync(false, false, 'default'), null);
});

test('never saved: a device that has reminders on uploads its state once', () => {
  assert.equal(reminderSync(undefined, true, 'granted'), 'upload');
  assert.equal(reminderSync(undefined, false, 'default'), null);
});
