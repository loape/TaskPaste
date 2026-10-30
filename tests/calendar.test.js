import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarDay, officialScheduleSource } from '../src/calendar.ts';

const day = date => calendarDay(new Date(`${date}T12:00:00`));

test('农历节日按实际日期显示，圣诞不被误标为放假', () => {
  assert.equal(day('2026-02-16').festival, '除夕');
  assert.equal(day('2026-02-17').festival, '春节');
  assert.equal(day('2026-09-25').festival, '中秋节');
  assert.equal(day('2026-09-25').lunar, '八月十五');
  assert.equal(day('2026-12-25').festival, '圣诞节');
  assert.equal(day('2026-12-25').kind, 'weekday');
});

test('官方休假与调休上班覆盖周末，未知年份只按周末判断', () => {
  assert.equal(day('2026-10-01').kind, 'holiday');
  assert.equal(day('2026-10-10').kind, 'workday');
  assert.equal(day('2026-10-11').kind, 'weekend');
  assert.equal(day('2025-10-06').festival, '中秋节');
  assert.equal(day('2025-10-06').kind, 'holiday');
  assert.equal(day('2025-10-11').kind, 'workday');
  assert.equal(day('2027-01-01').kind, 'weekday');
  assert.equal(officialScheduleSource(2027), null);
});

test('个人纪念日不改变休息状态', () => {
  const info = calendarDay(new Date('2026-12-25T12:00:00'), [{ date: '2026-12-25', name: '生日', type: 'personal' }]);
  assert.equal(info.label, '生日');
  assert.equal(info.festival, '圣诞节');
  assert.equal(info.kind, 'weekday');
});
