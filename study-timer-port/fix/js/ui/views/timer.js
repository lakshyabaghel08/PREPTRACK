/**
 * timer.js — the Study Timer workspace.
 *
 * The screen is one idea: a flip clock you can trust, and an honest record of
 * what it counted. Reading order:
 *
 *   1. **The stage** — mode switch, phase, the flip clock, what you are working
 *      on, and the controls. Everything else on the page is about the past.
 *   2. **Today** — minutes against the daily target, sessions, longest block,
 *      and the current streak.
 *   3. **This week** — a seven-column bar chart of study hours per day.
 *   4. **Settings** — durations, atmosphere, sound, mindfulness bell.
 *   5. **Recent sessions** — what was actually logged, including incomplete
 *      blocks and breaks; manual logs can be added from here.
 *
 * The engine (services/study-timer.js) owns the clock: it keeps running when
 * the reader navigates away, so this view subscribes on mount and unsubscribes
 * on cleanup. The view repaints the moving parts in place — the clock digits,
 * the caption, the progress bar, the document title — and only calls
 * `ctx.refresh()` when something structural changed (a phase completed, the
 * mode switched, a setting was saved), because a full repaint would interrupt
 * the clock's own animation.
 */

import { FOCUS_ENVIRONMENTS, FOCUS_PRESETS, MINDFULNESS_INTERVALS } from '../../core/constants.js';
import { applicationDayKey, fmtClock, weekdayLabel } from '../../core/util.js';
import {
  esc,
  card,
  screenHead,
  emptyState,
  toast,
  openModal,
  progressBar,
  icon,
} from '../components.js';
import { FlipClock, flipClockSkeleton } from '../flipclock.js';
import { renderAtmosphere, spawnMeteors } from '../focus-atmosphere.js';
import * as audio from '../focus-audio.js';
import * as timer from '../../services/study-timer.js';
import * as studyLog from '../../services/study-log.js';

/** Minutes → "3h 45m"; hours are never shown as a decimal. */
function duration(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value < 60) return `${value}m`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

const environmentLabel = (key) => ({ woodland: 'Woodland', night: 'Night', rain: 'Rain' })[key] || key;
const soundscapeLabel = (key) => ({ woodland: 'Woodland wind', night: 'Night fire', rain: 'Rainfall' })[key] || key;

/**
 * A history row is only useful if it says *what* and *how long*. Breaks and
 * unfinished blocks are kept — the point of the list is honesty, not a
 * highlight reel — but they are labelled so they are never mistaken for study.
 */
function sessionRow(row) {
  const isBreak = row.session_type === 'break';
  const completed = row.completed !== false;
  const started = row.started_at ? new Date(row.started_at) : null;
  const clock = started
    ? started.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    : '—';
  const title = row.task_name || (isBreak ? 'Break' : 'Focus study');
  const mark = isBreak ? '◇' : '◷';
  const status = !completed ? 'Stopped early' : isBreak ? 'Break' : row.manual ? 'Logged' : 'Completed';
  return `<li class="session-row">
    <span class="session-mark${isBreak ? ' is-break' : ''}" aria-hidden="true">${mark}</span>
    <span class="session-main">
      <b>${esc(title)}</b>
      <small>${esc(clock)}${row.manual ? ' · manual log' : ''}</small>
    </span>
    <span class="session-kind">${esc(isBreak ? 'Break' : 'Focus')}</span>
    <span class="session-minutes num">${esc(duration(row.minutes))}</span>
    <span class="session-status${completed && !isBreak ? ' is-complete' : ''}">${esc(status)}</span>
  </li>`;
}

/**
 * One day's bar in the week chart. Heights are CSS classes (steps of 5%), not
 * inline widths, so the chart obeys the stylesheet's rules and the tooling
 * check that forbids inline styles.
 */
function weekBar(day, maxMinutes) {
  const hours = Math.round((day.minutes / 60) * 10) / 10;
  const step = maxMinutes > 0 ? Math.max(day.minutes > 0 ? 5 : 0, Math.round((day.minutes / maxMinutes) * 20) * 5) : 0;
  return `<div class="week-day${day.isToday ? ' is-today' : ''}${day.minutes === 0 ? ' is-empty' : ''}" title="${esc(`${weekdayLabel(day.key)} ${day.key}: ${duration(day.minutes)}`)}">
    <span class="week-value">${hours ? `${hours}h` : '—'}</span>
    <span class="week-track"><i class="week-fill h-${step}" aria-hidden="true"></i></span>
    <span class="week-label">${esc(weekdayLabel(day.key))}</span>
  </div>`;
}

export default {
  title: 'Study Timer',
  eyebrow: 'Protected, uninterrupted work',
  skeleton: () => `${screenHead({ title: 'Study Timer', eyebrow: 'Protected, uninterrupted work' })}
    <div class="card"><div class="card-body">${flipClockSkeleton()}</div></div>`,

  async render() {
    // The engine holds the truth; a restored block is already counting.
    const snapshot = timer.getSnapshot();
    const timerSettings = snapshot.settings;
    const summary = await studyLog.loadStudySummary({ today: applicationDayKey() });
    const target = Math.max(0, Number(timerSettings.dailyTargetMinutes) || 0);
    const today = summary.todaySummary;
    const targetPct = target > 0 ? Math.min(100, Math.round((today.minutes / target) * 100)) : 0;
    const weekMax = Math.max(1, ...summary.week.map((day) => day.minutes));
    const weekTotal = summary.week.filter((day) => !day.isFuture).reduce((sum, day) => sum + day.minutes, 0);
    const isPomodoro = snapshot.timer.mode === 'pomodoro';

    const phaseWord =
      snapshot.timer.mode === 'stopwatch'
        ? 'STOPWATCH'
        : snapshot.timer.phase === 'focus'
          ? 'FOCUS'
          : snapshot.timer.phase === 'long'
            ? 'LONG BREAK'
            : 'BREAK';

    const controls = snapshot.timer.running
      ? `<button class="btn btn-primary focus-primary" type="button" data-action="timer-pause">Pause</button>`
      : `<button class="btn btn-primary focus-primary" type="button" data-action="timer-start">${
          snapshot.elapsed > 0 ? 'Resume' : snapshot.timer.phase === 'focus' ? 'Start focus' : 'Start break'
        }</button>`;

    const finishLabel = snapshot.timer.phase === 'focus'
      ? snapshot.timer.mode === 'stopwatch'
        ? 'Stop & log'
        : 'Finish & log'
      : 'End break';

    return `
      ${screenHead({
        title: 'Study Timer',
        eyebrow: 'Protected, uninterrupted work',
        purpose: `A flip clock for deliberate practice. Every block you finish is logged to study hours under a day that starts at 4 AM — a session past midnight belongs to the evening it began.`,
        primary: `<button class="btn btn-sm" type="button" data-action="log-manual">${icon('plus', { size: 14 })} Log study manually</button>`,
        secondary: `<a class="btn btn-sm" href="#/hours">Study hours <span aria-hidden="true">→</span></a>`,
      })}

      <section class="focus-workspace environment-${esc(timerSettings.environment)}" id="focusWorkspace" data-environment="${esc(timerSettings.environment)}" data-phase="${esc(snapshot.timer.phase)}">
        ${card({
          className: 'focus-stage',
          body: `
            <div class="focus-stage-top">
              <div class="seg focus-mode" role="group" aria-label="Timer mode">
                <button type="button" data-action="timer-mode" data-value="pomodoro" aria-pressed="${isPomodoro}">Pomodoro</button>
                <button type="button" data-action="timer-mode" data-value="stopwatch" aria-pressed="${!isPomodoro}">Stopwatch</button>
              </div>
              <span class="focus-phase" id="focusPhase">${esc(phaseWord)}</span>
              <span class="focus-sound-state">${
                timerSettings.soundEnabled ? `${icon('sound', { size: 14 })} ${esc(soundscapeLabel(timerSettings.soundscape))}` : 'Sound off'
              }</span>
            </div>

            <div class="focus-clock-holder" id="focusClockHolder">${flipClockSkeleton()}</div>
            <p class="focus-caption" id="focusCaption">${
              snapshot.timer.running
                ? 'Session in progress'
                : snapshot.elapsed > 0
                  ? 'Paused — your place is held'
                  : snapshot.timer.phase === 'focus'
                    ? 'Ready when you are'
                    : 'A deliberate pause before the next block'
            }</p>
            ${
              isPomodoro
                ? `<div class="focus-progress" role="img" aria-label="Block progress"><span id="focusProgressFill"></span></div>`
                : ''
            }

            <label class="focus-work" for="focusTask">
              <span>What are you working on? <em>optional</em></span>
              <input id="focusTask" type="text" maxlength="160" autocomplete="off" placeholder="Polity — Union Executive, Chapter 14 revision" value="${esc(snapshot.timer.taskName)}" />
            </label>

            <div class="focus-controls">
              ${controls}
              <button class="btn btn-quiet" type="button" data-action="timer-finish"${!timer.hasWorkToLog() ? ' disabled' : ''}>${esc(finishLabel)}</button>
              ${snapshot.timer.phase !== 'focus' ? '<button class="btn btn-quiet" type="button" data-action="timer-skip">Skip break</button>' : ''}
              <button class="btn btn-quiet" type="button" data-action="timer-reset"${snapshot.elapsed === 0 && !snapshot.timer.running ? ' disabled' : ''}>Reset</button>
              <button class="btn btn-quiet" type="button" data-action="timer-fullscreen" title="Distraction-free fullscreen" aria-label="Enter distraction-free fullscreen">${icon('expand', { size: 15 })} Fullscreen</button>
            </div>
          `,
        })}
      </section>

      <div class="grid cols-2 timer-metrics">
        ${card({
          title: "Today's focus",
          count: `${targetPct}%`,
          body: `
            <div class="focus-today">
              <div class="focus-total"><b>${esc(duration(today.minutes))}</b><span>of ${duration(target)} target</span></div>
              ${progressBar(target > 0 ? today.minutes / target : 0, 'ok')}
              <div class="focus-today-stats">
                <span><b>${today.sessions}</b> session${today.sessions === 1 ? '' : 's'}</span>
                <span><b>${esc(duration(today.longest))}</b> longest</span>
                <span><b>${summary.streak.current}d</b> streak${summary.streak.best > summary.streak.current ? ` <em>best ${summary.streak.best}d</em>` : ''}</span>
              </div>
            </div>
          `,
        })}
        ${card({
          title: 'This week',
          count: duration(weekTotal),
          body: `<div class="week-chart">${summary.week.map((day) => weekBar(day, weekMax)).join('')}</div>
            <p class="meta-line"><span>Study hours per day</span><span>Sunday → Saturday</span></p>`,
        })}
      </div>

      <div class="grid cols-2 timer-support">
        ${card({
          title: 'Timer & atmosphere',
          body: `
            ${
              isPomodoro
                ? `<div class="timer-setting">
                    <span class="setting-label">Focus length</span>
                    <div class="seg" role="group" aria-label="Focus duration">
                      ${FOCUS_PRESETS.map(
                        (minutes) =>
                          `<button type="button" data-action="set-focus-minutes" data-value="${minutes}" aria-pressed="${timerSettings.focusMinutes === minutes}">${minutes}m</button>`,
                      ).join('')}
                    </div>
                  </div>
                  <div class="timer-setting">
                    <label class="setting-switch"><input type="checkbox" id="setBreaks" ${timerSettings.breaksEnabled ? 'checked' : ''} /><span>Breaks between blocks</span></label>
                  </div>
                  <div class="field-row">
                    <label class="field"><span class="label-text">Break (min)</span>
                      <input type="number" id="setBreakMinutes" min="1" max="60" value="${timerSettings.breakMinutes}" />
                    </label>
                    <label class="field"><span class="label-text">Long break (min)</span>
                      <input type="number" id="setLongBreak" min="1" max="120" value="${timerSettings.longBreakMinutes}" />
                    </label>
                    <label class="field"><span class="label-text">Long break every</span>
                      <select id="setLongEvery">
                        ${[2, 3, 4, 5, 6].map((n) => `<option value="${n}"${timerSettings.sessionsBeforeLongBreak === n ? ' selected' : ''}>${n} blocks</option>`).join('')}
                      </select>
                    </label>
                  </div>`
                : `<p class="muted small m-0">A stopwatch counts up until you stop it. Everything you log lands in the same study hours as a Pomodoro block.</p>`
            }
            <div class="field-row">
              <label class="field" for="setDailyTarget"><span class="label-text">Daily focus target (minutes)</span>
                <input type="number" id="setDailyTarget" min="0" max="1440" step="30" value="${timerSettings.dailyTargetMinutes}" />
              </label>
            </div>
            <hr class="divider" />
            <div class="field-row">
              <label class="field"><span class="label-text">Atmosphere</span>
                <select id="setEnvironment">
                  ${FOCUS_ENVIRONMENTS.map((key) => `<option value="${key}"${timerSettings.environment === key ? ' selected' : ''}>${environmentLabel(key)}</option>`).join('')}
                </select>
              </label>
              <label class="field"><span class="label-text">Soundscape</span>
                <select id="setSoundscape">
                  ${FOCUS_ENVIRONMENTS.map((key) => `<option value="${key}"${timerSettings.soundscape === key ? ' selected' : ''}>${soundscapeLabel(key)}</option>`).join('')}
                </select>
              </label>
            </div>
            <label class="setting-switch"><input type="checkbox" id="setSound" ${timerSettings.soundEnabled ? 'checked' : ''} /><span>Ambient sound${audio.isAudioSupported() ? '' : ' (not available in this browser)'}</span></label>
            <label class="field" for="setVolume"><span class="label-text">Volume · ${timerSettings.volume}%</span>
              <input type="range" id="setVolume" min="0" max="100" step="5" value="${timerSettings.volume}" />
            </label>
            <label class="setting-switch"><input type="checkbox" id="setMindfulness" ${timerSettings.mindfulnessEnabled ? 'checked' : ''} /><span>Mindfulness bell</span></label>
            <label class="field"><span class="label-text">Bell interval</span>
              <select id="setBellInterval"${timerSettings.mindfulnessEnabled ? '' : ' disabled'}>
                ${MINDFULNESS_INTERVALS.map((minutes) => `<option value="${minutes}"${timerSettings.mindfulnessInterval === minutes ? ' selected' : ''}>Every ${minutes} minutes</option>`).join('')}
              </select>
            </label>
          `,
        })}

        ${card({
          title: 'Recent sessions',
          count: summary.todaySessions.length ? `${summary.todaySessions.length} today` : '',
          action: `<button class="btn btn-sm btn-quiet" type="button" data-action="log-manual">Log manually</button>`,
          body: summary.todaySessions.length
            ? `<ul class="session-list">${summary.todaySessions.map(sessionRow).join('')}</ul>`
            : emptyState({
                title: 'No sessions logged today',
                message: 'Start a block above, or add study that happened away from the timer.',
                willShow: 'Finished blocks appear here with their length and what you were working on.',
                action: `<button class="btn btn-sm btn-primary" type="button" data-action="log-manual">Log study manually</button>`,
              }),
        })}
      </div>
    `;
  },

  mount(ctx, root) {
    const workspace = root.querySelector('#focusWorkspace');
    const holder = root.querySelector('#focusClockHolder');
    let clock = null;
    let unsubscribe = null;
    // The fullscreen element is the *stage*, not the workspace. The workspace
    // also holds Today's focus, the week chart and the session list; putting it
    // fullscreen would carry all of that into the focus room. The stage is the
    // card that contains the clock, so it is the one thing that travels.
    const stage = workspace?.querySelector('.focus-stage');
    // Remembered across a repaint: `ctx.refresh()` builds a new workspace, so
    // the immersive class has to be re-applied by the next mount.
    let wantFullscreen = false;
    let meteorTimer = null;
    let lastPhaseKey = '';

    /* ---------------------------------------------------------------- clock -- */

    const clockLabel = (snapshot) =>
      snapshot.timer.mode === 'stopwatch'
        ? `${fmtClock(snapshot.displaySeconds)} elapsed`
        : `${fmtClock(snapshot.displaySeconds)} remaining`;

    if (holder) {
      holder.innerHTML = '';
      clock = new FlipClock({ label: 'Study timer' });
      const node = clock.render();
      holder.appendChild(node);
      clock.setTime(timer.getSnapshot().displaySeconds, false);
    }

    /* ------------------------------------------------------------ atmosphere -- */

    const paintAtmosphere = (environment) => {
      if (!workspace) return;
      workspace.querySelector('.focus-atmosphere-layer')?.remove();
      if (meteorTimer) {
        clearTimeout(meteorTimer);
        meteorTimer = null;
      }
      workspace.dataset.environment = environment;
      workspace.className = workspace.className.replace(/environment-\w+/g, `environment-${environment}`);
      workspace.insertBefore(renderAtmosphere(environment), workspace.firstChild);
      if (environment === 'night') loopMeteors();
    };

    /** Meteors arrive every 8–16 s, in bursts of 1–5, never on a paused screen. */
    const loopMeteors = () => {
      const sky = workspace?.querySelector('.night-sky');
      if (!sky) return;
      const shower = Math.random() < 0.5 ? 2 + Math.floor(Math.random() * 4) : 1;
      spawnMeteors(sky, shower);
      meteorTimer = setTimeout(loopMeteors, 9000 + Math.random() * 7000);
    };

    paintAtmosphere(timer.getSettings().environment);

    /* ----------------------------------------------------------------- live --- */

    const live = () => ({
      phase: root.querySelector('#focusPhase'),
      caption: root.querySelector('#focusCaption'),
      fill: root.querySelector('#focusProgressFill'),
    });

    /**
     * Repaint the moving parts. Called on every engine notification, which is
     * four times a second while the clock runs — so it touches only what
     * changed and never rebuilds markup the reader might be interacting with.
     */
    const paintLive = (snapshot) => {
      if (clock) clock.setTime(snapshot.displaySeconds, snapshot.timer.running);
      const parts = live();
      if (parts.fill) {
        const width = snapshot.timer.mode === 'pomodoro' ? Math.round(snapshot.progress * 100) : 0;
        parts.fill.dataset.pct = String(Math.max(0, Math.min(100, width)));
      }
      if (parts.phase) {
        parts.phase.textContent = timer.phaseLabel(snapshot.timer, { upper: true });
      }
      if (parts.caption) {
        parts.caption.textContent = snapshot.timer.running
          ? snapshot.timer.mode === 'stopwatch'
            ? 'Stopwatch running'
            : 'Session in progress'
          : snapshot.elapsed > 0
            ? 'Paused — your place is held'
            : snapshot.timer.phase === 'focus'
              ? 'Ready when you are'
              : 'A deliberate pause before the next block';
      }
      // The primary control and Finish change with the run state. Repaint them
      // here rather than calling ctx.refresh(): a refresh rebuilds the whole
      // screen, which drops transient state such as fullscreen and detaches
      // every listener in it. One click must be one change.
      const primary = root.querySelector('.focus-primary');
      if (primary) {
        const running = snapshot.timer.running;
        primary.dataset.action = running ? 'timer-pause' : 'timer-start';
        primary.textContent = running
          ? 'Pause'
          : snapshot.elapsed > 0
            ? 'Resume'
            : snapshot.timer.phase === 'focus'
              ? 'Start focus'
              : 'Start break';
      }
      const finish = root.querySelector('[data-action="timer-finish"]');
      if (finish && finish.disabled !== !timer.hasWorkToLog()) finish.disabled = !timer.hasWorkToLog();
      const reset = root.querySelector('[data-action="timer-reset"]');
      if (reset) reset.disabled = snapshot.elapsed === 0 && !snapshot.timer.running;
      // The tab title follows the clock, so a reader in another tab can see the
      // block without switching back. Only while something is running.
      if (typeof document !== 'undefined') {
        document.title = snapshot.timer.running
          ? `${fmtClock(snapshot.displaySeconds)} · ${timer.phaseLabel(snapshot.timer)} · MyMPPSC`
          : 'Study Timer · MyMPPSC';
      }
    };

    const onEngine = (reason, snapshot) => {
      paintLive(snapshot);
      // A phase change or a settings/mode change alters the controls and the
      // cards around the clock, so that needs a real repaint. Everything else
      // (a tick, the task name, a start/pause) is handled in place.
      const phaseKey = `${snapshot.timer.mode}:${snapshot.timer.phase}:${snapshot.timer.running}`;
      if (reason === 'phase') {
        const label = snapshot.timer.phase === 'focus' ? 'Back to focus' : 'Break time';
        toast(`${label} — ${timer.phaseLabel(snapshot.timer)}`, 'ok');
        ctx.refresh();
        return;
      }
      if (reason === 'settings' || reason === 'mode') {
        ctx.refresh();
        return;
      }
      if (reason === 'reset' || reason === 'skip') {
        ctx.refresh();
        return;
      }
      // A start/pause/resume only changes the controls, which paintLive has
      // just repainted. Fullscreen used to be torn down by a refresh here,
      // which is what turned the stage into a tall empty card.
      lastPhaseKey = phaseKey;
    };

    lastPhaseKey = `${timer.getSnapshot().timer.mode}:${timer.getSnapshot().timer.phase}:${timer.getSnapshot().timer.running}`;
    // Restore the immersive room if a repaint (a settings change, a phase
    // change) rebuilt the screen while it was open.
    if (wantFullscreen || document.fullscreenElement === (stage || workspace)) {
      setFullscreenState(true);
    }
    unsubscribe = timer.subscribe(onEngine);
    paintLive(timer.getSnapshot());

    /* -------------------------------------------------------------- controls -- */

    // One delegated listener for the whole screen, resolved at click time.
    // Binding per button at mount breaks as soon as the markup changes: the
    // primary control swaps between `timer-start` and `timer-pause` without a
    // repaint, and a listener bound to the old action would keep firing.
    const handlers = new Map();
    const on = (action, handler) => {
      handlers.set(action, handler);
      return undefined;
    };
    root.addEventListener(
      'click',
      (event) => {
        const button = event.target.closest?.('[data-action]');
        if (!button || !root.contains(button)) return;
        const handler = handlers.get(button.dataset.action);
        if (!handler) return;
        event.preventDefault();
        handler(button, event);
      },
      { signal: ctx.signal },
    );

    on('timer-start', () => timer.start());
    on('timer-pause', () => timer.pause());
    on('timer-reset', () => timer.reset());
    on('timer-skip', () => timer.skipBreak());
    on('timer-finish', async () => {
      const result = await timer.finish();
      if (result?.logged) toast(`${duration(result.seconds / 60)} of focus logged`, 'ok');
      else if (!result) toast('Nothing to log yet — a block needs at least 12 seconds.', 'warn');
    });
    on('timer-mode', (button) => timer.setMode(button.dataset.value));

    const setFullscreenState = (on) => {
      wantFullscreen = Boolean(on);
      workspace?.classList.toggle('is-fullscreen', Boolean(on));
      // A class-only fallback (iOS Safari has no Element Fullscreen API) still
      // needs the page behind it to stop scrolling.
      document.documentElement.classList.toggle('focus-fs-lock', Boolean(on));
    };

    on('timer-fullscreen', async () => {
      const target = stage || workspace;
      if (!target) return;
      const already = workspace?.classList.contains('is-fullscreen');
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          setFullscreenState(false);
        } else if (target.requestFullscreen) {
          await target.requestFullscreen();
          // `fullscreenchange` normally does this, but a refused transition
          // leaves the two out of step, so set it here as well.
          setFullscreenState(document.fullscreenElement === target);
        } else {
          // No API: use the same layout immutably, so the button still works.
          setFullscreenState(!already);
        }
      } catch {
        setFullscreenState(!already);
        toast('Your browser blocked real fullscreen, so this is the immersive view. Press Escape to leave.', 'warn');
      }
    });

    // In fullscreen the clock itself starts and pauses, because there is
    // nothing else on the screen. This is registered once for the life of the
    // screen rather than `{ once: true }` per fullscreen entry — a one-shot
    // listener left the user able to pause but never resume.
    const onClockClick = () => {
      if (!workspace?.classList.contains('is-fullscreen')) return;
      timer.isRunning() ? timer.pause() : timer.start();
    };
    // `clock` is the FlipClock instance; the click target is the node it owns.
    // Bound to `workspace` rather than the holder because the holder is
    // replaced whenever the screen is rebuilt.
    workspace?.addEventListener('click', (event) => {
      if (!workspace.classList.contains('is-fullscreen')) return;
      if (!event.target.closest?.('#focusClockHolder')) return;
      onClockClick();
    });

    const onFullscreenChange = () => {
      const target = stage || workspace;
      const isFull = Boolean(document.fullscreenElement) && document.fullscreenElement === target;
      setFullscreenState(isFull);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);

    // Escape leaves the CSS-only immersive mode, which has no native handler.
    const onKeydown = (event) => {
      if (event.key !== 'Escape') return;
      if (document.fullscreenElement) return;
      if (!workspace?.classList.contains('is-fullscreen')) return;
      setFullscreenState(false);
    };
    document.addEventListener('keydown', onKeydown);

    /* --------------------------------------------------------------- the task -- */

    const taskInput = root.querySelector('#focusTask');
    taskInput?.addEventListener('change', () => timer.setTaskName(taskInput.value));
    taskInput?.addEventListener('blur', () => timer.setTaskName(taskInput.value));
    taskInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        timer.setTaskName(taskInput.value);
        taskInput.blur();
      }
    });

    /* ------------------------------------------------------------- the settings -- */

    const patch = (value) => timer.setSettings(value);

    root.querySelectorAll('[data-action="set-focus-minutes"]').forEach((button) => {
      button.addEventListener('click', () => {
        timer.reset();
        patch({ focusMinutes: Number(button.dataset.value) });
      });
    });

    const bindCheck = (id, apply) => {
      root.querySelector(`#${id}`)?.addEventListener('change', (event) => apply(event.target.checked));
    };
    const bindNumber = (id, apply) => {
      root.querySelector(`#${id}`)?.addEventListener('change', (event) => apply(Number(event.target.value)));
    };
    const bindSelect = (id, apply) => {
      root.querySelector(`#${id}`)?.addEventListener('change', (event) => apply(event.target.value));
    };

    bindNumber('setDailyTarget', (value) => patch({ dailyTargetMinutes: Math.max(0, Math.min(1440, value || 0)) }));
    bindCheck('setBreaks', (value) => patch({ breaksEnabled: value }));
    bindNumber('setBreakMinutes', (value) => patch({ breakMinutes: Math.max(1, Math.min(60, value || 1)) }));
    bindNumber('setLongBreak', (value) => patch({ longBreakMinutes: Math.max(1, Math.min(120, value || 1)) }));
    bindSelect('setLongEvery', (value) => patch({ sessionsBeforeLongBreak: Number(value) }));
    bindSelect('setEnvironment', (value) => {
      patch({ environment: value });
      paintAtmosphere(value);
    });
    bindSelect('setSoundscape', (value) => patch({ soundscape: value }));
    bindCheck('setSound', (checked) => {
      if (checked) audio.unlock();
      patch({ soundEnabled: checked });
    });
    root.querySelector('#setVolume')?.addEventListener('input', (event) => {
      const volume = Number(event.target.value);
      // The engine updates the ambient gain on every settings change; the label
      // is repainted on `change` (below) so dragging is not a flood of toasts.
      timer.setSettings({ volume });
      const label = root.querySelector('label[for="setVolume"] .label-text');
      if (label) label.textContent = `Volume · ${volume}%`;
    });
    bindCheck('setMindfulness', (value) => patch({ mindfulnessEnabled: value }));
    bindSelect('setBellInterval', (value) => patch({ mindfulnessInterval: Number(value) }));

    /* --------------------------------------------------------------- manual log -- */

    root.querySelectorAll('[data-action="log-manual"]').forEach((button) => {
      button.addEventListener('click', () => openManualLog(ctx));
    });

    /* ------------------------------------------------------------- teardown -- */

    if (typeof ctx.signal?.addEventListener === 'function') {
      ctx.signal.addEventListener('abort', () => {
        unsubscribe?.();
        unsubscribe = null;
        clock?.destroy();
        clock = null;
        if (meteorTimer) clearTimeout(meteorTimer);
        document.removeEventListener('fullscreenchange', onFullscreenChange);
        document.removeEventListener('keydown', onKeydown);
        // Leaving the screen must not leave the page scroll-locked or the
        // immersive class behind for the next view.
        document.documentElement.classList.remove('focus-fs-lock');
        workspace?.classList.remove('is-fullscreen');
        // The engine keeps running; only the sound is paused while away from
        // the screen if the reader has it on? No — ambience belongs to the
        // session, not the screen, so it is deliberately left alone.
      }, { once: true });
    }
  },

  cleanup() {
    // The subscription is released by the abort listener in mount(). Resetting
    // the document title here means leaving the screen cannot leave a clock
    // ticking in the tab strip.
    if (typeof document !== 'undefined' && document.title.startsWith('0')) document.title = 'Study Timer · MyMPPSC';
  },
};

/* ------------------------------------------------------------ manual log --- */

/**
 * The "I forgot to start the timer" path. A manual log is an ordinary completed
 * focus session, so it lands in the same day totals, week chart and heatmap.
 * The form shows which study day the log will be filed under, because a start
 * time before 4 AM belongs to the previous day and that would otherwise be a
 * silent surprise.
 */
function openManualLog(ctx) {
  const today = applicationDayKey();
  openModal({
    title: 'Log study manually',
    body: `
      <div class="field-row">
        <label class="field"><span class="label-text">Study day</span>
          <input type="date" id="manualDate" value="${today}" max="${today}" />
        </label>
        <label class="field"><span class="label-text">Start time (optional)</span>
          <input type="time" id="manualTime" />
        </label>
      </div>
      <div class="field-row">
        <label class="field"><span class="label-text">Hours</span>
          <input type="number" id="manualHours" min="0" max="23" value="0" />
        </label>
        <label class="field"><span class="label-text">Minutes</span>
          <input type="number" id="manualMinutes" min="0" max="59" value="30" />
        </label>
      </div>
      <label class="field"><span class="label-text">What did you work on? (optional)</span>
        <input type="text" id="manualTask" maxlength="160" placeholder="Polity — Centre–State relations" />
      </label>
      <p class="muted small" id="manualFiled" aria-live="polite"></p>
      <p class="field-error" id="manualError" hidden></p>
    `,
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Save session', tone: 'btn-primary', value: 'save' },
    ],
    onMount: (modal, close) => {
      const dateInput = modal.querySelector('#manualDate');
      const timeInput = modal.querySelector('#manualTime');
      const filed = modal.querySelector('#manualFiled');
      const error = modal.querySelector('#manualError');
      const hoursInput = modal.querySelector('#manualHours');
      const minutesInput = modal.querySelector('#manualMinutes');

      const refreshFiled = () => {
        const day = dateInput.value || today;
        const filedDay = studyLog.manualLogDay(day, timeInput.value || null);
        filed.textContent =
          filedDay === day
            ? `Filed under ${filedDay} (the 4 AM study day starting that morning).`
            : `Filed under ${filedDay}: ${timeInput.value} is before the 4 AM boundary, so it belongs to the previous study day.`;
      };
      [dateInput, timeInput].forEach((input) => input?.addEventListener('change', refreshFiled));
      refreshFiled();

      const submit = async () => {
        const durationMinutes = (Number(hoursInput.value) || 0) * 60 + (Number(minutesInput.value) || 0);
        error.hidden = true;
        const result = await studyLog.logManualStudy({
          date: dateInput.value || today,
          time: timeInput.value || null,
          durationMinutes,
          taskName: modal.querySelector('#manualTask').value,
        });
        if (!result.ok) {
          error.textContent = result.error;
          error.hidden = false;
          return;
        }
        close('save');
        toast(`${duration(result.session.minutes)} logged to study hours`, 'ok');
        ctx.refresh();
      };

      modal.querySelector('[data-value="save"]')?.addEventListener('click', submit);
      modal.querySelector('[data-value="cancel"]')?.addEventListener('click', () => close('cancel'));
      [hoursInput, minutesInput].forEach((input) =>
        input?.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') submit();
        }),
      );
    },
  });
}
