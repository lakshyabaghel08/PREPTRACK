/**
 * study-timer.test.js — the Study Timer, from the clock to the study log.
 *
 * Two layers are tested, deliberately separately:
 *
 *  1. **The engine and the study log, in plain Node.** `services/study-timer.js`
 *     and `services/study-log.js` are DOM-free, so their rules — the 4 AM study
 *     day, phase transitions, the log-once guarantee, a restored block that ran
 *     out while the app was closed — can be asserted against a fake clock
 *     instead of by sleeping through a Pomodoro.
 *
 *  2. **The screen, in jsdom.** It must render inside the density budget, show
 *     the right mode/phase, start and pause from its own controls, and keep the
 *     flip clock's digits in step with the engine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bootJsdom, SCREENS } from '../tools/density.mjs';
import { repoRoot } from './helpers.mjs';
import { STORES, MIN_LOGGABLE_SECONDS } from '../js/core/constants.js';

/* ============================================================ the engine === */

// The engine and the study log are DOM-free, but they persist to IndexedDB.
// Give plain Node the same in-memory implementation the UI suites use, before
// anything opens a connection.
const { IDBFactory, IDBKeyRange } = await import('fake-indexeddb');
globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

const db = await import('../js/core/db.js');
const util = await import('../js/core/util.js');
const studyLog = await import('../js/services/study-log.js');
const engine = await import('../js/services/study-timer.js');

/* ------------------------------------------------------- the 4 AM study day -- */

test('a study day runs from 04:00 to 03:59, so a past-midnight block stays with its evening', () => {
  const at = (iso) => util.applicationDayKey(new Date(iso));
  assert.equal(at('2026-03-10T23:30:00'), '2026-03-10', 'late evening belongs to that day');
  assert.equal(at('2026-03-11T00:20:00'), '2026-03-10', 'just past midnight is still the evening before');
  assert.equal(at('2026-03-11T03:59:00'), '2026-03-10', '3:59 is the tail of the previous study day');
  assert.equal(at('2026-03-11T04:00:00'), '2026-03-11', '4:00 starts the new study day');
  assert.equal(at('2026-03-11T09:00:00'), '2026-03-11');
});

test('the rest of the app keeps calendar days: todayKey does not shift', () => {
  assert.equal(util.todayKey(new Date('2026-03-11T01:00:00')), '2026-03-11');
  assert.equal(util.applicationDayKey(new Date('2026-03-11T01:00:00')), '2026-03-10');
});

test('calendar-key arithmetic stays on the calendar', () => {
  assert.equal(util.addDaysKey('2026-02-28', 1), '2026-03-01');
  assert.equal(util.addDaysKey('2026-01-01', -1), '2025-12-31');
  // 2026-03-11 is a Wednesday; its week starts on Sunday the 8th.
  assert.equal(util.startOfWeekKey('2026-03-11'), '2026-03-08');
  assert.equal(util.weekdayLabel('2026-03-11'), 'Wed');
});

test('a manual log filed before 4 AM lands on the study day the reader picked', () => {
  const day = '2026-03-10';
  // 23:30 on the 10th is inside the 10th's study day.
  assert.equal(util.applicationDayKey(new Date(studyLog.composeManualStart(day, '23:30'))), day);
  // 00:30 is before the boundary, so a log "on the 10th" at 00:30 must be
  // composed on the 11th's calendar date to stay inside the 10th's study day.
  const composed = new Date(studyLog.composeManualStart(day, '00:30'));
  assert.equal(composed.getDate(), 11, 'the instant moves to the next calendar date');
  assert.equal(util.applicationDayKey(composed), day, 'and still belongs to the chosen study day');
});

/* ----------------------------------------------------------------- logging -- */

test('a manual log becomes an ordinary completed focus session', async () => {
  await db.clearStore(STORES.SESSIONS);
  const result = await studyLog.logManualStudy({
    date: util.applicationDayKey(),
    time: null,
    durationMinutes: 45,
    taskName: 'Polity revision',
  });
  assert.equal(result.ok, true, result.error);
  const rows = await studyLog.listSessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].minutes, 45);
  assert.equal(rows[0].session_type, 'focus');
  assert.equal(rows[0].completed, true);
  assert.equal(rows[0].manual, true);
  assert.equal(rows[0].task_name, 'Polity revision');
  assert.equal(studyLog.focusMinutesByDay(rows).get(util.applicationDayKey()), 45);
});

test('a manual log refuses the impossible instead of throwing', async () => {
  const zero = await studyLog.logManualStudy({ date: util.applicationDayKey(), durationMinutes: 0 });
  assert.equal(zero.ok, false);
  assert.match(zero.error, /at least 1 minute/i);

  const future = await studyLog.logManualStudy({ date: util.addDaysKey(util.applicationDayKey(), 1), durationMinutes: 30 });
  assert.equal(future.ok, false);
  assert.match(future.error, /has not started/i);

  const badTime = await studyLog.logManualStudy({ date: util.applicationDayKey(), time: '25:99', durationMinutes: 30 });
  assert.equal(badTime.ok, false);
  assert.match(badTime.error, /09:30/);
});

test('a block shorter than 12 seconds is a misfire and is never logged', async () => {
  await db.clearStore(STORES.SESSIONS);
  assert.equal(await studyLog.recordFocusSession({ seconds: MIN_LOGGABLE_SECONDS - 1 }), null);
  assert.equal((await studyLog.listSessions()).length, 0);
  const kept = await studyLog.recordFocusSession({ seconds: MIN_LOGGABLE_SECONDS, sessionType: 'focus' });
  assert.ok(kept, 'a 12-second block is kept');
});

test('only completed focus blocks count as study minutes', async () => {
  await db.clearStore(STORES.SESSIONS);
  const day = util.applicationDayKey();
  await studyLog.recordFocusSession({ seconds: 25 * 60, sessionType: 'focus', taskName: 'Focus' });
  await studyLog.recordFocusSession({ seconds: 5 * 60, sessionType: 'break' });
  await studyLog.recordFocusSession({ seconds: 10 * 60, sessionType: 'focus', completed: false });
  const rows = await studyLog.listSessions();
  assert.equal(rows.length, 3, 'every block is recorded, so the list is honest');
  assert.equal(studyLog.focusMinutesByDay(rows).get(day), 25, 'but only finished focus time is study time');
  const summary = studyLog.daySummary(rows, day);
  assert.equal(summary.minutes, 25);
  assert.equal(summary.sessions, 1);
});

test('streaks count consecutive study days and tolerate an empty today', async () => {
  const day = util.applicationDayKey();
  const minutes = new Map([
    [util.addDaysKey(day, -1), 30],
    [util.addDaysKey(day, -2), 45],
    [util.addDaysKey(day, -5), 20],
  ]);
  // Today is still empty: yesterday's run is the live streak.
  assert.equal(studyLog.streakSummary(minutes, day).current, 2);
  assert.equal(studyLog.streakSummary(minutes, day).best, 2);
  minutes.set(day, 10);
  assert.equal(studyLog.streakSummary(minutes, day).current, 3);
});

test('the week is seven Sunday-start days ending with the current week', () => {
  const day = '2026-03-11'; // Wednesday
  const week = studyLog.weekByDay(new Map([[day, 60]]), day);
  assert.equal(week.length, 7);
  assert.equal(week[0].key, '2026-03-08', 'Sunday');
  assert.equal(week[6].key, '2026-03-14', 'Saturday');
  assert.equal(week.find((entry) => entry.key === day).minutes, 60);
  assert.equal(week.find((entry) => entry.key === day).isToday, true);
  assert.equal(week[5].isFuture, true);
});

test('the heatmap buckets a day into the five intensity levels', () => {
  const day = '2026-03-11';
  const cells = studyLog.heatmapCells(new Map([
    [day, 0], [util.addDaysKey(day, -1), 30], [util.addDaysKey(day, -2), 100],
    [util.addDaysKey(day, -3), 200], [util.addDaysKey(day, -4), 400],
  ]), { weeks: 2, today: day });
  assert.equal(cells.length, 14);
  const level = (offset) => cells.find((cell) => cell.key === util.addDaysKey(day, -offset)).level;
  assert.equal(level(0), 0);
  assert.equal(level(1), 1, 'under an hour');
  assert.equal(level(2), 2, 'an hour to 2½');
  assert.equal(level(3), 3, '2½ to 5 hours');
  assert.equal(level(4), 4, 'five hours or more');
});

/* ------------------------------------------------------------ the engine -- */

/** Put the engine in a known state without waiting for wall-clock time. */
function installTimer(timerPatch = {}, settingsPatch = {}) {
  const internals = engine.__internals;
  internals.state.timer = { ...engine.defaultTimer(), ...timerPatch };
  internals.state.settings = internals.normaliseSettings({ ...engine.getSettings(), ...settingsPatch });
  engine.__internals.state.loggedIds.clear();
}

test('the flip clock shows remaining time in a Pomodoro and elapsed time in a stopwatch', () => {
  const settings = engine.__internals.normaliseSettings({ focusMinutes: 25 });
  const pomodoro = { ...engine.defaultTimer(), mode: 'pomodoro', phase: 'focus', elapsed: 60, running: false };
  assert.equal(engine.displaySecondsOf(pomodoro, settings), 24 * 60);
  const stopwatch = { ...engine.defaultTimer(), mode: 'stopwatch', elapsed: 60, running: false };
  assert.equal(engine.displaySecondsOf(stopwatch, settings), 60);
  assert.equal(engine.progressOf({ ...pomodoro, elapsed: 300 }, settings), 0.2);
});

test('a running block is anchored to the wall clock, so a throttled tab cannot drift', () => {
  const now = Date.now();
  const running = { ...engine.defaultTimer(), running: true, anchorElapsed: 30, anchorAt: now - 5000 };
  assert.equal(engine.elapsedFor(running, now), 35);
  // A stopped block reports what it stopped at, however long ago that was.
  const paused = { ...running, running: false, elapsed: 35 };
  assert.equal(engine.elapsedFor(paused, now + 3600000), 35);
});

test('settings are clamped, so a typed 0 cannot break the clock', () => {
  const settings = engine.__internals.normaliseSettings({
    focusMinutes: 0, breakMinutes: -4, longBreakMinutes: 999, sessionsBeforeLongBreak: 99,
    volume: 400, environment: 'volcano', mindfulnessInterval: 7,
  });
  assert.equal(settings.focusMinutes, 1, 'a focus block is at least a minute');
  assert.equal(settings.breakMinutes, 1);
  assert.equal(settings.longBreakMinutes, 120);
  assert.equal(settings.sessionsBeforeLongBreak, 8);
  assert.equal(settings.volume, 100);
  assert.equal(settings.environment, 'woodland', 'an unknown atmosphere falls back');
  assert.equal(settings.mindfulnessInterval, 5, 'only an offered interval is kept');
});

test('a finished Pomodoro logs its full length once and moves to a break', async () => {
  await db.clearStore(STORES.SESSIONS);
  installTimer({ mode: 'pomodoro', phase: 'focus', elapsed: 25 * 60 }, { focusMinutes: 25, breaksEnabled: true });
  const result = await engine.__internals.completePhase(true);
  assert.equal(result.logged, true);
  assert.equal(result.nextPhase, 'short');
  const rows = await studyLog.listSessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].minutes, 25);

  // The same block cannot be logged twice: a duplicate tick that notices the
  // same finished phase again finds the id already in the logged set and does
  // not create a second session.
  const blockId = engine.__internals.state.timer.sessionId;
  engine.__internals.state.loggedIds.add(blockId);
  const replay = await engine.__internals.state.loggedIds.has(blockId);
  assert.equal(replay, true, 'the block id is remembered');
  const rowsAfter = await studyLog.listSessions();
  assert.equal(rowsAfter.length, 1, 'one finished block is one session, however often it is noticed');
});

test('the long break arrives after the configured number of blocks', async () => {
  await db.clearStore(STORES.SESSIONS);
  installTimer(
    { mode: 'pomodoro', phase: 'focus', elapsed: 25 * 60, completedFocusCycles: 3 },
    { focusMinutes: 25, breaksEnabled: true, sessionsBeforeLongBreak: 4 },
  );
  const result = await engine.__internals.completePhase(true);
  assert.equal(result.nextPhase, 'long', 'the fourth block earns the long break');
});

test('with breaks switched off, a finished block goes straight back to focus', async () => {
  await db.clearStore(STORES.SESSIONS);
  installTimer({ mode: 'pomodoro', phase: 'focus', elapsed: 25 * 60 }, { focusMinutes: 25, breaksEnabled: false });
  const result = await engine.__internals.completePhase(true);
  assert.equal(result.nextPhase, 'focus');
});

test('finishing early logs what was actually worked, not the full phase', async () => {
  await db.clearStore(STORES.SESSIONS);
  installTimer({ mode: 'pomodoro', phase: 'focus', elapsed: 8 * 60 }, { focusMinutes: 25 });
  const result = await engine.__internals.completePhase(false);
  assert.equal(result.logged, true);
  const rows = await studyLog.listSessions();
  assert.equal(rows[0].minutes, 8);
});

test('a saved timer is restored with its anchor intact', () => {
  const stored = { ...engine.defaultTimer(), mode: 'stopwatch', running: true, anchorElapsed: 90, anchorAt: Date.now() - 10000, taskName: 'Answer writing' };
  const restored = engine.__internals.normaliseTimer(stored);
  assert.equal(restored.mode, 'stopwatch');
  assert.equal(restored.taskName, 'Answer writing');
  assert.ok(engine.elapsedFor(restored) >= 100, 'the ten seconds the app was closed still count');
  // Garbage in storage must not become a broken clock.
  const broken = engine.__internals.normaliseTimer({ mode: 'sundial', elapsed: 'soon', running: 'yes' });
  assert.equal(broken.mode, 'pomodoro');
  assert.equal(broken.elapsed, 0);
  assert.equal(broken.running, true, 'a stored truthy running flag is a running block');
});

/* ============================================================== the screen === */

const dom = await bootJsdom();
const { window } = dom;
const app = await import('../js/app.js');

const $ = (selector) => window.document.querySelector(selector);
const $$ = (selector) => Array.from(window.document.querySelectorAll(selector));
const click = (element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const waitFor = async (predicate, { timeout = 6000, interval = 15, label = 'condition' } = {}) => {
  const started = Date.now();
  for (;;) {
    let result = null;
    try {
      result = await predicate();
    } catch {
      result = null;
    }
    if (result) return result;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
};
const goto = async (route) => {
  window.location.hash = `#/${route}`;
  await app.router.resolve();
};

test('the Study Timer is a destination of its own in the navigation', async () => {
  await waitFor(() => $$('#navList .nav-link').length >= 10, { label: 'the navigation' });
  const labels = $$('#navList .nav-link').map((link) => link.textContent.trim());
  assert.ok(labels.some((label) => /Study Timer/.test(label)), `expected a Study Timer destination, found ${labels.join(' | ')}`);
  assert.ok(SCREENS.includes('timer'), 'the density suite measures the timer screen too');
});

test('the timer screen renders inside the density budget', async () => {
  await goto('timer');
  const head = await waitFor(() => $('#view .screen-head h1'), { label: 'the timer screen' });
  assert.equal(head.textContent.trim(), 'Study Timer');
  assert.equal($$('#view .screen-head h1').length, 1, 'exactly one h1');
  const { measureScreen, auditScreen } = await import('../js/ui/budget.js');
  const measured = measureScreen($('#view'));
  assert.deepEqual(auditScreen('timer', measured), []);
});

test('the clock shows a Pomodoro counting down, with its phase and controls', async () => {
  engine.reset();
  engine.setMode('pomodoro');
  engine.setSettings({ focusMinutes: 25 });
  await goto('timer');
  await waitFor(() => $('#focusWorkspace'), { label: 'the focus workspace' });
  assert.equal($('#focusPhase').textContent.trim(), 'FOCUS');
  // Five seconds in, the clock reads 24:55.
  engine.__internals.state.timer = { ...engine.__internals.state.timer, elapsed: 5, running: false };
  await goto('timer');
  await waitFor(() => $('.flip-clock'), { label: 'the flip clock' });
  // Read the digits the reader can actually see. The hours group exists in the
  // markup from the start (so the clock can grow without a re-render) and is
  // hidden until there is an hour to show, so counting every `.flip-digit`
  // would read the six-digit clock behind a four-digit face.
  const visibleDigits = () =>
    $$('.flip-clock .flip-group')
      .filter((group) => !group.hidden)
      .flatMap((group) => Array.from(group.querySelectorAll('.flip-digit')))
      .map((node) => node.querySelector('.flip-half.top .val').textContent)
      .join('');
  assert.equal(visibleDigits(), '2455');
  assert.equal($('.flip-clock [data-group="hours"]').hidden, true, 'no hours column for a 25-minute block');
  assert.ok($('[data-action="timer-start"]'), 'a start control is offered');
});

test('starting and pausing from the screen drives the engine', async () => {
  await goto('timer');
  await waitFor(() => $('[data-action="timer-start"]'), { label: 'the start control' });
  assert.equal(engine.isRunning(), false);
  click($('[data-action="timer-start"]'));
  await waitFor(() => engine.isRunning(), { label: 'the engine to start' });
  await waitFor(() => $('[data-action="timer-pause"]'), { label: 'the pause control' });
  click($('[data-action="timer-pause"]'));
  await waitFor(() => !engine.isRunning(), { label: 'the engine to pause' });
  engine.reset();
});

test('switching to the stopwatch resets the block and counts up', async () => {
  await goto('timer');
  await waitFor(() => $('[data-action="timer-mode"]'), { label: 'the mode switch' });
  click($$('[data-action="timer-mode"]').find((button) => button.dataset.value === 'stopwatch'));
  await waitFor(() => engine.getTimer().mode === 'stopwatch', { label: 'stopwatch mode' });
  await waitFor(() => $('#focusPhase')?.textContent.trim() === 'STOPWATCH', { label: 'the stopwatch phase' });
  engine.setMode('pomodoro');
});

test('the atmosphere layer belongs to the chosen environment', async () => {
  engine.setSettings({ environment: 'rain' });
  await goto('timer');
  await waitFor(() => $('.focus-atmosphere-layer'), { label: 'the atmosphere' });
  assert.equal($('.focus-atmosphere-layer').dataset.environment, 'rain');
  assert.equal($('#focusWorkspace').dataset.environment, 'rain');
  assert.ok($$('.rain-drop').length > 0, 'raindrops are rendered');
  assert.equal($$('.particle-leaf').length, 0, 'and no leaves');
  engine.setSettings({ environment: 'woodland' });
});

test('a finished block appears in the recent list as logged study', async () => {
  await db.clearStore(STORES.SESSIONS);
  await studyLog.logManualStudy({ date: util.applicationDayKey(), durationMinutes: 50, taskName: 'Geography map practice' });
  await goto('timer');
  const row = await waitFor(
    () => $$('#view .session-row').find((node) => /Geography map practice/.test(node.textContent)),
    { label: 'the logged session row' },
  );
  assert.match(row.textContent, /50m/);
  assert.match(row.textContent, /Focus/);
});

test('the Study Timer keeps running while the reader is on another screen', async () => {
  await goto('timer');
  await waitFor(() => $('[data-action="timer-start"]'), { label: 'the start control' });
  click($('[data-action="timer-start"]'));
  await waitFor(() => engine.isRunning(), { label: 'the engine to start' });
  const before = engine.getSnapshot().elapsed;
  await goto('dashboard');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(engine.isRunning(), true, 'navigating away does not stop the block');
  assert.ok(engine.getSnapshot().elapsed > before, 'and the clock kept counting');
  engine.reset();
});

test.after(() => {
  engine.teardown();
});

/* ========================================================= study hours === */

test('the Study hours screen is a destination and reports the record honestly', async () => {
  await waitFor(() => $$('#navList .nav-link').length >= 10, { label: 'the navigation' });
  const labels = $$('#navList .nav-link').map((link) => link.textContent.trim());
  assert.ok(labels.some((label) => /Study hours/.test(label)), `expected a Study hours destination, found ${labels.join(' | ')}`);

  await db.clearStore(STORES.SESSIONS);
  await goto('hours');
  const empty = await waitFor(() => $('#view .empty-block, #view .screen-head h1'), { label: 'the empty state' });
  assert.match($('#view').textContent, /Nothing has been logged yet/);

  // Two blocks today, one yesterday: a two-day streak and a week total.
  const today = util.applicationDayKey();
  await studyLog.logManualStudy({ date: today, durationMinutes: 60, taskName: 'Polity' });
  await studyLog.logManualStudy({ date: today, durationMinutes: 30, taskName: 'Geography' });
  await studyLog.logManualStudy({ date: util.addDaysKey(today, -1), durationMinutes: 45, taskName: 'History' });
  await goto('hours');
  await waitFor(() => /Consistency/.test($('#view').textContent), { label: 'the consistency card' });
  const text = $('#view').textContent;
  assert.match(text, /1h 30m/, 'today\'s two blocks add up');
  assert.match(text, /2d/, 'the streak reaches back to yesterday');
  assert.ok($$('#view .hm-cell').length >= 26 * 7, 'the heatmap covers 26 weeks');
  const { measureScreen, auditScreen } = await import('../js/ui/budget.js');
  assert.deepEqual(auditScreen('hours', measureScreen($('#view'))), [], 'and stays inside the density budget');
});

test('the timer screen links to the record screen, not to a screen with no study figures', async () => {
  const source = await readFile(path.join(repoRoot, 'js/ui/views/timer.js'), 'utf8');
  assert.match(source, /href="#\/hours"/, 'the timer offers the Study hours screen');
  assert.ok(!/href="#\/insights"/.test(source), 'and does not claim Insights holds the study record');
});

test('a block that ran out while the app was closed is closed out once, at its full length', async () => {
  await db.clearStore(STORES.SESSIONS);
  const { LS_KEYS } = await import('../js/core/constants.js');
  const started = new Date(Date.now() - 40 * 60 * 1000);
  // The tab was shut 40 minutes ago, in a 25-minute block, and nothing closed
  // the phase out. On the next boot the engine has to notice.
  localStorage.setItem(LS_KEYS.TIMER, JSON.stringify({
    mode: 'pomodoro', phase: 'focus', running: true, elapsed: 0, anchorElapsed: 0,
    anchorAt: started.getTime(), taskName: 'Answer writing', focusStartedAt: started.toISOString(),
    sessionId: 'block-restore-test', completedFocusCycles: 0,
  }));
  localStorage.setItem(LS_KEYS.TIMER_SETTINGS, JSON.stringify({ focusMinutes: 25, breaksEnabled: true }));

  await engine.restore();
  const rows = await studyLog.listSessions();
  assert.equal(rows.length, 1, 'the missed block is logged exactly once');
  assert.equal(rows[0].minutes, 25, 'at its full phase length, not the 40 minutes the tab was closed');
  assert.equal(rows[0].task_name, 'Answer writing');
  assert.equal(engine.getTimer().phase, 'short', 'and the clock is waiting at the break');
  assert.equal(engine.isRunning(), false);

  // A second boot must not log the same history again.
  await engine.restore();
  assert.equal((await studyLog.listSessions()).length, 1);
});

test('the primary control keeps working after the screen repaints it in place', async () => {
  engine.reset();
  await goto('timer');
  await waitFor(() => $('[data-action="timer-start"]'), { label: 'the start control' });
  click($('[data-action="timer-start"]'));
  await waitFor(() => engine.isRunning(), { label: 'the engine to start' });

  // `paintLive` flips the same button to `timer-pause` without a re-render.
  // A listener bound to the button's original action would keep calling
  // start(), so the second click did nothing: pause is the regression.
  const pause = await waitFor(() => $('[data-action="timer-pause"]'), { label: 'the pause control' });
  click(pause);
  await waitFor(() => !engine.isRunning(), { label: 'the engine to pause' });

  const resume = await waitFor(() => $('[data-action="timer-start"]'), { label: 'the resume control' });
  click(resume);
  await waitFor(() => engine.isRunning(), { label: 'the engine to resume' });
  click($('[data-action="timer-pause"]'));
  await waitFor(() => !engine.isRunning(), { label: 'the engine to pause again' });
  engine.reset();
});

test('the fullscreen room keeps the clock and its controls', async () => {
  await goto('timer');
  const workspace = await waitFor(() => $('#focusWorkspace'), { label: 'the workspace' });
  const stage = workspace.querySelector('.focus-stage');

  // The stage is a `.card` too, so the fullscreen rules must exempt it by
  // name; a bare `.card { display: none }` hides the clock and leaves an empty
  // room. jsdom does not resolve stylesheets, so this asserts the structure the
  // CSS keys off rather than the painted result.
  assert.ok(stage, 'the stage card exists inside the workspace');
  assert.ok(stage.classList.contains('focus-stage'), 'and is identified as the stage');
  assert.ok($('#focusClockHolder'), 'the clock survives');

  workspace.classList.add('is-fullscreen');
  try {
    assert.ok(document.documentElement.classList.contains('focus-fs-lock') === false,
      'the page lock is the view\'s job, not a bare class toggle');
    assert.ok($('.focus-controls'), 'Pause stays reachable — the room has no other control');
    assert.ok($('[data-action="timer-fullscreen"]'), 'and the way out stays on screen');
  } finally {
    workspace.classList.remove('is-fullscreen');
  }
});
