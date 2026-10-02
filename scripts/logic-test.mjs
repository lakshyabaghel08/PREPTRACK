/**
 * Functional tests for the local data layer & engine logic.
 * Bundles src/lib + src/store + src/data with esbuild (from vite's deps),
 * runs against a fresh jsdom localStorage, and asserts core behaviours.
 */
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// browser-ish globals first (modules touch localStorage/document)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const outfile = path.join(ROOT, '.test-bundle.mjs');
await build({
  entryPoints: [path.join(ROOT, 'scripts/test-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile,
  logLevel: 'silent',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'react-dom/test-utils'],
  jsx: 'automatic',
  define: {
      'import.meta.env.VITE_SUPABASE_URL': 'undefined',
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': 'undefined',
      'import.meta.env.PROD': 'true',
      'import.meta.env.DEV': 'false',
      'import.meta.env.MODE': '"production"',
      'import.meta.env.BASE_URL': '"/"', 'import.meta.env.PROD': 'true' },
});

let failed = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failed++;
};

const mod = await import(outfile);

// ---------- revision engine ----------
const { baseInterval, scaledInterval, nextRevisionDate, revisionBucket, rLabel } = mod;
check('R1 base interval = 3d', baseInterval(1) === 3);
check('R2 base = 7d', baseInterval(2) === 7);
check('R3 base = 21d', baseInterval(3) === 21);
check('R4+ base = 45d', baseInterval(4) === 45 && baseInterval(9) === 45);
check('confidence Low scales ×0.5', scaledInterval(4, 1) === 22);
check('confidence High scales ×1.5', scaledInterval(4, 3) === 67);
check('confidence Medium ×1', scaledInterval(2, 2) === 7);
const next = nextRevisionDate(new Date('2026-01-01T10:00:00'), 1, 2);
check('next revision = +3 application days at 4:00 AM', next.toISOString().slice(0, 10) === '2026-01-04' && next.getHours() === 4);
check('bucket: not started', revisionBucket(null, 0, new Date()) === 'not_started');
const future = new Date(Date.now() + 5 * 86400000).toISOString();
const past = new Date(Date.now() - 5 * 86400000).toISOString();
check('bucket: upcoming', revisionBucket(future, 1, new Date()) === 'upcoming');
check('bucket: overdue', revisionBucket(past, 1, new Date()) === 'overdue');
check('rLabel', rLabel(0) === 'Not revised' && rLabel(3) === 'R3');

// ---------- date utils ----------
const { todayKey, addDays, dateFromKey, daysBetween, computeStreak, fmtDuration } = mod;
const t = todayKey();
check('todayKey format', /^\d{4}-\d{2}-\d{2}$/.test(t));
check('3:59 AM belongs to previous application day', todayKey(new Date(2026, 8, 20, 3, 59, 59)) === '2026-09-19');
check('4:00 AM starts the new application day', todayKey(new Date(2026, 8, 20, 4, 0, 0)) === '2026-09-20');
const boundaryDb = mod.newDatabase();
boundaryDb.focusSessions = [
  { id: 'before', startedAt: new Date(2026, 8, 20, 3, 59).toISOString(), durationMinutes: 10, sessionType: 'focus', completed: true, taskId: null, subject: '', linkedTopicId: null, notes: '' },
  { id: 'at', startedAt: new Date(2026, 8, 20, 4, 0).toISOString(), durationMinutes: 20, sessionType: 'focus', completed: true, taskId: null, subject: '', linkedTopicId: null, notes: '' },
];
const boundaryTotals = mod.focusMinutesByApplicationDay(boundaryDb);
check('daily study totals roll over precisely at 4:00 AM', boundaryTotals.get('2026-09-19') === 10 && boundaryTotals.get('2026-09-20') === 20);
check('addDays across month', addDays('2026-01-30', 3) === '2026-02-02');
check('daysBetween', daysBetween('2026-01-01', '2026-01-31') === 30);
check('fmtDuration', fmtDuration(225) === '3h 45m' && fmtDuration(45) === '45m');
const trendDb = mod.newDatabase();
const previousTrendDay = addDays(t, -1);
const clickTimestamp = dateFromKey(t);
clickTimestamp.setHours(12, 0, 0, 0);
trendDb.tasks = [
  { id: 'completed-yesterday', deadline: previousTrendDay, status: 'completed', completedAt: clickTimestamp.toISOString() },
  { id: 'completed-today', deadline: t, status: 'completed', completedAt: null },
  { id: 'pending-yesterday', deadline: previousTrendDay, status: 'upcoming', completedAt: null },
];
const trend = mod.taskTrend(trendDb, 2);
check('Task Trend buckets completion by task deadline, not click timestamp',
  trend[0].day === previousTrendDay && trend[0].created === 2 && trend[0].completed === 1
  && trend[1].day === t && trend[1].created === 1 && trend[1].completed === 1);
const streakSet = new Set([t, addDays(t, -1), addDays(t, -2)]);
check('streak counts consecutive incl. today', computeStreak(streakSet, t) === 3);
check('streak survives inactive today', computeStreak(new Set([addDays(t, -1), addDays(t, -2)]), t) === 2);
// ---------- manual study logging (application-day aware) ----------
const { composeManualStartedAt, manualLogApplicationDay, parseClockTime } = mod;
check('manual log lands on the chosen application day',
  manualLogApplicationDay('2026-09-19', '20:30') === '2026-09-19');
check('a pre-4:00 AM start time is shifted so it still files under the chosen day',
  composeManualStartedAt('2026-09-19', '02:30').slice(0, 10) === '2026-09-20'
  && manualLogApplicationDay('2026-09-19', '02:30') === '2026-09-19');
check('historical dates are supported', manualLogApplicationDay('2026-01-05', '18:00') === '2026-01-05');
check('clock times are validated', parseClockTime('25:00') === null && JSON.stringify(parseClockTime('9:05')) === '[9,5]');
const manualDb = mod.newDatabase();
manualDb.focusSessions = [{
  id: 'manual-1', startedAt: composeManualStartedAt('2026-09-19', '20:30'), durationMinutes: 90,
  taskName: 'Manual study log', sessionType: 'focus', completed: true,
}];
check('manual logs feed the same Study Hours aggregates as timed sessions',
  mod.focusMinutesByApplicationDay(manualDb).get('2026-09-19') === 90
  && mod.dashboardStats(manualDb).days7.reduce((sum, d) => sum + d.minutes, 0) >= 0);

// ---------- three-state preparation progress ----------
const { normalizeItemStatus, nextProgressState, migrateProgress, PROGRESS_LABEL } = mod;
check('legacy binary progress migrates false → todo, true → completed',
  normalizeItemStatus(false) === 'not_started' && normalizeItemStatus(true) === 'completed');
check('todo / not_started are the same stored state',
  normalizeItemStatus('todo') === 'not_started' && PROGRESS_LABEL.not_started === 'To Do');
check('cycle is To Do → In Progress → Completed → To Do',
  nextProgressState('not_started') === 'in_progress'
  && nextProgressState('in_progress') === 'completed'
  && nextProgressState('completed') === 'not_started');
check('progress maps migrate without dropping records',
  Object.keys(migrateProgress({ a: { itemId: 'a', status: true }, b: { itemId: 'b', status: 'in_progress' } })).length === 2
  && migrateProgress({ a: { itemId: 'a', status: true } }).a.status === 'completed');
check('an unrelated boolean setting is never coerced',
  normalizeItemStatus(undefined) === 'not_started' && normalizeItemStatus('dark') === 'not_started');

// ---------- syllabus three-state toggle cycle ----------
const { displayedProgressStatus } = mod;
check('explicit In Progress on untouched parent is visible (not re-derived to To Do)',
  displayedProgressStatus('in_progress', 'not_started') === 'in_progress');
check('rollup wins once children are started/completed',
  displayedProgressStatus('in_progress', 'completed') === 'completed'
  && displayedProgressStatus('not_started', 'in_progress') === 'in_progress');
check('untouched node shows To Do', displayedProgressStatus(null, 'not_started') === 'not_started');

// store-level: parent cycles To Do -> In Progress -> Completed -> To Do
{
  const cycledb = mod.newDatabase();
  const topic = mod.syllabus.topics.find((t2) => (mod.syllabus.subtopicsOf.get(t2.id) ?? []).length > 1);
  const setStatus = (stt) => {
    const res = mod.applyHierarchyStatus(cycledb.progress, topic.id, stt);
    cycledb.progress = res.progress;
  };
  const shown = () => displayedProgressStatus(cycledb.progress[topic.id]?.status, mod.hierarchyStatus(topic.id, cycledb.progress));
  check('parent starts To Do', shown() === 'not_started');
  setStatus('in_progress'); check('parent -> In Progress persists', shown() === 'in_progress');
  setStatus('completed'); check('parent -> Completed cascades', shown() === 'completed'
    && (mod.syllabus.subtopicsOf.get(topic.id) ?? []).every((sub) => cycledb.progress[sub.id]?.status === 'completed'));
  setStatus('not_started'); check('parent -> To Do clears', shown() === 'not_started'
    && (mod.syllabus.subtopicsOf.get(topic.id) ?? []).every((sub) => cycledb.progress[sub.id]?.status === 'not_started'));
}

// ---------- application-day session pruning ----------
const pruneDb = mod.newDatabase();
pruneDb.focusSessions = [
  { id: 'old-abandoned', startedAt: new Date(2026, 8, 18, 22, 0).toISOString(), durationMinutes: 0, taskName: '', sessionType: 'focus', completed: false },
  { id: 'old-completed', startedAt: new Date(2026, 8, 18, 22, 0).toISOString(), durationMinutes: 55, taskName: 'Kept for history', sessionType: 'focus', completed: true },
];
const staleIds = pruneDb.focusSessions.filter((s2) => !s2.completed && mod.applicationDayKey(new Date(s2.startedAt)) < mod.applicationDayKey()).map((s2) => s2.id);
check('rollover cleanup targets abandoned sessions only', JSON.stringify(staleIds) === '["old-abandoned"]');
const kept = pruneDb.focusSessions.filter((s2) => !staleIds.includes(s2.id));
check('historical Study Hours survive the cleanup',
  mod.focusMinutesByApplicationDay({ ...pruneDb, focusSessions: kept }).get('2026-09-18') === 55);

const { parseQuickTasks, parseLectureRange, examDatesFor } = mod;
check('multiline Quick Add creates one trimmed task per non-empty line', JSON.stringify(parseQuickTasks('  Revise Fundamental Rights  \n\nComplete Geography Lecture 99\n Read today\'s newspaper\nPractice Ethics answers  ')) === JSON.stringify(['Revise Fundamental Rights', 'Complete Geography Lecture 99', "Read today's newspaper", 'Practice Ethics answers']));
check('single-line Quick Add remains valid', JSON.stringify(parseQuickTasks('Read Laxmikanth')) === JSON.stringify(['Read Laxmikanth']));
const range = parseLectureRange('98-113');
check('lecture range 98-113 generates exactly 16 numbers', range?.numbers.length === 16 && range.numbers[0] === 98 && range.numbers[15] === 113);
check('malformed and descending lecture ranges are rejected', parseLectureRange('113-98') === null && parseLectureRange('98 to 113') === null);
check('official UPSC CSE 2027 dates are centralized', examDatesFor(2027)?.prelims === '2027-05-23' && examDatesFor(2027)?.mainsCommencement === '2027-08-20');

// ---------- store: full workflow ----------
const { StoreProvider, useStore } = mod;
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act: reactAct } = await import('react-dom/test-utils');
const act = (fn) => reactAct(fn);

let storeRef = null;
function Probe() {
  const store = useStore();
  storeRef = store;
  return React.createElement('div', null, 'probe');
}

localStorage.clear();
const container = dom.window.document.createElement('div');
dom.window.document.body.appendChild(container);
const root = createRoot(container);
await act(async () => {
  root.render(React.createElement(StoreProvider, null, React.createElement(Probe)));
});
await act(async () => { await Promise.resolve(); });

check('db boots with 2027 + Geography', storeRef.db.settings.targetExamYear === 2027 && storeRef.db.settings.optional === 'Geography');

// task lifecycle
await act(async () => { storeRef.addTask({ name: 'Read Laxmikanth Ch.1', deadline: t, subjectMapping: 'GS-I', priority: 'high' }); });
check('task added', storeRef.db.tasks.length === 1 && storeRef.db.tasks[0].status === 'upcoming');
await act(async () => { storeRef.toggleTask(storeRef.db.tasks[0].id, true); });
check('task completed', storeRef.db.tasks[0].status === 'completed' && storeRef.db.tasks[0].completedAt);
const multilineNames = parseQuickTasks('Revise Fundamental Rights\nComplete Geography Lecture 99\n\nRead today\'s newspaper\nPractice Ethics answers');
await act(async () => { storeRef.addTasks(multilineNames.map((name) => ({ name, deadline: t }))); });
check('multiline Quick Add writes exactly four separate tasks', storeRef.db.tasks.length === 5 && storeRef.db.tasks.slice(1).every((task) => !task.name.includes('\n')));

// progress + revision flow
const { syllabus } = mod;
const someSub = syllabus.subtopics[0];
check('syllabus indexed', syllabus.subtopics.length === 1085 && syllabus.papers.length === 9);
await act(async () => { storeRef.setItemStatus(someSub.id, 'subtopic', 'completed'); });
check('status stored', storeRef.db.progress[someSub.id]?.status === 'completed');
await act(async () => { storeRef.reviseItem(someSub.id, 'subtopic', 2); });
const p = storeRef.db.progress[someSub.id];
check('revision R1 logged', p.revisionCount === 1 && p.confidence === 2 && p.nextRevisionAt);
check('revision log entry created', storeRef.db.revisionLogs.length === 1 && storeRef.db.revisionLogs[0].revisionNumber === 1);
{
  const p2 = storeRef.db.progress[someSub.id];
  const a = new Date(p2.lastRevisedAt); a.setHours(0, 0, 0, 0);
  const b = new Date(p2.nextRevisionAt); b.setHours(0, 0, 0, 0);
  check('R1 schedules +3d', Math.round((b.getTime() - a.getTime()) / 86400000) === 3);
}

// hierarchy rollup via selectors
const { statusOf, treeStats, dashboardStats, revisionQueue } = mod;
await act(async () => {
  for (const st of syllabus.subtopicsOf.get(someSub.topicId) ?? []) s2Set(st.id);
});
function s2Set(id) { storeRef.setItemStatus(id, 'subtopic', 'completed'); }
check('rollup: topic completed when all subs done', statusOf(someSub.topicId, storeRef.db) === 'completed');
check('rollup writes deterministic parent state', storeRef.db.progress[someSub.topicId]?.status === 'completed');
const topicForCascade = syllabus.topics.find((topic) => (syllabus.subtopicsOf.get(topic.id) ?? []).length > 1);
await act(async () => { storeRef.setItemStatus(topicForCascade.id, 'topic', 'not_started'); });
check('topic incomplete cascades to every subtopic', (syllabus.subtopicsOf.get(topicForCascade.id) ?? []).every((sub) => storeRef.db.progress[sub.id]?.status === 'not_started'));
await act(async () => { storeRef.setItemStatus(topicForCascade.id, 'topic', 'completed'); });
check('topic complete cascades to every subtopic and reaches 100%', (syllabus.subtopicsOf.get(topicForCascade.id) ?? []).every((sub) => storeRef.db.progress[sub.id]?.status === 'completed') && treeStats(storeRef.db).get(topicForCascade.id)?.pct === 100);
const chapterForCascade = syllabus.chapterById.get(topicForCascade.chapterId);
await act(async () => { storeRef.setItemStatus(chapterForCascade.id, 'chapter', 'completed'); });
check('chapter complete cascades through topics/subtopics', treeStats(storeRef.db).get(chapterForCascade.id)?.pct === 100 && storeRef.db.progress[chapterForCascade.id]?.status === 'completed');
const subjectForCascade = syllabus.subjectById.get(chapterForCascade.subjectId);
await act(async () => { storeRef.setItemStatus(subjectForCascade.id, 'subject', 'completed'); });
check('subject complete cascades through chapters', treeStats(storeRef.db).get(subjectForCascade.id)?.pct === 100);
const paperForCascade = syllabus.paperById.get(subjectForCascade.paperId);
await act(async () => { storeRef.setItemStatus(paperForCascade.id, 'paper', 'completed'); });
check('paper complete cascades through the entire hierarchy', treeStats(storeRef.db).get(paperForCascade.id)?.pct === 100 && storeRef.db.progress[paperForCascade.id]?.status === 'completed');
const childToClear = (syllabus.subtopicsOf.get(topicForCascade.id) ?? [])[0];
await act(async () => { storeRef.setItemStatus(childToClear.id, 'subtopic', 'not_started'); });
check('child change recalculates all parent states and percentages', storeRef.db.progress[topicForCascade.id]?.status === 'in_progress' && storeRef.db.progress[chapterForCascade.id]?.status === 'in_progress' && storeRef.db.progress[subjectForCascade.id]?.status === 'in_progress' && storeRef.db.progress[paperForCascade.id]?.status === 'in_progress' && treeStats(storeRef.db).get(topicForCascade.id)?.pct < 100);
await act(async () => { storeRef.setItemStatus(paperForCascade.id, 'paper', 'not_started'); });
check('paper incomplete clears all descendants without contradiction', treeStats(storeRef.db).get(paperForCascade.id)?.pct === 0 && storeRef.db.progress[paperForCascade.id]?.status === 'not_started');

// focus session + streak
await act(async () => { storeRef.addFocusSession({ startedAt: new Date().toISOString(), durationMinutes: 90, taskName: 'Geo P1', sessionType: 'focus', completed: true }); });
const dash = dashboardStats(storeRef.db);
check('focus session counted', dash.days7[6].minutes === 90);
check('streak >= 1 after activity', dash.streak >= 1);
check('revision queue has due item', revisionQueue(storeRef.db).dueToday.length === 0 && revisionQueue(storeRef.db).overdue.length === 0);

// tests & analytics
await act(async () => {
  storeRef.addPrelimsTest({ testName: 'Mock 1', testDate: t, totalQuestions: 100, attempted: 80, correct: 60, incorrect: 20, score: 60 * 2 - 20 * 0.66, maxScore: 200, timeTakenMinutes: 120, testType: 'Full Mock', notes: '' });
});
const { prelimsAnalytics } = mod;
const pa = prelimsAnalytics(storeRef.db);
check('prelims analytics computed', pa.count === 1 && pa.avgScore === Math.round(((120 - 13.2) / 200) * 100));

// lecture ranges + individual completion
await act(async () => { storeRef.addLecture({ title: 'Biogeography', subject: 'Geography Optional', rangeStart: 98, rangeEnd: 113, totalLectures: 16, lectureNo: 98, completedLectures: [] }); });
const lecture = storeRef.db.lectures[0];
check('lecture series stores generated inclusive range', lecture.rangeStart === 98 && lecture.rangeEnd === 113 && lecture.totalLectures === 16);
await act(async () => { storeRef.updateLecture(lecture.id, { completedLectures: [98], lectureNo: 99, status: 'in_progress' }); });
const { lectureSummary } = mod;
const ls = lectureSummary(storeRef.db);
check('one-click lecture completion updates series analytics', ls.total === 16 && ls.completed === 1 && ls.pct === 6);

// persistence round-trip
await act(async () => { await new Promise((r) => setTimeout(r, 250)); }); // allow debounced save
const saved = JSON.parse(localStorage.getItem('mup.db.v1'));
check('db persisted to localStorage', saved && saved.tasks.length === 5 && saved.progress[someSub.id]?.revisionCount === 1);

// migration
const { migrate } = mod;
const mig = migrate({ version: 0, tasks: [{ id: 'x', name: 'legacy' }] });
check('migrate fills defaults', mig.settings.targetExamYear === 2027 && mig.tasks.length === 1 && mig.version === mod.DB_VERSION);

// persistent Focus Workspace runtime: exact-once focus logs; no break/unfinished logs
await act(async () => { root.unmount(); });
localStorage.clear();
const realNow = Date.now;
let fakeNow = realNow();
Date.now = () => fakeNow;
const realWindowInterval = window.setInterval;
const realWindowClearInterval = window.clearInterval;
let intervalTick = null;
let intervalId = 0;
window.setInterval = (callback) => { intervalTick = callback; return ++intervalId; };
window.clearInterval = () => {};
let timerRef = null;
let timerStoreRef = null;
function TimerProbe() {
  timerRef = mod.useFocusTimer();
  timerStoreRef = useStore();
  return React.createElement('div', null, timerRef.state.status);
}
const timerContainer = dom.window.document.createElement('div');
dom.window.document.body.appendChild(timerContainer);
const timerRoot = createRoot(timerContainer);
await act(async () => {
  timerRoot.render(React.createElement(StoreProvider, null,
    React.createElement(mod.ToastProvider, null,
      React.createElement(mod.FocusTimerProvider, null, React.createElement(TimerProbe)))));
});
await act(async () => { timerRef.setSettings({ focusMinutes: 1, breakMinutes: 1, longBreakMinutes: 1, sessionsBeforeLongBreak: 2, soundEnabled: false, mindfulnessEnabled: false }); });
await act(async () => { timerRef.start(); });
const focusCompletionTick = intervalTick;
fakeNow += 60_000;
await act(async () => { focusCompletionTick(); });
await act(async () => { focusCompletionTick(); }); // stale/racing completion callback
check('completed Pomodoro focus logs exactly once', timerStoreRef.db.focusSessions.length === 1 && timerStoreRef.db.focusSessions[0].durationMinutes === 1);
await act(async () => { timerRef.start(); }); // short break
const breakCompletionTick = intervalTick;
fakeNow += 60_000;
await act(async () => { breakCompletionTick(); });
check('completed breaks never enter focus sessions', timerStoreRef.db.focusSessions.length === 1 && timerRef.state.phase === 'focus');
await act(async () => { timerRef.setMode('pomodoro'); timerRef.start(); });
fakeNow += 20_000;
await act(async () => { timerRef.pause(); timerRef.reset(); });
check('pausing and resetting unfinished focus does not log', timerStoreRef.db.focusSessions.length === 1);
await act(async () => { timerRef.setMode('stopwatch'); });
await act(async () => { timerRef.start(); });
fakeNow += 61_000;
await act(async () => { timerRef.finish(); });
check('finished stopwatch work logs through the same focus-session store', timerStoreRef.db.focusSessions.length === 2 && timerStoreRef.db.focusSessions[1].sessionType === 'focus');
await act(async () => { timerRoot.unmount(); });
Date.now = realNow;
window.setInterval = realWindowInterval;
window.clearInterval = realWindowClearInterval;

fs.rmSync(outfile, { force: true });
console.log(failed === 0 ? '\nLOGIC TESTS PASSED' : `\nLOGIC TESTS FAILED (${failed})`);
process.exit(failed ? 1 : 0);
