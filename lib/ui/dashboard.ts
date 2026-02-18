/**
 * Dashboard page — project cards, worker status, queue summary, token usage.
 * Mobile-first layout with auto-refresh.
 */
import { CSS } from "./styles.js";

export function generateDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DevClaw Dashboard</title>
  <style>${CSS}</style>
</head>
<body>
  <h1>
    ⚙️ DevClaw
    <span class="refresh" id="refresh" title="Auto-refreshing every 5s">⟳ <span id="countdown">5</span>s</span>
  </h1>
  <div id="queue-summary"></div>
  <div id="projects"></div>
  <div id="sessions-section"></div>

  <script>
    let refreshInterval = 5000;
    let countdownTimer;
    let countdownValue;

    function timeAgo(ts) {
      if (!ts) return '—';
      const d = typeof ts === 'string' ? new Date(ts) : new Date(ts);
      const s = Math.floor((Date.now() - d.getTime()) / 1000);
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    }

    function progressClass(pct) {
      if (pct < 50) return 'progress-low';
      if (pct < 80) return 'progress-mid';
      return 'progress-high';
    }

    function roleIcon(role) {
      const icons = { developer: '🔧', tester: '🧪', reviewer: '👀', architect: '🏗️' };
      return icons[role] || '📋';
    }

    function renderWorker(role, w) {
      const active = w.active;
      const statusBadge = active
        ? '<span class="badge badge-active">active</span>'
        : '<span class="badge badge-idle">idle</span>';
      const roleBadge = '<span class="badge badge-role">' + role.slice(0, 3).toUpperCase() + '</span>';
      const levelBadge = w.level ? '<span class="badge badge-level">' + w.level + '</span>' : '';

      let detail = '';
      if (active && w.issueId) {
        detail += ' <a href="javascript:void(0)" style="color:var(--text)">#' + w.issueId + '</a>';
        if (w.startTime) detail += ' · ' + timeAgo(w.startTime);
      }

      let tokenBar = '';
      if (w.sessionData) {
        const pct = Math.round(w.sessionData.percentUsed || 0);
        tokenBar = '<div style="flex:1;max-width:120px"><div class="progress-bar"><div class="progress-fill ' + progressClass(pct) + '" style="width:' + pct + '%"></div></div><div style="font-size:0.7rem;color:var(--text-muted);text-align:right">' + pct + '%</div></div>';
      }

      const sessionKey = w.level && w.sessions ? w.sessions[w.level] : null;
      const link = sessionKey ? '/devclaw-ui/session/' + encodeURIComponent(sessionKey) : null;

      return '<div class="worker-row">' +
        roleIcon(role) + ' ' + roleBadge + ' ' + levelBadge + ' ' + statusBadge + detail +
        (tokenBar ? '<div style="margin-left:auto;display:flex;align-items:center;gap:8px">' + tokenBar + '</div>' : '') +
        (link ? '<a href="' + link + '" style="font-size:0.75rem">details →</a>' : '') +
        '</div>';
    }

    function renderProject(p) {
      const roles = Object.entries(p.workers);
      let html = '<div class="card"><div class="card-title">● ' + (p.name || p.slug) + '</div>';
      if (roles.length === 0) {
        html += '<div class="empty">No workers configured</div>';
      } else {
        for (const [role, worker] of roles) {
          html += renderWorker(role, worker);
        }
      }
      html += '</div>';
      return html;
    }

    function renderQueue(q) {
      const items = [];
      if (q.toImprove > 0) items.push('<span class="queue-item" style="color:var(--orange)">⚠️ <strong>' + q.toImprove + '</strong> To Improve</span>');
      if (q.toDo > 0) items.push('<span class="queue-item">📋 <strong>' + q.toDo + '</strong> To Do</span>');
      if (q.toReview > 0) items.push('<span class="queue-item">👀 <strong>' + q.toReview + '</strong> To Review</span>');
      if (q.toTest > 0) items.push('<span class="queue-item">🧪 <strong>' + q.toTest + '</strong> To Test</span>');
      if (items.length === 0) return '<div class="queue-summary" style="color:var(--text-muted)">Queue empty</div>';
      return '<div class="queue-summary">' + items.join('') + '</div>';
    }

    function renderSessions(sessions) {
      const entries = Object.entries(sessions);
      if (entries.length === 0) return '';
      let html = '<div class="card" style="margin-top:16px"><div class="card-title">📡 Sessions (' + entries.length + ' active)</div><div class="session-list">';
      for (const [key, s] of entries) {
        const pct = Math.round(s.percentUsed || 0);
        html += '<div class="session-item"><a href="/devclaw-ui/session/' + encodeURIComponent(key) + '">' + key + '</a><div style="display:flex;align-items:center;gap:8px"><div class="progress-bar" style="width:80px"><div class="progress-fill ' + progressClass(pct) + '" style="width:' + pct + '%"></div></div><span style="font-size:0.75rem;color:var(--text-muted)">' + pct + '%</span></div></div>';
      }
      html += '</div></div>';
      return html;
    }

    function startCountdown() {
      countdownValue = refreshInterval / 1000;
      document.getElementById('countdown').textContent = countdownValue;
      clearInterval(countdownTimer);
      countdownTimer = setInterval(() => {
        countdownValue--;
        if (countdownValue <= 0) countdownValue = refreshInterval / 1000;
        document.getElementById('countdown').textContent = countdownValue;
      }, 1000);
    }

    async function fetchAndRender() {
      try {
        const res = await fetch('/devclaw-ui/api/status');
        const data = await res.json();
        document.getElementById('queue-summary').innerHTML = renderQueue(data.queue);
        document.getElementById('projects').innerHTML = data.projects.map(renderProject).join('');
        document.getElementById('sessions-section').innerHTML = renderSessions(data.sessions);
      } catch (e) {
        document.getElementById('projects').innerHTML = '<div class="error-msg">Failed to load: ' + e.message + '</div>';
      }
      startCountdown();
    }

    fetchAndRender();
    setInterval(fetchAndRender, refreshInterval);
    document.getElementById('refresh').addEventListener('click', fetchAndRender);
  </script>
</body>
</html>`;
}
