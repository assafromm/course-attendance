import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationItems } from '../src/navigation.js';

test('lecturer menus depend on a selected course and never show audit', () => {
  assert.deepEqual(navigationItems('teacher', false).map(x => x[0]), ['attendance']);
  assert.deepEqual(navigationItems('teacher', true).map(x => x[0]), ['attendance', 'roster', 'settings']);
});
test('admin retains system access without a course; audit requires a course', () => {
  assert.deepEqual(navigationItems('admin', false).map(x => x[0]), ['attendance', 'settings']);
  assert.equal(navigationItems('admin', false)[1][2], 'ניהול הרשאות מרצים');
  assert.deepEqual(navigationItems('admin', true).map(x => x[0]), ['attendance', 'roster', 'audit', 'settings']);
});
