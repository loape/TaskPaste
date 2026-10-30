import schedule2025 from './holiday-schedules/2025.json';
import schedule2026 from './holiday-schedules/2026.json';

export type CalendarDayKind = 'holiday' | 'workday' | 'weekend' | 'weekday';
export type PersonalDay = { id?: string; date: string; name: string; type: string; repeat?: 'none' | 'solar' | 'lunar' };

type HolidaySchedule = { year: number; source: string; holidays: { name: string; start: string; end: string }[]; workdays: string[]; festivalDates: Record<string, string> };
const schedules: Record<number, HolidaySchedule> = { 2025: schedule2025, 2026: schedule2026 };
const lunarFormatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' });
const numerals = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const solarFestivals: Record<string, string> = {
  '01-01': '元旦', '02-14': '情人节', '03-08': '妇女节', '05-01': '劳动节',
  '06-01': '儿童节', '09-10': '教师节', '10-01': '国庆节',
  '12-24': '平安夜', '12-25': '圣诞节',
};
const lunarFestivals: Record<string, string> = {
  '正月-1': '春节', '正月-15': '元宵节', '五月-5': '端午节',
  '七月-7': '七夕', '八月-15': '中秋节', '九月-9': '重阳节', '腊月-8': '腊八节',
};

export const calendarDateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function lunarParts(date: Date) {
  const parts = lunarFormatter.formatToParts(date);
  return { month: parts.find(part => part.type === 'month')?.value || '', day: Number(parts.find(part => part.type === 'day')?.value) };
}

function lunarDayName(day: number) {
  if (day <= 10) return `初${numerals[day]}`;
  if (day < 20) return `十${numerals[day - 10]}`;
  if (day === 20) return '二十';
  if (day < 30) return `廿${numerals[day - 20]}`;
  return '三十';
}

export function officialScheduleSource(year: number) {
  return schedules[year]?.source || null;
}

export function calendarDay(date: Date, personalDays: PersonalDay[] = []) {
  const key = calendarDateKey(date);
  const schedule = schedules[date.getFullYear()];
  const lunar = lunarParts(date);
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 12);
  const nextLunar = lunarParts(next);
  const lunarFestival = lunar.month.startsWith('闰') ? undefined : lunarFestivals[`${lunar.month}-${lunar.day}`];
  const festival = schedule?.festivalDates[key]
    || solarFestivals[key.slice(5)] || lunarFestival
    || (nextLunar.month === '正月' && nextLunar.day === 1 ? '除夕' : undefined);
  const officialHoliday = schedule?.holidays.find(item => key >= item.start && key <= item.end);
  const shortFestival = festival === '春节' ? festival : festival?.replace(/节$/, '').slice(0, 2);
  const kind: CalendarDayKind = schedule?.workdays.includes(key) ? 'workday'
    : officialHoliday ? 'holiday'
    : date.getDay() === 0 || date.getDay() === 6 ? 'weekend' : 'weekday';
  const personal = personalDays.filter(item => {
    if (item.date === key) return true;
    if (date.getFullYear() < Number(item.date.slice(0, 4))) return false;
    if (item.repeat === 'solar') return item.date.slice(5) === key.slice(5);
    if (item.repeat === 'lunar') {
      const original = new Date(`${item.date}T12:00:00`);
      if (Number.isNaN(original.getTime())) return false;
      const initialLunar = lunarParts(original);
      return initialLunar.month === lunar.month && initialLunar.day === lunar.day;
    }
    return false;
  });
  return {
    key,
    lunar: `${lunar.month}${lunarDayName(lunar.day)}`,
    lunarShort: lunar.day === 1 ? lunar.month : lunarDayName(lunar.day),
    festival,
    personal,
    kind,
    officialHoliday: officialHoliday?.name,
    label: personal[0]?.name || shortFestival || (lunar.day === 1 ? lunar.month : lunarDayName(lunar.day)),
  };
}
