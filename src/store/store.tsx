/** Central app store: React context wrapping the local DB with mutation actions.
 *
 * Architecture (local-first with cloud sync):
 *  - Every mutation updates local state immediately (optimistic, offline-safe).
 *  - When signed in (Supabase), the same mutation is pushed via the centralized
 *    repository (`src/data/repository.ts`); failures queue for retry (online
 *    event / interval) — no silent data loss.
 *  - On sign-in the cloud is pulled and merged (union by id, local wins on
 *    conflicts). The first sign-in of a device that already holds data into an
 *    account that is still empty uploads that data once, silently and
 *    additively (no prompt, no re-import button, nothing is ever deleted);
 *    local data is never deleted either.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MupDatabase, ItemProgress, ItemType, ItemStatus, Confidence, Task,
  PrelimsTest, MainsTest, FocusSession, Lecture,
  CurrentAffairItem, AnswerEntry, RevisionLog, Settings,
} from '../types';
import { loadDb, saveDb, saveDbNow, newDatabase, DB_VERSION, DB_KEY, CACHE_KEY_PREFIXES } from './db';
import { uid } from '../lib/id';
import { addDays, applicationDayKey, dateFromKey, todayKey } from '../lib/date';
import { composeManualStartedAt, type ManualStudyInput } from '../lib/studyLog';
import { MAX_REVISION, nextRevisionDate, revisionBucket } from '../lib/revision';
import { getSupabase, getSessionOnlySupabase, isCloudConfigured } from '../lib/supabase';
import { Repository } from '../data/repository';
import type { SupabaseClient } from '@supabase/supabase-js';
import { applyHierarchyStatus } from '../lib/syllabusProgress';
import { normalizeLectureProgress } from '../lib/lectures';

export type AuthState = 'loading' | 'gate' | 'signed-in' | 'local';
export interface SyncStatus {
  /** queued pushes awaiting retry */
  pending: number;
  syncing: boolean;
  lastError: string | null;
  lastSyncAt: string | null;
}

export interface StoreValue {
  db: MupDatabase;
  setDb: React.Dispatch<React.SetStateAction<MupDatabase>>;
  // cloud / auth
  authState: AuthState;
  syncStatus: SyncStatus;
  accountEmail: string | null;
  continueLocal: () => void;
  /** `rememberMe` (default true): true persists the session in this browser
   *  (survives reloads); false keeps it in memory only for this page session. */
  signIn: (email: string, password: string, rememberMe?: boolean) => Promise<{ error?: string; needsConfirmation?: boolean }>;
  signUp: (email: string, password: string) => Promise<{ error?: string; needsConfirmation?: boolean }>;
  logout: () => Promise<void>;
  flushSync: () => Promise<void>;
  // progress
  getProgress: (itemId: string) => ItemProgress | undefined;
  setItemStatus: (itemId: string, itemType: ItemType, status: ItemStatus) => void;
  setItemNotes: (itemId: string, itemType: ItemType, notes: string) => void;
  reviseItem: (itemId: string, itemType: ItemType, confidence: Confidence) => void;
  resetRevision: (itemId: string, itemType: ItemType) => void;
  bulkSetStatus: (itemIds: string[], itemType: ItemType, status: ItemStatus) => void;
  // tasks
  addTask: (t: Partial<Task> & { name: string; deadline: string }) => void;
  addTasks: (tasks: (Partial<Task> & { name: string; deadline: string })[]) => void;
  updateTask: (id: string, patch: Partial<Task>) => void;
  toggleTask: (id: string, completed: boolean) => void;
  deleteTask: (id: string) => void;
  // tests
  addPrelimsTest: (t: Omit<PrelimsTest, 'id' | 'createdAt'>) => void;
  deletePrelimsTest: (id: string) => void;
  addMainsTest: (t: Omit<MainsTest, 'id' | 'createdAt'>) => void;
  deleteMainsTest: (id: string) => void;
  // focus
  addFocusSession: (s: Omit<FocusSession, 'id'>) => void;
  /** Record a study block the user forgot to time. Feeds the same
   *  focus-session pipeline as the timer; never creates a timer session. */
  logManualStudy: (input: ManualStudyInput, idempotencyKey?: string) => { ok: boolean; error?: string };
  /** Remove abandoned (non-completed) session records from earlier
   *  application days — local cache and cloud. Completed sessions are kept
   *  because Study Hours / Analytics are derived from them. */
  pruneStaleSessions: () => void;
  // lectures
  addLecture: (l: Partial<Lecture> & { subject: string }) => void;
  updateLecture: (id: string, patch: Partial<Lecture>) => void;
  deleteLecture: (id: string) => void;
  // current affairs
  addCurrentAffair: (c: Partial<CurrentAffairItem> & { title: string }) => void;
  updateCurrentAffair: (id: string, patch: Partial<CurrentAffairItem>) => void;
  deleteCurrentAffair: (id: string) => void;
  // answers
  addAnswer: (a: Partial<AnswerEntry> & { question: string }) => void;
  updateAnswer: (id: string, patch: Partial<AnswerEntry>) => void;
  deleteAnswer: (id: string) => void;
  // settings & meta
  updateSettings: (patch: Partial<Settings>) => void;
  replaceDb: (next: MupDatabase) => void;
  resetProgressOnly: () => void;
  /** Delete every user-generated preparation record locally AND in the cloud.
   * Keeps the auth account, the Remember-Me session and app preferences.
   * Invalidates in-flight sync so a stale response cannot repopulate data. */
  wipeAllData: () => Promise<{ ok: boolean; error?: string }>;
}

const StoreContext = createContext<StoreValue | null>(null);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (id: string) => UUID_RE.test(id);
const migratedFlagKey = (userId: string) => `mup.migrated.${userId}`;
const wipeMarkerKey = (userId: string) => `mup.wiped.${userId}`;
const SESSION_PRUNE_KEY = 'mup.sessions.pruned-day';
/** Deletion order that respects the schema's foreign keys (children first). */
const USER_DATA_TABLES = [
  'habit_completions', 'habits', 'revision_logs', 'syllabus_progress',
  'focus_sessions', 'answers', 'current_affairs', 'lectures', 'pyqs',
  'mains_tests', 'prelims_tests', 'tasks',
] as const;

function emptyProgress(itemId: string, itemType: ItemType, now: string): ItemProgress {
  return {
    itemId, itemType, status: 'not_started', revisionCount: 0, confidence: 0,
    lastRevisedAt: null, nextRevisionAt: null, notes: '', tags: [], updatedAt: now,
  };
}

/** Pure id remap for one entity, shared by the incremental push path
 *  (`applyIdMap`) and the one-shot first-sign-in import. */
function remapEntityIds(d: MupDatabase, entity: string, map: Record<string, string>): MupDatabase {
  if (!Object.keys(map).length) return d;
  const swap = <T extends { id: string }>(arr: T[]) => arr.map((x) => (map[x.id] ? { ...x, id: map[x.id] } : x));
  switch (entity) {
    case 'tasks': return { ...d, tasks: swap(d.tasks) };
    case 'pyqs': return { ...d, pyqs: swap(d.pyqs) };
    case 'prelimsTests': return { ...d, prelimsTests: swap(d.prelimsTests) };
    case 'mainsTests': return { ...d, mainsTests: swap(d.mainsTests) };
    case 'focusSessions': return { ...d, focusSessions: swap(d.focusSessions) };
    case 'lectures': return { ...d, lectures: swap(d.lectures) };
    case 'currentAffairs': return { ...d, currentAffairs: swap(d.currentAffairs) };
    case 'answers': return { ...d, answers: swap(d.answers) };
    case 'habits': return {
      ...d,
      habits: swap(d.habits),
      habitCompletions: d.habitCompletions.map((c) => (map[c.habitId] ? { ...c, habitId: map[c.habitId] } : c)),
    };
    case 'habitCompletions': return { ...d, habitCompletions: swap(d.habitCompletions) };
    case 'revisionLogs': return { ...d, revisionLogs: swap(d.revisionLogs) };
    default: return d;
  }
}

type NewTaskInput = Partial<Task> & { name: string; deadline: string };
function createTask(t: NewTaskInput): Task {
  const createdAt = t.createdAt
    ?? (/^\d{4}-\d{2}-\d{2}$/.test(t.deadline) ? composeManualStartedAt(t.deadline, null) : new Date().toISOString());
  return {
    id: uid('task'),
    name: t.name,
    subjectMapping: t.subjectMapping ?? '',
    syllabusContext: t.syllabusContext ?? null,
    studyStage: t.studyStage ?? 'R0',
    source: t.source ?? null,
    priority: t.priority ?? 'normal',
    priorityBucket: t.priorityBucket ?? null,
    deadline: t.deadline,
    completedAt: null,
    status: 'upcoming',
    startTime: t.startTime ?? null,
    endTime: t.endTime ?? null,
    estimateMin: t.estimateMin ?? null,
    linkedTopicId: t.linkedTopicId ?? null,
    linkedSubtopicId: t.linkedSubtopicId ?? null,
    notes: t.notes ?? '',
    createdAt,
    isEvent: t.isEvent ?? false,
  };
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [db, setDb] = useState<MupDatabase>(() => loadDb());
  const dbRef = useRef(db);
  useEffect(() => { dbRef.current = db; saveDb(db); }, [db]);

  const [authState, setAuthState] = useState<AuthState>(() => (isCloudConfigured ? 'loading' : 'local'));
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ pending: 0, syncing: false, lastError: null, lastSyncAt: null });

  const repoRef = useRef<Repository | null>(null);
  const userIdRef = useRef<string | null>(null);
  /** The Supabase client that owns the current session (persistent or
   *  memory-only, depending on how the user signed in). */
  const authClientRef = useRef<SupabaseClient | null>(null);
  const activeClient = useCallback(() => authClientRef.current ?? getSupabase(), []);
  const pendingOps = useRef<Map<string, () => Promise<void>>>(new Map());
  const progressDirty = useRef<Set<string>>(new Set());
  const progressTimer = useRef<number | undefined>(undefined);
  const settingsTimer = useRef<number | undefined>(undefined);
  /** Bumped by destructive local resets (wipe). Any pull/push that started
   *  under an older epoch is discarded when it resolves, so a slow response
   *  can never write wiped records back into local state. */
  const syncEpoch = useRef(0);
  const manualLogKeys = useRef<Set<string>>(new Set());

  const repo = useCallback((): Repository | null => {
    if (authState !== 'signed-in' || !isCloudConfigured || !userIdRef.current) return null;
    if (!repoRef.current) repoRef.current = new Repository(activeClient(), userIdRef.current);
    return repoRef.current;
  }, [authState, activeClient]);

  const markSynced = () => setSyncStatus((s) => ({ ...s, syncing: false, lastError: null, lastSyncAt: new Date().toISOString() }));

  /** Run a push now; on failure queue it for retry. */
  const push = useCallback(async (key: string, fn: (r: Repository) => Promise<void>) => {
    const r = repo();
    if (!r) return;
    setSyncStatus((s) => ({ ...s, syncing: true }));
    try {
      await fn(r);
      if (pendingOps.current.has(key)) { pendingOps.current.delete(key); setSyncStatus((s) => ({ ...s, pending: pendingOps.current.size })); }
      markSynced();
    } catch (e) {
      pendingOps.current.set(key, () => fn(r));
      setSyncStatus((s) => ({ ...s, pending: pendingOps.current.size, syncing: false, lastError: e instanceof Error ? e.message : String(e) }));
    }
  }, [repo]);

  const flushProgressNow = useCallback(async () => {
    const r = repo();
    if (!r || progressDirty.current.size === 0) return;
    const items = [...progressDirty.current]
      .map((id) => dbRef.current.progress[id])
      .filter(Boolean) as ItemProgress[];
    progressDirty.current.clear();
    try {
      await r.upsertProgress(items);
      markSynced();
    } catch (e) {
      for (const it of items) progressDirty.current.add(it.itemId);
      setSyncStatus((s) => ({ ...s, lastError: e instanceof Error ? e.message : String(e) }));
    }
  }, [repo]);

  const flushSync = useCallback(async () => {
    const r = repo();
    if (!r) return;
    await flushProgressNow();
    if (pendingOps.current.size === 0) return;
    setSyncStatus((s) => ({ ...s, syncing: true }));
    const ops = [...pendingOps.current.entries()];
    for (const [key, run] of ops) {
      try { await run(); pendingOps.current.delete(key); }
      catch (e) { setSyncStatus((s) => ({ ...s, lastError: e instanceof Error ? e.message : String(e) })); }
    }
    // Only claim a clean bill of health when nothing is still queued —
    // progress upserts that failed live in `progressDirty`, not `pendingOps`.
    const remaining = pendingOps.current.size + progressDirty.current.size;
    setSyncStatus((s) => ({ ...s, pending: pendingOps.current.size, syncing: false, lastError: remaining ? s.lastError : null, lastSyncAt: new Date().toISOString() }));
  }, [repo, flushProgressNow]);

  // retry: on network back + periodically when items are pending
  useEffect(() => {
    const onOnline = () => { void flushSync(); };
    window.addEventListener('online', onOnline);
    const t = window.setInterval(() => {
      if (pendingOps.current.size > 0 || progressDirty.current.size > 0) void flushSync();
    }, 60000);
    return () => { window.removeEventListener('online', onOnline); window.clearInterval(t); };
  }, [flushSync]);

  /** Rewrite local entity ids after cloud inserts return real uuids. */
  const applyIdMap = useCallback((entity: string, map: Record<string, string>) => {
    if (!Object.keys(map).length) return;
    setDb((d) => remapEntityIds(d, entity, map));
  }, []);

  // ---------------------------------------------------------------- progress
  const getProgress = useCallback((itemId: string) => dbRef.current.progress[itemId], []);

  const scheduleProgressFlush = useCallback(() => {
    if (progressTimer.current) window.clearTimeout(progressTimer.current);
    progressTimer.current = window.setTimeout(() => { void flushProgressNow(); }, 800);
  }, [flushProgressNow]);

  const upsertProgressLocal = useCallback((itemId: string, itemType: ItemType, patch: Partial<ItemProgress>) => {
    const now = new Date().toISOString();
    setDb((d) => {
      const prev = d.progress[itemId] ?? emptyProgress(itemId, itemType, now);
      return { ...d, progress: { ...d.progress, [itemId]: { ...prev, ...patch, updatedAt: now } } };
    });
    if (authState === 'signed-in') {
      progressDirty.current.add(itemId);
      scheduleProgressFlush();
    }
  }, [authState, scheduleProgressFlush]);

  const setItemStatus = useCallback((itemId: string, _itemType: ItemType, status: ItemStatus) => {
    setDb((d) => {
      const result = applyHierarchyStatus(d.progress, itemId, status);
      if (authState === 'signed-in') {
        for (const node of result.changed) progressDirty.current.add(node.id);
        scheduleProgressFlush();
      }
      return result.changed.length ? { ...d, progress: result.progress } : d;
    });
  }, [authState, scheduleProgressFlush]);

  /** Backwards-compatible bulk action. Hierarchy reconciliation still happens
   * once per target so callers cannot leave contradictory parent rows. */
  const bulkSetStatus = useCallback((itemIds: string[], _itemType: ItemType, status: ItemStatus) => {
    setDb((d) => {
      let progress = d.progress;
      const changed = new Set<string>();
      for (const id of [...new Set(itemIds)]) {
        const result = applyHierarchyStatus(progress, id, status);
        progress = result.progress;
        result.changed.forEach((node) => changed.add(node.id));
      }
      if (authState === 'signed-in' && changed.size) {
        changed.forEach((id) => progressDirty.current.add(id));
        scheduleProgressFlush();
      }
      return changed.size ? { ...d, progress } : d;
    });
  }, [authState, scheduleProgressFlush]);

  const setItemNotes = useCallback((itemId: string, itemType: ItemType, notes: string) => {
    upsertProgressLocal(itemId, itemType, { notes });
  }, [upsertProgressLocal]);

  const reviseItem = useCallback((itemId: string, itemType: ItemType, confidence: Confidence) => {
    const now = new Date();
    const prevCount = dbRef.current.progress[itemId]?.revisionCount ?? 0;
    const count = Math.min(MAX_REVISION, prevCount + 1);
    const next = nextRevisionDate(now, count, confidence);
    const log: RevisionLog = {
      id: uid('rev'), itemId, itemType, revisionNumber: count, confidence,
      revisedAt: now.toISOString(), notes: '',
    };
    setDb((d) => {
      const hierarchy = applyHierarchyStatus(d.progress, itemId, 'completed', now.toISOString());
      const previous = hierarchy.progress[itemId] ?? emptyProgress(itemId, itemType, now.toISOString());
      const progress = {
        ...hierarchy.progress,
        [itemId]: {
          ...previous, itemType, status: 'completed' as const, revisionCount: count, confidence,
          lastRevisedAt: now.toISOString(), nextRevisionAt: next.toISOString(), updatedAt: now.toISOString(),
        },
      };
      if (authState === 'signed-in') {
        hierarchy.changed.forEach((node) => progressDirty.current.add(node.id));
        progressDirty.current.add(itemId);
        scheduleProgressFlush();
      }
      return { ...d, progress, revisionLogs: [...d.revisionLogs, log] };
    });
    void push(`revlog:${log.id}`, async (r) => r.insertRevisionLogs([log]));
  }, [authState, scheduleProgressFlush, push]);

  const resetRevision = useCallback((itemId: string, itemType: ItemType) => {
    const now = new Date().toISOString();
    setDb((d) => {
      const hierarchy = applyHierarchyStatus(d.progress, itemId, 'not_started', now);
      const previous = hierarchy.progress[itemId] ?? emptyProgress(itemId, itemType, now);
      const progress = {
        ...hierarchy.progress,
        [itemId]: { ...previous, itemType, revisionCount: 0, confidence: 0 as const, lastRevisedAt: null, nextRevisionAt: null, status: 'not_started' as const, updatedAt: now },
      };
      if (authState === 'signed-in') {
        hierarchy.changed.forEach((node) => progressDirty.current.add(node.id));
        progressDirty.current.add(itemId);
        scheduleProgressFlush();
      }
      return { ...d, progress };
    });
  }, [authState, scheduleProgressFlush]);

  // ---------------------------------------------------------------- tasks
  const addTasks = useCallback((inputs: NewTaskInput[]) => {
    const tasks = inputs.filter((input) => input.name.trim()).map((input) => createTask({ ...input, name: input.name.trim() }));
    if (!tasks.length) return;
    setDb((d) => ({ ...d, tasks: [...d.tasks, ...tasks] }));
    const operationKey = `tasks:${tasks.map((task) => task.id).join(',')}`;
    void push(operationKey, async (r) => {
      const ids = await r.insertTasksAndGetIds(tasks);
      const map: Record<string, string> = {};
      tasks.forEach((task, index) => { if (ids[index]) map[task.id] = ids[index]; });
      applyIdMap('tasks', map);
    });
  }, [push, applyIdMap]);

  const addTask = useCallback((t: NewTaskInput) => addTasks([t]), [addTasks]);

  const updateTask = useCallback((id: string, patch: Partial<Task>) => {
    // compute the merged record from current state so the push is never stale
    const current = dbRef.current.tasks.find((t) => t.id === id);
    const merged: Task | null = current ? { ...current, ...patch, createdAt: current.createdAt } : null;
    setDb((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === id ? { ...t, ...patch, createdAt: t.createdAt } : t)) }));
    if (!merged) return;
    void push(`task:${id}`, async (r) => {
      if (isUuid(id)) await r.updateTask(id, merged);
      else { const ids = await r.insertTasksAndGetIds([merged]); if (ids[0]) applyIdMap('tasks', { [id]: ids[0] }); }
    });
  }, [push, applyIdMap]);

  const toggleTask = useCallback((id: string, completed: boolean) => {
    updateTask(id, { status: completed ? 'completed' : 'upcoming', completedAt: completed ? new Date().toISOString() : null });
  }, [updateTask]);

  const deleteTask = useCallback((id: string) => {
    setDb((d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== id) }));
    if (isUuid(id)) void push(`task:${id}`, async (r) => r.deleteRow('tasks', id));
  }, [push]);

  // ---------------------------------------------------------------- tests
  const addPrelimsTest = useCallback((t: Omit<PrelimsTest, 'id' | 'createdAt'>) => {
    const test: PrelimsTest = { ...t, id: uid('pt'), createdAt: new Date().toISOString() };
    setDb((d) => ({ ...d, prelimsTests: [...d.prelimsTests, test] }));
    void push(`pt:${test.id}`, async (r) => {
      const ids = await r.insertPrelimsTestsAndGetIds([test]);
      if (ids[0]) applyIdMap('prelimsTests', { [test.id]: ids[0] });
    });
  }, [push, applyIdMap]);
  const deletePrelimsTest = useCallback((id: string) => {
    setDb((d) => ({ ...d, prelimsTests: d.prelimsTests.filter((t) => t.id !== id) }));
    if (isUuid(id)) void push(`pt:${id}`, async (r) => r.deleteRow('prelims_tests', id));
  }, [push]);
  const addMainsTest = useCallback((t: Omit<MainsTest, 'id' | 'createdAt'>) => {
    const test: MainsTest = { ...t, id: uid('mt'), createdAt: new Date().toISOString() };
    setDb((d) => ({ ...d, mainsTests: [...d.mainsTests, test] }));
    void push(`mt:${test.id}`, async (r) => {
      const ids = await r.insertMainsTestsAndGetIds([test]);
      if (ids[0]) applyIdMap('mainsTests', { [test.id]: ids[0] });
    });
  }, [push, applyIdMap]);
  const deleteMainsTest = useCallback((id: string) => {
    setDb((d) => ({ ...d, mainsTests: d.mainsTests.filter((t) => t.id !== id) }));
    if (isUuid(id)) void push(`mt:${id}`, async (r) => r.deleteRow('mains_tests', id));
  }, [push]);

  // ---------------------------------------------------------------- focus
  const addFocusSession = useCallback((s: Omit<FocusSession, 'id'>) => {
    const session: FocusSession = { ...s, id: uid('fs') };
    setDb((d) => ({ ...d, focusSessions: [...d.focusSessions, session] }));
    void push(`fs:${session.id}`, async (r) => {
      const ids = await r.insertFocusSessionsAndGetIds([session]);
      if (ids[0]) applyIdMap('focusSessions', { [session.id]: ids[0] });
    });
  }, [push, applyIdMap]);

  // ---------------------------------------------------------------- lectures
  const addLecture = useCallback((l: Partial<Lecture> & { subject: string }) => {
    const lec = normalizeLectureProgress<Lecture>({
      id: uid('lec'), title: l.title ?? l.subject, subject: l.subject, chapter: l.chapter ?? '',
      lectureNo: l.lectureNo ?? l.rangeStart ?? 1, totalLectures: l.totalLectures ?? 1,
      rangeStart: l.rangeStart ?? 1, rangeEnd: l.rangeEnd ?? (l.totalLectures ?? 1),
      completedLectures: l.completedLectures ?? [], source: l.source ?? '',
      pdfFollowed: l.pdfFollowed ?? '', shortNotesMade: l.shortNotesMade ?? false,
      notesLink: l.notesLink ?? '', revised: l.revised ?? false, revisionCount: l.revisionCount ?? 0,
      pyqsAttempted: l.pyqsAttempted ?? 0, status: l.status ?? 'not_started',
      lastWatchedAt: l.lastWatchedAt ?? null, completedAt: l.completedAt ?? null,
      notes: l.notes ?? '', createdAt: new Date().toISOString(),
    });
    setDb((d) => ({ ...d, lectures: [...d.lectures, lec] }));
    void push(`lec:${lec.id}`, async (r) => {
      const ids = await r.insertLecturesAndGetIds([lec]);
      if (ids[0]) applyIdMap('lectures', { [lec.id]: ids[0] });
    });
  }, [push, applyIdMap]);
  const updateLecture = useCallback((id: string, patch: Partial<Lecture>) => {
    const current = dbRef.current.lectures.find((l) => l.id === id);
    const merged: Lecture | null = current ? { ...current, ...patch } : null;
    setDb((d) => ({ ...d, lectures: d.lectures.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
    if (!merged) return;
    void push(`lec:${id}`, async (r) => {
      if (isUuid(id)) await r.updateLecture(id, merged);
      else { const ids = await r.insertLecturesAndGetIds([merged]); if (ids[0]) applyIdMap('lectures', { [id]: ids[0] }); }
    });
  }, [push, applyIdMap]);
  const deleteLecture = useCallback((id: string) => {
    setDb((d) => ({ ...d, lectures: d.lectures.filter((l) => l.id !== id) }));
    if (isUuid(id)) void push(`lec:${id}`, async (r) => r.deleteRow('lectures', id));
  }, [push]);

  // ---------------------------------------------------------------- current affairs
  const addCurrentAffair = useCallback((c: Partial<CurrentAffairItem> & { title: string }) => {
    const item: CurrentAffairItem = {
      id: uid('ca'), date: c.date ?? todayKey(), source: c.source ?? '',
      category: c.category ?? 'Other', title: c.title, summary: c.summary ?? '',
      relevance: c.relevance ?? 'both', revised: c.revised ?? false,
      revisionCount: c.revisionCount ?? 0, topicId: c.topicId ?? null, notes: c.notes ?? '',
      createdAt: new Date().toISOString(),
    };
    setDb((d) => ({ ...d, currentAffairs: [...d.currentAffairs, item] }));
    void push(`ca:${item.id}`, async (r) => {
      const ids = await r.insertCurrentAffairsAndGetIds([item]);
      if (ids[0]) applyIdMap('currentAffairs', { [item.id]: ids[0] });
    });
  }, [push, applyIdMap]);
  const updateCurrentAffair = useCallback((id: string, patch: Partial<CurrentAffairItem>) => {
    const current = dbRef.current.currentAffairs.find((c) => c.id === id);
    const merged: CurrentAffairItem | null = current ? { ...current, ...patch } : null;
    setDb((d) => ({ ...d, currentAffairs: d.currentAffairs.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
    if (!merged) return;
    void push(`ca:${id}`, async (r) => {
      if (isUuid(id)) await r.updateCurrentAffair(id, merged);
      else { const ids = await r.insertCurrentAffairsAndGetIds([merged]); if (ids[0]) applyIdMap('currentAffairs', { [id]: ids[0] }); }
    });
  }, [push, applyIdMap]);
  const deleteCurrentAffair = useCallback((id: string) => {
    setDb((d) => ({ ...d, currentAffairs: d.currentAffairs.filter((c) => c.id !== id) }));
    if (isUuid(id)) void push(`ca:${id}`, async (r) => r.deleteRow('current_affairs', id));
  }, [push]);

  // ---------------------------------------------------------------- answers
  const addAnswer = useCallback((a: Partial<AnswerEntry> & { question: string }) => {
    const entry: AnswerEntry = {
      id: uid('ans'), date: a.date ?? todayKey(), question: a.question, paper: a.paper ?? 'GS1',
      wordCount: a.wordCount ?? null, marksObtained: a.marksObtained ?? null,
      maxMarks: a.maxMarks ?? null, timeTakenMinutes: a.timeTakenMinutes ?? null,
      strengths: a.strengths ?? [], improvements: a.improvements ?? [], notes: a.notes ?? '',
      createdAt: new Date().toISOString(),
    };
    setDb((d) => ({ ...d, answers: [...d.answers, entry] }));
    void push(`ans:${entry.id}`, async (r) => {
      const ids = await r.insertAnswersAndGetIds([entry]);
      if (ids[0]) applyIdMap('answers', { [entry.id]: ids[0] });
    });
  }, [push, applyIdMap]);
  const updateAnswer = useCallback((id: string, patch: Partial<AnswerEntry>) => {
    const current = dbRef.current.answers.find((a) => a.id === id);
    const merged: AnswerEntry | null = current ? { ...current, ...patch } : null;
    setDb((d) => ({ ...d, answers: d.answers.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
    if (!merged) return;
    void push(`ans:${id}`, async (r) => {
      if (isUuid(id)) await r.updateAnswer(id, merged);
      else { const ids = await r.insertAnswersAndGetIds([merged]); if (ids[0]) applyIdMap('answers', { [id]: ids[0] }); }
    });
  }, [push, applyIdMap]);
  const deleteAnswer = useCallback((id: string) => {
    setDb((d) => ({ ...d, answers: d.answers.filter((a) => a.id !== id) }));
    if (isUuid(id)) void push(`ans:${id}`, async (r) => r.deleteRow('answers', id));
  }, [push]);

  // ---------------------------------------------------------------- settings
  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setDb((d) => ({ ...d, settings: { ...d.settings, ...patch } }));
    if (authState === 'signed-in') {
      if (settingsTimer.current) window.clearTimeout(settingsTimer.current);
      settingsTimer.current = window.setTimeout(() => {
        void push('settings', async (r) => r.upsertSettings(dbRef.current.settings));
      }, 600);
    }
  }, [authState, push]);

  /** Study the user forgot to time. Same focus-session pipeline as the timer. */
  const logManualStudy = useCallback((input: ManualStudyInput, idempotencyKey?: string): { ok: boolean; error?: string } => {
    const minutes = Math.round(Number(input.durationMinutes) * 10) / 10;
    if (!Number.isFinite(minutes) || minutes <= 0) return { ok: false, error: 'Enter a duration of at least 1 minute.' };
    if (minutes > 24 * 60) return { ok: false, error: 'A single log cannot exceed 24 hours.' };
    const key = idempotencyKey ?? `${input.date}|${input.time ?? ''}|${minutes}|${input.taskName.trim()}`;
    if (manualLogKeys.current.has(key)) return { ok: false, error: 'That log was already saved.' };
    manualLogKeys.current.add(key);
    const session: FocusSession = {
      id: uid('fs'),
      startedAt: composeManualStartedAt(input.date, input.time),
      durationMinutes: minutes,
      taskName: input.taskName.trim() || 'Manual study log',
      sessionType: 'focus',
      completed: true,
    };
    setDb((d) => ({ ...d, focusSessions: [...d.focusSessions, session] }));
    void push(`fs:${session.id}`, async (r) => {
      const ids = await r.insertFocusSessionsAndGetIds([session]);
      if (ids[0]) applyIdMap('focusSessions', { [session.id]: ids[0] });
    });
    return { ok: true };
  }, [push, applyIdMap]);

  /** Drop abandoned session records from earlier application days.
   * Completed sessions stay — Study Hours and Analytics read them directly. */
  const pruneStaleSessions = useCallback(() => {
    const day = applicationDayKey();
    let lastRun = '';
    try { lastRun = localStorage.getItem(SESSION_PRUNE_KEY) ?? ''; } catch { /* storage is optional */ }
    if (lastRun === day) return;
    const stale = dbRef.current.focusSessions
      .filter((session) => !session.completed && applicationDayKey(new Date(session.startedAt)) < day)
      .map((session) => session.id);
    try { localStorage.setItem(SESSION_PRUNE_KEY, day); } catch { /* best effort */ }
    if (!stale.length) return;
    const staleIds = new Set(stale);
    const cloudIds = stale.filter(isUuid);
    setDb((d) => ({ ...d, focusSessions: d.focusSessions.filter((session) => !staleIds.has(session.id)) }));
    if (!cloudIds.length) return;
    void push(`prune-sessions:${day}`, async () => {
      const sb = activeClient();
      const userId = userIdRef.current;
      if (!userId) return;
      const { error } = await sb.from('focus_sessions').delete().in('id', cloudIds).eq('user_id', userId);
      if (error) throw new Error(`focus_sessions: ${error.message}`);
    });
  }, [push, activeClient]);

  // Rollover watcher: prune as soon as a new application day starts.
  useEffect(() => {
    pruneStaleSessions();
    let day = applicationDayKey();
    const id = window.setInterval(() => {
      const now = applicationDayKey();
      if (now !== day) { day = now; pruneStaleSessions(); }
    }, 30000);
    return () => window.clearInterval(id);
  }, [pruneStaleSessions]);

  /** Full data wipe: local cache + cloud rows. Auth, Remember-Me session,
   * theme and sidebar preferences survive; preparation data does not. */
  const wipeAllData = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    // 1. Invalidate every in-flight pull/push before anything else changes.
    syncEpoch.current += 1;
    pendingOps.current.clear();
    progressDirty.current.clear();
    if (progressTimer.current) { window.clearTimeout(progressTimer.current); progressTimer.current = undefined; }
    if (settingsTimer.current) { window.clearTimeout(settingsTimer.current); settingsTimer.current = undefined; }
    setSyncStatus((s) => ({ ...s, pending: 0, syncing: false, lastError: null }));

    // 2. Forget short-lived timer/session caches (never `mup.auth`).
    try {
      for (const key of Object.keys(localStorage)) {
        if (CACHE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) localStorage.removeItem(key);
      }
      localStorage.removeItem(DB_KEY);
    } catch { /* storage may be unavailable */ }

    // 3. Empty local state, keeping preferences the user chose.
    setDb((d) => ({ ...newDatabase(), version: DB_VERSION, settings: d.settings }));

    // 4. Delete the cloud rows (FK-safe order). Idempotent: safe to re-run.
    const userId = userIdRef.current;
    if (authState !== 'signed-in' || !userId || !isCloudConfigured) return { ok: true };
    try {
      const sb = activeClient();
      for (const table of USER_DATA_TABLES) {
        const { error } = await sb.from(table).delete().eq('user_id', userId);
        if (error) throw new Error(`${table}: ${error.message}`);
      }
      try { localStorage.setItem(wipeMarkerKey(userId), new Date().toISOString()); } catch { /* marker is best effort */ }
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSyncStatus((s) => ({ ...s, lastError: msg }));
      return { ok: false, error: msg };
    }
  }, [authState, activeClient]);

  const replaceDb = useCallback((next: MupDatabase) => setDb(next), []);
  const resetProgressOnly = useCallback(() => {
    setDb((d) => ({ ...d, progress: {}, revisionLogs: [] }));
    void push('reset-progress', async () => {
      const sb = activeClient();
      const userId = userIdRef.current;
      if (!userId) return;
      await sb.from('syllabus_progress').delete().eq('user_id', userId);
      await sb.from('revision_logs').delete().eq('user_id', userId);
    });
  }, [push, activeClient]);

  // ---------------------------------------------------------------- auth flows
  const mergeRemoteIntoLocal = useCallback((remote: Partial<MupDatabase> & { counts?: Record<string, number> }) => {
    setDb((d) => {
      const union = <T extends { id: string }>(localArr: T[], remoteArr: T[] = []) => {
        const byId = new Map(localArr.map((x) => [x.id, x]));
        for (const r2 of remoteArr) if (!byId.has(r2.id)) byId.set(r2.id, r2);
        return [...byId.values()];
      };
      const progress = { ...d.progress };
      for (const [id, p] of Object.entries(remote.progress ?? {})) {
        const local = progress[id];
        if (!local) progress[id] = p;
        else if (p.revisionCount > local.revisionCount || (local.status !== 'completed' && p.status === 'completed')) progress[id] = p;
      }
      return {
        ...d,
        settings: remote.settings ? { ...d.settings, ...remote.settings, theme: d.settings.theme } : d.settings,
        progress,
        tasks: union(d.tasks, remote.tasks),
        revisionLogs: union(d.revisionLogs, remote.revisionLogs),
        pyqs: union(d.pyqs, remote.pyqs),
        prelimsTests: union(d.prelimsTests, remote.prelimsTests),
        mainsTests: union(d.mainsTests, remote.mainsTests),
        focusSessions: union(d.focusSessions, remote.focusSessions),
        habits: union(d.habits, remote.habits),
        habitCompletions: union(d.habitCompletions, remote.habitCompletions),
        lectures: union(d.lectures, remote.lectures),
        currentAffairs: union(d.currentAffairs, remote.currentAffairs),
        answers: union(d.answers, remote.answers),
      };
    });
  }, []);

  /** First sign-in into an empty account: push this device's local records up
   * once, in the background, then adopt their cloud identity locally.
   *
   * Deliberately additive and idempotent-by-flag: the account is empty when
   * this runs, so a re-run could only ever add rows that are not there yet —
   * never a second copy of the database. Failure is non-fatal: the device keeps
   * everything and the next sign-in retries. */
  const importLocalData = useCallback(async (r: Repository) => {
    const userId = userIdRef.current;
    if (!userId) return;
    try {
      const maps = await r.importLocalToCloud(dbRef.current);
      const remap: [string, Record<string, string>][] = [
        ['revisionLogs', maps.revisionLogIdMap],
        ['habits', maps.habitIdMap],
        ['habitCompletions', maps.habitCompletionIdMap],
        ['tasks', maps.taskIdMap],
        ['pyqs', maps.pyqIdMap],
        ['prelimsTests', maps.prelimsTestIdMap],
        ['mainsTests', maps.mainsTestIdMap],
        ['focusSessions', maps.focusSessionIdMap],
        ['lectures', maps.lectureIdMap],
        ['currentAffairs', maps.currentAffairIdMap],
        ['answers', maps.answerIdMap],
      ];
      const remapped = remap.reduce((d, [entity, map]) => remapEntityIds(d, entity, map), dbRef.current);
      // Adopt the cloud ids in one shot and persist them immediately: the cloud
      // rows already live under those uuids, so a stale local copy surviving a
      // quick close would come back as a second copy of every record.
      dbRef.current = remapped;
      setDb(remapped);
      saveDbNow(remapped);
      try { localStorage.setItem(migratedFlagKey(userId), new Date().toISOString()); } catch { /* flag is best effort */ }
    } catch (e) {
      setSyncStatus((s) => ({ ...s, lastError: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  const afterSignIn = useCallback(async (userId: string, email: string) => {
    userIdRef.current = userId;
    setAccountEmail(email);
    // The repository must query through the client that owns the session,
    // otherwise PostgREST calls go out unauthenticated.
    const r = new Repository(activeClient(), userId);
    repoRef.current = r;
    const epoch = syncEpoch.current;
    try {
      const remote = await r.pullAll();
      // A wipe happened while this pull was in flight — its payload is stale.
      if (epoch !== syncEpoch.current) return;
      const remoteCount = Object.values(remote.counts).reduce((a, b) => a + (b as number), 0);
      const d = dbRef.current;
      const localCount = d.tasks.length + Object.keys(d.progress).length + d.pyqs.length + d.lectures.length +
        d.answers.length + d.currentAffairs.length + d.prelimsTests.length + d.mainsTests.length +
        d.focusSessions.length + d.habits.length + d.revisionLogs.length;
      // Importing local data is a one-time, per-account event; a wipe on this
      // device also suppresses it (re-uploading the records the user just
      // deleted would undo the wipe).
      const alreadyImported = Boolean(localStorage.getItem(migratedFlagKey(userId)))
        || Boolean(localStorage.getItem(wipeMarkerKey(userId)));
      mergeRemoteIntoLocal(remote);
      if (!alreadyImported && localCount > 0 && remoteCount === 0) {
        // First sign-in on a device that already holds preparation data, into an
        // account that is still empty: upload it once, silently. There is no
        // prompt and no "re-import" step — the cloud is empty, so this can never
        // duplicate or overwrite anything, and it is skipped from then on.
        await importLocalData(r);
      } else if (!alreadyImported && localCount === 0 && remoteCount === 0) {
        // brand-new account on a fresh device — seed profile with current settings
        void r.upsertSettings(d.settings).catch(() => {});
      }
      setSyncStatus((s) => ({ ...s, lastSyncAt: new Date().toISOString(), lastError: null }));
    } catch (e) {
      setSyncStatus((s) => ({ ...s, lastError: e instanceof Error ? e.message : String(e) }));
    }
    setAuthState('signed-in');
  }, [mergeRemoteIntoLocal, activeClient, importLocalData]);

  /** Central SIGNED_OUT handler (shared by both clients). */
  const handleSignedOut = useCallback((event: string) => {
    if (event !== 'SIGNED_OUT') return;
    authClientRef.current = null;
    repoRef.current = null; userIdRef.current = null;
    setAccountEmail(null);
    setAuthState('gate');
  }, []);

  // The memory-only client (remember-me OFF) is created lazily — only when
  // actually needed — and gets its own SIGNED_OUT listener at that point.
  const sessionOnlySubRef = useRef<{ unsubscribe: () => void } | null>(null);
  const listenSessionOnlyClient = useCallback(() => {
    if (sessionOnlySubRef.current) return;
    const { data: sub } = getSessionOnlySupabase().auth.onAuthStateChange(handleSignedOut);
    sessionOnlySubRef.current = sub.subscription;
  }, [handleSignedOut]);

  const signIn = useCallback(async (email: string, password: string, rememberMe: boolean = true) => {
    if (!isCloudConfigured) return { error: 'Cloud sync is not configured.' };
    // "Remember me" on  → persistent client (session stored in this browser's
    //                      localStorage, survives reloads).
    // "Remember me" off → memory-only client (session lives for this page
    //                      session; nothing is written to storage).
    const sb = rememberMe ? getSupabase() : getSessionOnlySupabase();
    if (!rememberMe) listenSessionOnlyClient();
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return { error: error.message };
      if (!data.session) return { needsConfirmation: true };
      authClientRef.current = sb;
      await afterSignIn(data.session.user.id, data.session.user.email ?? email);
      return {};
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Network error — check your connection.' };
    }
  }, [afterSignIn]);

  const signUp = useCallback(async (email: string, password: string) => {
    if (!isCloudConfigured) return { error: 'Cloud sync is not configured.' };
    try {
      const sb = getSupabase();
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) return { error: error.message };
      if (!data.session) return { needsConfirmation: true };
      authClientRef.current = sb;
      await afterSignIn(data.session.user.id, data.session.user.email ?? email);
      return {};
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Network error — check your connection.' };
    }
  }, [afterSignIn]);

  const logout = useCallback(async () => {
    if (isCloudConfigured) {
      try { await activeClient().auth.signOut(); } catch { /* ignore */ }
    }
    authClientRef.current = null;
    repoRef.current = null;
    userIdRef.current = null;
    pendingOps.current.clear();
    setSyncStatus((s) => ({ ...s, pending: 0 }));
    setAccountEmail(null);
    setAuthState(isCloudConfigured ? 'gate' : 'local');
  }, [activeClient]);

  const continueLocal = useCallback(() => setAuthState('local'), []);

  // ---------------------------------------------------------------- boot
  useEffect(() => {
    if (!isCloudConfigured) { setAuthState('local'); return; }
    // Only the persistent client can have a stored session to restore on load
    // (a "remember me" OFF session is memory-only and never survives a reload).
    const sb = getSupabase();
    let cancelled = false;
    (async () => {
      try {
        const { data } = await sb.auth.getSession();
        if (cancelled) return;
        const session = data.session;
        if (session?.user) {
          authClientRef.current = sb;
          await afterSignIn(session.user.id, session.user.email ?? 'you');
        }
        else setAuthState('gate');
      } catch {
        if (!cancelled) setAuthState('gate');
      }
    })();
    const { data: sub } = sb.auth.onAuthStateChange(handleSignedOut);
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
      sessionOnlySubRef.current?.unsubscribe();
      sessionOnlySubRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<StoreValue>(() => ({
    db, setDb,
    authState, syncStatus, accountEmail,
    continueLocal, signIn, signUp, logout, flushSync,
    getProgress, setItemStatus, setItemNotes, reviseItem, resetRevision, bulkSetStatus,
    addTask, addTasks, updateTask, toggleTask, deleteTask,
    addPrelimsTest, deletePrelimsTest, addMainsTest, deleteMainsTest,
    addFocusSession, logManualStudy, pruneStaleSessions,
    addLecture, updateLecture, deleteLecture,
    addCurrentAffair, updateCurrentAffair, deleteCurrentAffair,
    addAnswer, updateAnswer, deleteAnswer,
    updateSettings, replaceDb, resetProgressOnly, wipeAllData,
  }), [db, authState, syncStatus, accountEmail,
    continueLocal, signIn, signUp, logout, flushSync,
    getProgress, setItemStatus, setItemNotes, reviseItem, resetRevision, bulkSetStatus,
    addTask, addTasks, updateTask, toggleTask, deleteTask,
    addPrelimsTest, deletePrelimsTest, addMainsTest, deleteMainsTest,
    addFocusSession, logManualStudy, pruneStaleSessions,
    addLecture, updateLecture, deleteLecture,
    addCurrentAffair, updateCurrentAffair, deleteCurrentAffair,
    addAnswer, updateAnswer, deleteAnswer,
    updateSettings, replaceDb, resetProgressOnly, wipeAllData]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}

/** Convenience: revision bucket for an item, given progress. */
export function itemBucket(itemId: string, db: MupDatabase) {
  const p = db.progress[itemId];
  return revisionBucket(p?.nextRevisionAt ?? null, p?.revisionCount ?? 0, new Date());
}

export { newDatabase };
