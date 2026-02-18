/**
 * Session Inspector page — token usage, context progress, issue/PR links.
 */
import { CSS } from "./styles.js";

export function generateSessionPage(sessionKey: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Session: ${escapeHtml(sessionKey)}</title>
  <style>${CSS}</style>
</head>
<body>
  <a href="/devclaw-ui/" class="back">← Dashboard</a>
  <h1>📡 Session Inspector</h1>
  <div id="content"><div class="empty">Loading...</div></div>

  <script>
    const sessionKey = ${JSON.stringify(sessionKey)};

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

    async function load() {
      try {
        const res = await fetch('/devclaw-ui/api/status');
        const data = await res.json();

        const session = data.sessions[sessionKey];

        // Find the worker that uses this session
        let workerInfo = null;
        for (const p of data.projects) {
          for (const [role, w] of Object.entries(p.workers)) {
            const sk = w.level && w.sessions ? w.sessions[w.level] : null;
            if (sk === sessionKey) {
              workerInfo = { project: p, role, worker: w };
              break;
            }
          }
          if (workerInfo) break;
        }

        let html = '<div class="card"><div class="card-title">' + sessionKey + '</div>';

        if (workerInfo) {
          const w = workerInfo.worker;
          html += '<div class="stat"><span class="stat-label">Project</span><span>' + workerInfo.project.name + '</span></div>';
          html += '<div class="stat"><span class="stat-label">Role</span><span>' + workerInfo.role.toUpperCase() + '</span></div>';
          if (w.level) html += '<div class="stat"><span class="stat-label">Level</span><span>' + w.level + '</span></div>';
          if (w.issueId) html += '<div class="stat"><span class="stat-label">Issue</span><span>#' + w.issueId + '</span></div>';
          html += '<div class="stat"><span class="stat-label">Status</span><span>' + (w.active ? '<span class="badge badge-active">active</span>' : '<span class="badge badge-idle">idle</span>') + '</span></div>';
          if (w.startTime) html += '<div class="stat"><span class="stat-label">Started</span><span>' + timeAgo(w.startTime) + '</span></div>';
        }
        html += '</div>';

        if (session) {
          const pct = Math.round(session.percentUsed || 0);
          html += '<div class="card"><div class="card-title">Context Usage</div>';
          html += '<div class="progress-bar" style="height:16px;margin:8px 0"><div class="progress-fill ' + progressClass(pct) + '" style="width:' + pct + '%"></div></div>';
          html += '<div style="text-align:center;font-size:1.2rem;font-weight:600;margin:8px 0">' + pct + '%</div>';
          if (session.updatedAt) html += '<div class="stat"><span class="stat-label">Last updated</span><span>' + timeAgo(session.updatedAt) + '</span></div>';
          if (session.abortedLastRun) html += '<div style="margin-top:8px;color:var(--orange)">⚠️ Last run was aborted</div>';
          html += '</div>';
        } else {
          html += '<div class="card"><div class="empty">No gateway session data available for this key</div></div>';
        }

        // Diff link if worker has an active issue
        if (workerInfo && workerInfo.worker.issueId) {
          html += '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">';
          html += '<a href="/devclaw-ui/diff/' + workerInfo.project.slug + '/' + workerInfo.worker.issueId + '" class="btn">📄 View Diff</a>';
          html += '</div>';
        }

        document.getElementById('content').innerHTML = html;
      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="error-msg">Failed to load: ' + e.message + '</div>';
      }
    }

    load();
    setInterval(load, 10000);
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
