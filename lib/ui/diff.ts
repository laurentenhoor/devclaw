/**
 * Git Diff Explorer page — file tree + diff2html rendering.
 */
import { CSS } from "./styles.js";

export function generateDiffPage(projectSlug: string, issueId: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Diff: ${escapeHtml(projectSlug)} #${issueId}</title>
  <style>${CSS}</style>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html@3.4.48/bundles/css/diff2html.min.css">
</head>
<body>
  <a href="/devclaw-ui/" class="back">← Dashboard</a>
  <h1>📄 Diff: ${escapeHtml(projectSlug)} #${issueId}</h1>

  <div class="toggle-group" id="view-toggle">
    <button class="active" data-view="side-by-side">Split</button>
    <button data-view="line-by-line">Unified</button>
  </div>

  <div id="content"><div class="empty">Loading diff...</div></div>

  <script src="https://cdn.jsdelivr.net/npm/diff2html@3.4.48/bundles/js/diff2html-ui.min.js"></script>
  <script>
    const projectSlug = ${JSON.stringify(projectSlug)};
    const issueId = ${issueId};
    let rawDiff = '';
    let currentView = 'side-by-side';

    function parseDiffFiles(diff) {
      const files = [];
      const parts = diff.split(/^diff --git /m).filter(Boolean);
      for (const part of parts) {
        const nameMatch = part.match(/^a\\/(.+?)\\s/);
        const adds = (part.match(/^\\+[^+]/gm) || []).length;
        const dels = (part.match(/^-[^-]/gm) || []).length;
        if (nameMatch) files.push({ name: nameMatch[1], additions: adds, deletions: dels });
      }
      return files;
    }

    function renderFileTree(files) {
      const totalAdd = files.reduce((s, f) => s + f.additions, 0);
      const totalDel = files.reduce((s, f) => s + f.deletions, 0);

      let html = '<div class="diff-stats">' + files.length + ' file' + (files.length !== 1 ? 's' : '') +
        ' · <span class="add">+' + totalAdd + '</span> <span class="del">-' + totalDel + '</span></div>';

      // Mobile dropdown
      html += '<select class="file-select" id="file-select"><option value="">All files</option>';
      files.forEach((f, i) => {
        html += '<option value="' + i + '">' + f.name + ' (+' + f.additions + ' -' + f.deletions + ')</option>';
      });
      html += '</select>';

      // Desktop tree
      html += '<div class="file-tree">';
      files.forEach((f, i) => {
        html += '<div class="file-tree-item" data-idx="' + i + '">' +
          '📄 <span style="flex:1">' + f.name + '</span>' +
          '<span class="additions">+' + f.additions + '</span>' +
          '<span class="deletions">-' + f.deletions + '</span></div>';
      });
      html += '</div>';
      return html;
    }

    function renderDiff(view) {
      if (!rawDiff) return;
      const files = parseDiffFiles(rawDiff);
      const fileTreeHtml = renderFileTree(files);

      const diffEl = document.createElement('div');
      diffEl.id = 'diff-output';

      document.getElementById('content').innerHTML =
        '<div class="diff-layout">' +
        '<div>' + fileTreeHtml + '</div>' +
        '<div id="diff-container"></div>' +
        '</div>';

      const container = document.getElementById('diff-container');
      container.appendChild(diffEl);

      const diff2htmlUi = new Diff2HtmlUI(diffEl, rawDiff, {
        drawFileList: false,
        matching: 'lines',
        outputFormat: view,
        highlight: true,
      });
      diff2htmlUi.draw();
      diff2htmlUi.highlightCode();

      // File click → scroll to file
      document.querySelectorAll('.file-tree-item').forEach(el => {
        el.addEventListener('click', () => {
          const idx = parseInt(el.dataset.idx);
          const headers = diffEl.querySelectorAll('.d2h-file-wrapper');
          if (headers[idx]) headers[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
      const sel = document.getElementById('file-select');
      if (sel) {
        sel.addEventListener('change', () => {
          const idx = parseInt(sel.value);
          if (!isNaN(idx)) {
            const headers = diffEl.querySelectorAll('.d2h-file-wrapper');
            if (headers[idx]) headers[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        });
      }
    }

    // View toggle
    document.getElementById('view-toggle').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      document.querySelectorAll('#view-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentView = btn.dataset.view;
      renderDiff(currentView);
    });

    async function load() {
      try {
        const res = await fetch('/devclaw-ui/api/diff/' + projectSlug + '/' + issueId);
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Request failed' }));
          document.getElementById('content').innerHTML = '<div class="error-msg">' + (err.error || 'Failed to load diff') + '</div>';
          return;
        }
        const data = await res.json();
        rawDiff = data.diff;
        renderDiff(currentView);
      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="error-msg">Failed to load: ' + e.message + '</div>';
      }
    }

    load();
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
