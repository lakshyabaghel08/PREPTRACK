/** Derived selectors — dashboard stats, progress trees, revision queues, analytics. */
import type { MupDatabase, ItemProgress, ItemStatus } from '../types';
import { syllabus } from '../data/syllabus';
import { pct, clamp } from '../lib/id';
import { todayKey, addDays, startOfWeek, computeStreak, dateFromKey } from '../lib/date';
import { revisionBucket } from '../lib/revision';
import { hierarchyStatus, leafNodes, parentNode } from '../lib/syllabusProgress';
import { lectureProgress } from '../lib/lectures';

/** Effective status: deterministic child-to-parent rollup. */
export function statusOf(itemId: string, db: MupDatabase): ItemStatus {
  return hierarchyStatus(itemId, db.progress);
}

export function progressOf(itemId: string, db: MupDatabase): ItemProgress | undefined {
  return db.progress[itemId];
}

/** One-pass bottom-up stats for every node in the tree. O(subtopics). */
export interface NodeStat { total: number; completed: number; inProgress: number; pct: number }
export function treeStats(db: MupDatabase): Map<string, NodeStat> {
  const m = new Map<string, NodeStat>();
  const zero = (): NodeStat => ({ total: 0, completed: 0, inProgress: 0, pct: 0 });
  for (const p of syllabus.papers) m.set(p.id, zero());
  for (const s of syllabus.subjects) m.set(s.id, zero());
  for (const c of syllabus.chapters) m.set(c.id, zero());
  for (const t of syllabus.topics) m.set(t.id, zero());

  const add = (id: string, status: ItemStatus) => {
    const e = m.get(id);
    if (!e) return;
    e.total++;
    if (status === 'completed') e.completed++;
    else if (status === 'in_progress') e.inProgress++;
  };
  for (const leaf of leafNodes()) {
    const status = db.progress[leaf.id]?.status ?? 'not_started';
    let node: { id: string } | null = leaf;
    while (node) {
      add(node.id, status);
      node = parentNode(node.id);
    }
  }
  for (const [id, e] of m) e.pct = pct(e.completed, e.total);
  return m;
}

export function paperStats(db: MupDatabase) {
  const ts = treeStats(db);
  return syllabus.papers.map((p) => ({ paper: p, ...(ts.get(p.id) ?? { total: 0, completed: 0, inProgress: 0, pct: 0 }) }));
}

export function leafStats(itemType: 'paper' | 'subject' | 'chapter' | 'topic', itemId: string, db: MupDatabase): NodeStat {
  const ts = treeStats(db);
  return ts.get(itemId) ?? { total: 0, completed: 0, inProgress: 0, pct: 0 };
}

export function focusMinutesByApplicationDay(db: MupDatabase): Map<string, number> {
  const minutes = new Map<string, number>();
  for (const session of db.focusSessions) {
    if (session.sessionType !== 'focus' || !session.completed) continue;
    const key = todayKey(new Date(session.startedAt));
    minutes.set(key, (minutes.get(key) ?? 0) + session.durationMinutes);
  }
  return minutes;
}

export function dashboardStats(db: MupDatabase) {
  const today = todayKey();
  // tasks
  const todays = db.tasks.filter((t) => t.deadline === today);
  const tasksDone = todays.filter((t) => t.status === 'completed').length;
  const overdue = db.tasks.filter((t) => t.status !== 'completed' && t.deadline < today).length;
  const upcomingWeek = db.tasks.filter((t) => t.status !== 'completed' && t.deadline > today && t.deadline <= addDays(today, 7)).length;
  // syllabus
  const allLeafIds = leafNodes().map((node) => node.id);
  let done = 0;
  for (const id of allLeafIds) if (db.progress[id]?.status === 'completed') done++;
  const syllabusPct = pct(done, allLeafIds.length);
  // revision
  let dueToday = 0, overdueRev = 0, revisedItems = 0, maxedItems = 0;
  for (const p of Object.values(db.progress)) {
    if (p.revisionCount > 0) {
      revisedItems++;
      if (p.revisionCount >= 5) maxedItems++;
    }
    const b = revisionBucket(p.nextRevisionAt, p.revisionCount, new Date());
    if (b === 'due_today') dueToday++;
    else if (b === 'overdue') overdueRev++;
  }
  // tests
  const testAvg = avgScorePct(db);
  // streak + hours
  const activeDays = new Set<string>();
  for (const s of db.focusSessions) if (s.sessionType === 'focus' && s.completed) activeDays.add(todayKey(new Date(s.startedAt)));
  for (const t of db.tasks) if (t.completedAt) activeDays.add(todayKey(new Date(t.completedAt)));
  const streak = computeStreak(activeDays, today);
  // focus this week
  const minutesByDay = focusMinutesByApplicationDay(db);
  const weekStart = startOfWeek(today);
  const weekMinutes = [...minutesByDay.entries()].filter(([day]) => day >= weekStart && day <= today).reduce((sum, [, minutes]) => sum + minutes, 0);
  const todayMinutes = minutesByDay.get(today) ?? 0;
  // 7-day hours for sparkline
  const days7: { day: string; minutes: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const key = addDays(today, -i);
    days7.push({ day: key, minutes: minutesByDay.get(key) ?? 0 });
  }
  const geoLectures = lectureSummary(db);
  return {
    tasks: { today: todays.length, done: tasksDone, overdue, upcomingWeek },
    syllabus: { pct: syllabusPct, done, total: allLeafIds.length },
    revision: { dueToday, overdue: overdueRev, revisedItems, maxedItems },
    tests: { avg: testAvg.avg, count: testAvg.count },
    streak, weekMinutes, todayMinutes, days7,
    lectures: geoLectures,
  };
}

export function avgScorePct(db: MupDatabase): { avg: number; count: number } {
  const prelims = db.prelimsTests.map((t) => (t.maxScore > 0 ? (t.score / t.maxScore) * 100 : 0));
  const mains = db.mainsTests.map((t) => (t.maxMarks > 0 ? (t.marksObtained / t.maxMarks) * 100 : 0));
  const all = [...prelims, ...mains].filter((n) => Number.isFinite(n));
  if (all.length === 0) return { avg: 0, count: 0 };
  return { avg: Math.round(all.reduce((a, b) => a + b, 0) / all.length), count: all.length };
}

function taskCreatedDay(t: { createdAt?: string; deadline: string }): string {
  if (t.createdAt) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(t.createdAt)) return t.createdAt;
    const parsed = new Date(t.createdAt);
    if (!Number.isNaN(parsed.getTime())) return todayKey(parsed);
  }
  return t.deadline;
}

/**
 * Task trend counts `created` by each task's original creation date (kept
 * unchanged when rescheduled) and `completed` against its scheduled `deadline`.
 */
export function taskTrend(db: MupDatabase, days = 14): { day: string; created: number; completed: number }[] {
  const today = todayKey();
  const out: { day: string; created: number; completed: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = addDays(today, -i);
    const created = db.tasks.filter((t) => taskCreatedDay(t) === key).length;
    const completed = db.tasks.filter((t) => t.deadline === key && t.status === 'completed').length;
    out.push({ day: key, created, completed });
  }
  return out;
}

export function subjectProgressForPaper(paperId: string, db: MupDatabase) {
  return (syllabus.subjectsOf.get(paperId) ?? []).map((s) => ({ subject: s, ...leafStats('subject', s.id, db) }));
}

/** Revision queue grouped by bucket. */
export function revisionQueue(db: MupDatabase) {
  const buckets = { overdue: [] as ItemProgress[], dueToday: [] as ItemProgress[], upcoming: [] as ItemProgress[], notStarted: 0 };
  const leaves = new Set(leafNodes().map((node) => node.id));
  for (const p of Object.values(db.progress)) {
    const b = revisionBucket(p.nextRevisionAt, p.revisionCount, new Date());
    if (b === 'overdue') buckets.overdue.push(p);
    else if (b === 'due_today') buckets.dueToday.push(p);
    else if (b === 'upcoming') buckets.upcoming.push(p);
    else if (p.status === 'completed' && leaves.has(p.itemId)) buckets.notStarted++;
  }
  buckets.overdue.sort((a, b) => (a.nextRevisionAt ?? '').localeCompare(b.nextRevisionAt ?? ''));
  buckets.dueToday.sort((a, b) => (a.nextRevisionAt ?? '').localeCompare(b.nextRevisionAt ?? ''));
  buckets.upcoming.sort((a, b) => (a.nextRevisionAt ?? '').localeCompare(b.nextRevisionAt ?? ''));
  return buckets;
}

export function confidenceSplit(db: MupDatabase): { low: number; medium: number; high: number } {
  let low = 0, medium = 0, high = 0;
  for (const p of Object.values(db.progress)) {
    if (p.revisionCount === 0) continue;
    if (p.confidence === 1) low++;
    else if (p.confidence === 2) medium++;
    else if (p.confidence === 3) high++;
  }
  return { low, medium, high };
}

// ---------- Geography lectures ----------
export function lectureSummary(db: MupDatabase) {
  const totals = db.lectures.map(lectureProgress);
  const total = totals.reduce((sum, item) => sum + item.total, 0);
  const completed = totals.reduce((sum, item) => sum + item.count, 0);
  const lecturesDone = totals.filter((item) => item.total > 0 && item.count === item.total).length;
  const notes = db.lectures.filter((l) => l.shortNotesMade).length;
  const revised = db.lectures.filter((l) => l.revised).length;
  const pyqs = db.lectures.reduce((a, l) => a + l.pyqsAttempted, 0);
  return { series: db.lectures.length, total, completed: clamp(completed, 0, total), lecturesDone, notes, revised, pyqs, pct: pct(completed, total) };
}

// ---------- Test analytics ----------
export function prelimsAnalytics(db: MupDatabase) {
  const tests = [...db.prelimsTests].sort((a, b) => a.testDate.localeCompare(b.testDate));
  const series = tests.map((t, i) => ({
    idx: i + 1,
    name: t.testName,
    date: t.testDate,
    scorePct: t.maxScore > 0 ? Math.round((t.score / t.maxScore) * 100) : 0,
    accuracy: t.attempted > 0 ? Math.round((t.correct / t.attempted) * 100) : 0,
    attemptRate: t.totalQuestions > 0 ? Math.round((t.attempted / t.totalQuestions) * 100) : 0,
    negImpact: t.attempted > 0 ? Math.round((t.incorrect / t.attempted) * 100) : 0,
    type: t.testType,
  }));
  const avg = (nums: number[]) => (nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0);
  return {
    series,
    count: series.length,
    avgScore: avg(series.map((s) => s.scorePct)),
    avgAccuracy: avg(series.map((s) => s.accuracy)),
    avgAttempt: avg(series.map((s) => s.attemptRate)),
    best: series.length ? Math.max(...series.map((s) => s.scorePct)) : 0,
    last: series.length ? series[series.length - 1] : null,
    byType: Object.entries(groupBy(series, (s) => s.type)).map(([type, arr]) => ({ type, count: arr.length, avgScore: avg(arr.map((a) => a.scorePct)) })),
  };
}

export function mainsAnalytics(db: MupDatabase) {
  const tests = [...db.mainsTests].sort((a, b) => a.testDate.localeCompare(b.testDate));
  const series = tests.map((t, i) => ({
    idx: i + 1,
    name: t.testName,
    date: t.testDate,
    marksPct: t.maxMarks > 0 ? Math.round((t.marksObtained / t.maxMarks) * 100) : 0,
    marksObtained: t.marksObtained,
    maxMarks: t.maxMarks,
    wordCount: t.wordCount ?? 0,
    paper: t.paper,
    type: t.testType,
  }));
  const avg = (nums: number[]) => (nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0);
  return {
    series,
    count: series.length,
    avgMarks: avg(series.map((s) => s.marksPct)),
    best: series.length ? Math.max(...series.map((s) => s.marksPct)) : 0,
    totalWords: series.reduce((a, s) => a + s.wordCount, 0),
    byPaper: Object.entries(groupBy(series, (s) => s.paper)).map(([paper, arr]) => ({ paper, count: arr.length, avgMarks: avg(arr.map((a) => a.marksPct)) })),
  };
}

export function groupBy<T>(arr: T[], keyFn: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of arr) {
    const k = keyFn(item);
    (out[k] = out[k] ?? []).push(item);
  }
  return out;
}

// ---------- Calendar helpers ----------
export interface CalendarEntry { date: string; kind: 'task' | 'event' | 'revision' | 'test'; label: string; done?: boolean; id?: string; priority?: string }

export function calendarEntries(db: MupDatabase, year: number, month: number): Record<string, CalendarEntry[]> {
  const out: Record<string, CalendarEntry[]> = {};
  const push = (date: string, e: CalendarEntry) => {
    if (date.length !== 10) return;
    const d = dateFromKey(date);
    if (d.getFullYear() !== year || d.getMonth() !== month) return;
    (out[date] = out[date] ?? []).push(e);
  };
  for (const t of db.tasks) {
    push(t.deadline, { date: t.deadline, kind: t.isEvent ? 'event' : 'task', label: t.name, done: t.status === 'completed', id: t.id, priority: t.priority });
  }
  for (const [, p] of Object.entries(db.progress)) {
    if (p.nextRevisionAt && p.revisionCount > 0 && p.revisionCount < 5) {
      const key = todayKey(new Date(p.nextRevisionAt));
      const title = syllabus.subtopicById.get(p.itemId)?.title ?? syllabus.topicById.get(p.itemId)?.title ?? 'Revision';
      push(key, { date: key, kind: 'revision', label: `R${p.revisionCount + 1} due — ${title}`, id: p.itemId });
    }
  }
  for (const t of db.prelimsTests) push(t.testDate, { date: t.testDate, kind: 'test', label: `📝 ${t.testName}`, id: t.id });
  for (const t of db.mainsTests) push(t.testDate, { date: t.testDate, kind: 'test', label: `✍️ ${t.testName}`, id: t.id });
  return out;
}
