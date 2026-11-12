# Port the PREPTRACK Study Timer to MyMPPSC

> Ready-to-paste PR description. The work is committed on the branch
> `feat/study-timer` in `/home/user/MyMPPSC` (commit `4f92425`), and a
> standalone patch is at `/home/user/study-timer.patch`.

## Why the port is not a copy-paste

PREPTRACK and MyMPPSC are different stacks. PREPTRACK is **React 18 + Vite + TSX**
with a global store context; MyMPPSC is **plain HTML + ES modules with no build
step**, where a screen is an object with `render() → HTML string` and
`mount()` for behaviour. Copying the `.tsx` files would not run here at all.

What *does* transfer is the design and the rules, so that is what was ported —
the flip clock, the Pomodoro/stopwatch state machine, the three atmospheres,
the 4 AM study day, the manual-log path, and the Study Hours review screen —
rebuilt idiomatically against this app's own conventions (token-only CSS,
`card()` / `sheet()` / `screenHead()`, the density budget, the service-worker
precache list and the router contract).

## What was added

**Screens**

| Route | What it is |
| --- | --- |
| `#/timer` | Flip-clock focus workspace. Pomodoro (25/30/45/50/90-minute blocks, short and long breaks) or stopwatch; a task line; a live tab title; a distraction-free fullscreen stage; woodland / rain / night atmospheres; ambience and a mindfulness bell. Finished blocks log themselves. |
| `#/hours` | The record: current and best streak, this week vs last week, average per active day, target met, a 26-week consistency heatmap, and the weekly rhythm. |

The dashboard's standing strip gains a **Studied today** figure that links to the
timer, so the section is visible from where a reader starts.

**Engine** — `js/services/study-timer.js`

- The clock lives outside the screen, so a block **keeps running** while the
  reader marks a syllabus line or sits a mock. The view subscribes in `mount()`
  and releases through `ctx.signal`.
- Time is **anchored** (`anchorElapsed` + `anchorAt`), never accumulated: a
  throttled background tab, a locked phone or a closed laptop cannot make it
  drift.
- State is mirrored to localStorage and **restored at boot**. A phase that ran
  out while the app was shut is closed out exactly once, at its full length.
- **Log-once guarantee**: written block ids live in localStorage, so a duplicate
  tick or a second tab cannot double-count a finished block.
- Only the moving parts repaint on a tick (digits, caption, progress, tab title);
  a structural change calls `ctx.refresh()`, so the clock's own animation is
  never restarted mid-flip.

**Data** — `js/services/study-log.js`

Rows go into the **existing `sessions` store**, so timer time is ordinary study
time: the same records feed the planner, backup/restore and the dashboard.
`session_type`, `task_name` and `completed` are added; only finished focus
blocks count as study minutes.

**The 4 AM study day** — `applicationDayKey()` in `js/core/util.js`

A session past midnight belongs to the evening it began, so a 25-minute block
ending at 00:20 counts towards the day before. `todayKey()` still reports
calendar days — exam dates must not move at 4 AM — so only focus sessions and
manual logs are classified this way. Manual logs show which study day they will
be filed under, because a start time before 4 AM moves them back a day.

**Audio** — `js/ui/focus-audio.js`

The reference workspace shipped **38 MB** of looped MP3s. Ambience and bells are
synthesised with Web Audio instead (shaped noise through a filter plus a slow
LFO; bells from decaying partials): nothing to download, offline use untouched,
and every call is a no-op where Web Audio is unavailable.

## Deliberate departures from the reference

- **No Document Picture-in-Picture mini player.** It is Chromium-only, and a
  persistent floating window conflicts with this app's mobile shell. The live tab
  title gives the same "see the clock without switching back" benefit.
- **No MP3 assets** — synthesised audio instead (see above).
- **A fourth screen was not exported.** Study Hours is reachable and the timer's
  header links to it, but it is not in the phone tab bar: the reference's
  five-slot bar is retained (Today, Study Timer, Papers, Smart, Mistakes).
- **The daily focus target is a timer preference**, not an app setting. This repo
  deliberately retired a `dailyTaskTarget` setting and keeps session rules fixed
  (the existing suite asserts it), so the target lives with the timer's other
  durations and a settings reset does not discard it.
- **No night-forces-dark-theme side effect.** The night palette is scoped to the
  workspace, so choosing an atmosphere never silently changes the whole app's
  theme — less surprising, and it avoids a second source of truth for `data-theme`.

## Checks

```
node tools/check.mjs        # 1,188 checks — same 7 pre-existing bank failures, no new ones
node --test tests/*.test.js # 450 pass / 27 fail
```

The 27 failures are **pre-existing and unchanged** on this branch's base
(`34a6210`): this checkout ships 1,300 of the 1,684 bank questions the suites
expect, so every failure is about bank contents, not UI. Compared failure-by-
failure against the untouched baseline, the port adds **zero** regressions and
**30** new passing tests (`tests/study-timer.test.js`).

New files are precached in `sw.js` (VERSION bumped to `v1.10.0-study-timer`),
measured by the density guard (`tools/density.mjs`), and listed in the README,
`docs/UI.md` (§6d-bis documents the timer's design rules) and the command
palette's Go group.

## Screenshot note

The sandbox could not download a headless browser, so the visual result was
verified through jsdom (rendered markup, particle counts per atmosphere, clock
digits, heading structure, density budget) rather than by eye. A quick look at
`#/timer` in a browser before merging is worth doing — the atmospheres and the
flip animation are the two things jsdom cannot show.
