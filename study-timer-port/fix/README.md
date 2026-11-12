# Study Timer fullscreen fix

Three files, replacing the ones in MyMPPSC `main` as they are today:

| File | Change |
| --- | --- |
| `css/focus-timer.css` | fullscreen room rules |
| `js/ui/views/timer.js` | fullscreen logic, in-place control repaint, click delegation |
| `tests/study-timer.test.js` | 32 tests (2 new) |

Apply one of two ways:

1. **Upload** — drop these three files over the same paths with GitHub's
   **Add file → Upload files**, exactly as before.
2. **Patch** — `git am study-timer-fullscreen-fix.patch` in a clone.

The patch is off MyMPPSC `main` at `643e725`.
