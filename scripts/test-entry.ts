/** Test entry — exports everything the logic tests need. */
export * from '../src/lib/date';
export * from '../src/lib/revision';
export * from '../src/lib/tasks';
export * from '../src/lib/lectures';
export * from '../src/lib/syllabusProgress';
export * from '../src/lib/studyLog';
export * from '../src/lib/progressState';
export * from '../src/config/exams';
export { syllabus } from '../src/data/syllabus';
export { StoreProvider, useStore } from '../src/store/store';
export { Settings } from '../src/pages/Settings';
export { FocusTimerProvider, useFocusTimer } from '../src/ui/focusTimer';
export { ToastProvider } from '../src/ui/toast';
export { statusOf, treeStats, dashboardStats, revisionQueue, lectureSummary, prelimsAnalytics, confidenceSplit, focusMinutesByApplicationDay, taskTrend } from '../src/store/selectors';
export { loadDb, saveDb, migrate, newDatabase, exportDb, parseBackup, DB_VERSION } from '../src/store/db';
