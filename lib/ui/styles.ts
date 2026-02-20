/**
 * Shared CSS styles for the DevClaw UI dashboard.
 * Mobile-first, dark theme matching the gateway aesthetic.
 */

export const CSS = `
  :root {
    --bg: #0d1117;
    --bg-card: #161b22;
    --bg-hover: #1c2129;
    --border: #30363d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --red: #f85149;
    --orange: #d29922;
    --purple: #bc8cff;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    --mono: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    padding: 16px;
    max-width: 960px;
    margin: 0 auto;
    -webkit-text-size-adjust: 100%;
  }

  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  h1 {
    font-size: 1.4rem;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h1 .refresh {
    margin-left: auto;
    font-size: 0.8rem;
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
  }
  h1 .refresh:hover { color: var(--accent); }

  .back { display: inline-block; margin-bottom: 12px; font-size: 0.9rem; }

  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }

  .card-title {
    font-size: 1.1rem;
    font-weight: 600;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .worker-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    font-size: 0.9rem;
    border-bottom: 1px solid var(--border);
  }
  .worker-row:last-child { border-bottom: none; }

  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .badge-active { background: rgba(63, 185, 80, 0.15); color: var(--green); }
  .badge-idle { background: rgba(139, 148, 158, 0.15); color: var(--text-muted); }
  .badge-role { background: rgba(88, 166, 255, 0.15); color: var(--accent); }
  .badge-level { background: rgba(188, 140, 255, 0.15); color: var(--purple); }

  .progress-bar {
    width: 100%;
    height: 8px;
    background: var(--border);
    border-radius: 4px;
    overflow: hidden;
    margin: 4px 0;
  }
  .progress-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.3s;
  }
  .progress-low { background: var(--green); }
  .progress-mid { background: var(--orange); }
  .progress-high { background: var(--red); }

  .stat { display: flex; justify-content: space-between; padding: 4px 0; font-size: 0.85rem; }
  .stat-label { color: var(--text-muted); }

  .queue-summary {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 8px;
    font-size: 0.85rem;
  }
  .queue-item { color: var(--text-muted); }
  .queue-item strong { color: var(--text); }

  .session-list .session-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
  }
  .session-item:last-child { border-bottom: none; }

  .btn {
    display: inline-block;
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-card);
    color: var(--text);
    cursor: pointer;
    font-size: 0.85rem;
  }
  .btn:hover { background: var(--bg-hover); border-color: var(--accent); }
  .btn-danger { border-color: var(--red); color: var(--red); }
  .btn-danger:hover { background: rgba(248, 81, 73, 0.1); }

  .toggle-group {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    margin-bottom: 12px;
  }
  .toggle-group button {
    flex: 1;
    padding: 6px 12px;
    border: none;
    background: var(--bg-card);
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.85rem;
  }
  .toggle-group button.active {
    background: var(--accent);
    color: #fff;
  }

  .file-tree {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-card);
    overflow: hidden;
    margin-bottom: 12px;
  }
  .file-tree-item {
    padding: 6px 12px;
    cursor: pointer;
    font-size: 0.85rem;
    font-family: var(--mono);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .file-tree-item:last-child { border-bottom: none; }
  .file-tree-item:hover { background: var(--bg-hover); }
  .file-tree-item.active { background: rgba(88, 166, 255, 0.1); color: var(--accent); }
  .file-tree-item .additions { color: var(--green); font-size: 0.75rem; }
  .file-tree-item .deletions { color: var(--red); font-size: 0.75rem; }

  .diff-stats {
    font-size: 0.85rem;
    color: var(--text-muted);
    margin-bottom: 8px;
  }
  .diff-stats .add { color: var(--green); }
  .diff-stats .del { color: var(--red); }

  /* Dropdown file selector for mobile */
  .file-select {
    width: 100%;
    padding: 8px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: var(--mono);
    font-size: 0.85rem;
    margin-bottom: 12px;
  }

  /* Desktop: side by side layout */
  @media (min-width: 768px) {
    .diff-layout {
      display: grid;
      grid-template-columns: 240px 1fr;
      gap: 12px;
    }
    .file-select { display: none; }
  }
  @media (max-width: 767px) {
    .file-tree { display: none; }
  }

  .empty { color: var(--text-muted); font-style: italic; padding: 12px 0; }

  .error-msg {
    background: rgba(248, 81, 73, 0.1);
    border: 1px solid var(--red);
    border-radius: 6px;
    padding: 12px;
    color: var(--red);
  }

  /* diff2html overrides for dark theme */
  .d2h-wrapper { font-family: var(--mono); font-size: 0.8rem; }
  .d2h-file-header { background: var(--bg-card) !important; color: var(--text) !important; border-color: var(--border) !important; }
  .d2h-file-wrapper { border-color: var(--border) !important; margin-bottom: 12px; }
  .d2h-code-linenumber { background: var(--bg) !important; color: var(--text-muted) !important; border-color: var(--border) !important; }
  .d2h-code-line { background: var(--bg) !important; color: var(--text) !important; }
  .d2h-ins { background: rgba(63, 185, 80, 0.1) !important; }
  .d2h-del { background: rgba(248, 81, 73, 0.1) !important; }
  .d2h-ins .d2h-code-line-ctn { background: transparent !important; }
  .d2h-del .d2h-code-line-ctn { background: transparent !important; }
  .d2h-info { background: rgba(88, 166, 255, 0.1) !important; color: var(--accent) !important; }
  .d2h-tag { display: none !important; }
`;
