/** App shell: sidebar navigation + topbar. */
import React, { useEffect, useState } from 'react';
import { navigate, useRoute } from './router';
import { useStore } from '../store/store';
import { dashboardStats } from '../store/selectors';
import { downloadBackup } from '../store/db';
import { useToast } from './toast';
import { isCloudConfigured } from '../lib/supabase';
import { applyTheme } from '../lib/theme';

const NAV: { section: string; items: { to: string; icon: string; label: string; badge?: 'revision' | 'tasks' }[] }[] = [
  {
    section: 'Overview',
    items: [
      { to: '/dashboard', icon: '◉', label: 'Dashboard' },
      { to: '/calendar', icon: '▦', label: 'Calendar' },
    ],
  },
  {
    section: 'Syllabus & Memory',
    items: [
      { to: '/syllabus', icon: '☰', label: 'Operational Syllabus' },
      { to: '/revision', icon: '↻', label: 'Revision R1–R5', badge: 'revision' },
    ],
  },
  {
    section: 'Daily Practice',
    items: [
      { to: '/tasks', icon: '✓', label: 'Daily Planner', badge: 'tasks' },
      { to: '/timer', icon: '⏱', label: 'Study Timer' },
      { to: '/tests', icon: 'A', label: 'Test Tracker' },
      { to: '/answers', icon: '✎', label: 'Answer Writing' },
      { to: '/current-affairs', icon: '☾', label: 'Current Affairs' },
      { to: '/lectures', icon: '▶', label: 'Geo Lectures' },
    ],
  },
  {
    section: 'Insights',
    items: [
      { to: '/hours', icon: '▥', label: 'Study Hours' },
      { to: '/analytics', icon: '◭', label: 'Prep Analytics' },
    ],
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const [route, navigateTo] = useRoute();
  const { db, updateSettings, authState, syncStatus, flushSync } = useStore();
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('mup.sidebar.collapsed') === 'true'; } catch { return false; }
  });
  const stats = dashboardStats(db);

  useEffect(() => { setOpen(false); }, [route]);
  const toggleCollapsed = () => setCollapsed((value) => {
    const next = !value;
    try { localStorage.setItem('mup.sidebar.collapsed', String(next)); } catch { /* optional preference */ }
    return next;
  });

  const theme = db.settings.theme;
  const formatHours = (minutes: number) => {
    const hours = Math.round((minutes / 60) * 100) / 100;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  };
  const toggleTheme = () => {
    applyTheme(theme === 'dark' ? 'light' : 'dark', updateSettings);
  };

  const badge = (b?: 'revision' | 'tasks') => {
    if (!b) return null;
    if (b === 'revision') {
      const n = stats.revision.dueToday + stats.revision.overdue;
      return n > 0 ? <span className="nav-badge">{n}</span> : null;
    }
    const n = stats.tasks.today - stats.tasks.done;
    return n > 0 ? <span className="nav-badge neutral">{n}</span> : null;
  };

  const titleFor = (r: string) => NAV.flatMap((s) => s.items).find((i) => i.to === r)?.label ?? 'Dashboard';

  return (
    <div className={`shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      {open && <div className="sidebar-backdrop show" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          <img className="brand-mark" src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="" />
          <div className="brand-copy">
            <img className="brand-wordmark-img" src={`${import.meta.env.BASE_URL}logo/preptrack-wordmark-light.png`} alt="PREPTRACK" />
            <div className="brand-sub">CSE {db.settings.targetExamYear} · {db.settings.optional}</div>
          </div>
          <button className="sidebar-collapse-btn" onClick={toggleCollapsed} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{collapsed ? '›' : '‹'}</button>
        </div>
        {NAV.map((sec) => (
          <React.Fragment key={sec.section}>
            <div className="nav-section">{sec.section}</div>
            <nav className="nav">
              {sec.items.map((item) => (
                <button key={item.to} title={collapsed ? item.label : undefined} aria-label={item.label} className={`nav-item ${route === item.to ? 'active' : ''}`} onClick={() => navigateTo(item.to)}>
                  <span className="ico">{item.icon}</span>
                  <span className="nav-label">{item.label}</span>
                  {badge(item.badge)}
                </button>
              ))}
            </nav>
          </React.Fragment>
        ))}
        <div className="nav-section">System</div>
        <nav className="nav" style={{ paddingBottom: 6 }}>
          <button title={collapsed ? 'Settings & Backup' : undefined} aria-label="Settings & Backup" className={`nav-item ${route === '/settings' ? 'active' : ''}`} onClick={() => navigateTo('/settings')}>
            <span className="ico">⚙</span><span className="nav-label">Settings & Backup</span>
          </button>
        </nav>
        <div className="sidebar-foot">
          <div className="card card-pad sidebar-today" style={{ padding: '10px 12px' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="tiny" style={{ fontWeight: 700, color: 'var(--text-faint)', letterSpacing: '0.06em' }}>TODAY</span>
              <span className="tiny mono" style={{ fontWeight: 700, color: 'var(--ok)' }}>{formatHours(stats.todayMinutes)} / {formatHours(db.settings.dailyTargetMinutes)}</span>
            </div>
            <div className="bar ok thin" style={{ marginTop: 6 }}>
              <div style={{ width: `${Math.min(100, (stats.todayMinutes / db.settings.dailyTargetMinutes) * 100)}%` }} />
            </div>
            <div className="tiny muted" style={{ marginTop: 6 }}>🔥 {stats.streak}-day streak · {stats.revision.dueToday} revisions due</div>
          </div>
          <div className="row" style={{ marginTop: 8, gap: 6 }}>
            <button className="btn sm ghost grow sidebar-theme" onClick={toggleTheme} title="Toggle theme"><span>{theme === 'dark' ? '☾' : '☀'}</span><span className="nav-label">{theme === 'dark' ? 'Dark' : 'Light'}</span></button>
            <button className="btn sm ghost" onClick={() => { downloadBackup(db); push('Backup downloaded', 'ok'); }} title="Download backup">⤓</button>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label="Menu">☰</button>
          <span className="crumb">{titleFor(route)}</span>
          <span className="spacer" />
          {authState === 'signed-in' ? (
            <button
              className={`chip click ${syncStatus.pending > 0 ? 'warn' : syncStatus.lastError ? 'bad' : 'ok'}`}
              title={syncStatus.lastError ? `Sync issue: ${syncStatus.lastError} — click to retry` : syncStatus.pending ? 'Changes saved locally; will retry sync' : 'All changes synced to your account'}
              onClick={() => { void flushSync(); }}
            >
              {syncStatus.syncing ? '⟳ Syncing…' : syncStatus.pending > 0 ? `⚠ ${syncStatus.pending} pending` : syncStatus.lastError ? '⚠ Sync issue' : '☁ Synced'}
            </button>
          ) : (
            <button
              className="chip click"
              title={isCloudConfigured
                ? 'Running in local mode — sign in from Settings to sync'
                : 'This build runs fully on this device — cloud sync is not configured in it'}
              onClick={() => navigateTo('/settings')}
            >☰ Local mode</button>
          )}
          <span className="tiny muted mono">{new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
          <button className="icon-btn" onClick={toggleTheme} aria-label="Toggle theme">{theme === 'dark' ? '☀' : '☾'}</button>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
