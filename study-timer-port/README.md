# Study Timer port — download

The files needed to add the Study Timer to **MyMPPSC**.

| File | What it is |
| --- | --- |
| `studytimer-files.zip` | 21 files (9 new, 12 modified) from commit `4f92425`, in repo paths. Unzip, then drag the contents into GitHub's **Add file → Upload files**. |
| `study-timer.patch` | The same commit as a `git am`-able patch. Needs a terminal. |
| `apply-study-timer.html` | Local instructions page with download buttons. |
| `STUDY-TIMER-PORT.md` | Pull-request description. |

Built on MyMPPSC `main` at `34a6210`. Nothing existing is deleted; timer sessions are written
into the existing `sessions` store, so there is no database migration.
