// Git review — a read-only pane over the focused repository and configured roots.
// Plain ESM loaded uncompiled — jsx() calls, not JSX syntax. Imports restricted to the
// loader allowlist: @hermes/plugin-sdk, react, react/jsx-runtime.
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import {
  useState, useEffect, useMemo, useRef, useCallback, forwardRef,
} from "react";
import {
  Badge, Button, Codicon, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger, EmptyState,
  SearchField, Switch, Tip, cn, host, useValue,
} from "@hermes/plugin-sdk";

// ───────────────────────── diff parsing ─────────────────────────

// Collapse long runs of unchanged lines into expandable context blocks.
// GitHub semantics: the run before a file's first change keeps its LAST `keep`
// lines (expander sits above); every other run keeps first+last `keep`. Runs
// never span hunk boundaries — context rows carry their hunk index and a
// boundary flushes the run.
function collapseRows(rows, keep = 3) {
  const out = [];
  let run = [];
  let runHunk = null;
  let seenChange = false;
  // `atEnd`: the run follows the last change, so it runs to the end of the file.
  // It folds to that end instead of keeping a tail — a tail would put a separator
  // in the middle of the final run and leave lines below it that belong to it.
  const flush = (atEnd = false) => {
    if (run.length > keep * 2 + (keep ? 1 : 0)) {
      if (!seenChange && keep) {
        out.push(...run.slice(-keep));
        const hidden = run.slice(0, -keep);
        out.splice(out.length - keep, 0, { kind: "fold", lead: true, key: `context:${hidden[0].before}:${hidden[0].after}:${hidden.at(-1).before}:${hidden.at(-1).after}`, count: hidden.length, rows: hidden });
      } else if (atEnd && keep) {
        out.push(...run.slice(0, keep));
        const hidden = run.slice(keep);
        out.push({ kind: "fold", key: `context:${hidden[0].before}:${hidden[0].after}:${hidden.at(-1).before}:${hidden.at(-1).after}`, count: hidden.length, rows: hidden });
      } else {
        out.push(...run.slice(0, keep));
        const hidden = run.slice(keep, keep ? -keep : undefined);
        out.push({ kind: "fold", key: `context:${hidden[0].before}:${hidden[0].after}:${hidden.at(-1).before}:${hidden.at(-1).after}`, count: hidden.length, rows: hidden });
        if (keep) out.push(...run.slice(-keep));
      }
    } else out.push(...run);
    run = [];
    runHunk = null;
  };
  for (const row of rows) {
    if (row.kind === "context") {
      if (run.length && row.hunk !== runHunk) flush(); // hunk boundary inside a run
      if (!run.length) runHunk = row.hunk;
      run.push(row);
    } else {
      flush();
      out.push(row);
      if (row.kind === "add" || row.kind === "remove") seenChange = true;
    }
  }
  flush(true);
  return out;
}

// Git metadata never renders; hunk headers are structural only. Inside a hunk,
// classify by the FIRST character only — an added line whose content starts
// with "++ " must stay an add, never match a metadata pattern. Every row keeps
// its hunk index so context runs never merge across hunks and gaps between
// hunks stay computable.
function diffRows(patch, collapse = true) {
  let before = 0, after = 0, hunkIndex = -1;
  const raw = [], hunks = [];
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const text of lines) {
    if (text.startsWith("diff --git ")) { hunkIndex = -1; continue; }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      // Groups: 1=old start, 2=old count, 3=new start, 4=new count — hunk[2]
      // is the OLD count, so new-side numbering must read hunk[3].
      before = Number(hunk[1]); after = Number(hunk[3]);
      hunkIndex = hunks.length;
      hunks.push({ index: hunkIndex, oldStart: before, oldCount: Number(hunk[2] ?? 1), newStart: after, newCount: Number(hunk[4] ?? 1) });
      continue;
    }
    if (hunkIndex < 0) continue; // file-level metadata (---/+++/index/mode/rename)
    const row = text.startsWith("+") ? { kind: "add", after: after++, text: text.slice(1) }
      : text.startsWith("-") ? { kind: "remove", before: before++, text: text.slice(1) }
      : text.startsWith(" ") ? { kind: "context", before: before++, after: after++, text: text.slice(1) }
      : null; // "\ No newline at end of file" and other hunk noise
    if (!row) continue;
    row.hunk = hunkIndex;
    raw.push(row);
  }
  return { rows: collapse ? collapseRows(raw) : raw, hunks };
}

// Git emits C-quoted paths for spaces, tabs, Unicode and quotes in diff headers.
function unquoteGitPath(value) {
  if (!value) return value;
  return value.replace(/(?:\\[0-7]{3})+|\\[\\"nt]/g, (token) => {
    if (token.length > 2 && /^\\[0-7]/.test(token)) {
      const bytes = token.match(/\\([0-7]{3})/g).map((part) => parseInt(part.slice(1), 8));
      return new TextDecoder().decode(new Uint8Array(bytes));
    }
    return ({ n: "\n", t: "\t", "\\": "\\", '"': '"' })[token[1]];
  });
}

const isHidden = () => typeof document !== "undefined" && document.hidden;
// Structural sharing for polled data: an unchanged response keeps the previous reference,
// so React skips the re-render instead of re-parsing and repainting every file.
function sameData(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}
// Parsed rows per file, keyed by the (stable) lines array: parsing a diff is the expensive part of render.
const parsedRows = new WeakMap();
function cachedDiffRows(lines) {
  let hit = parsedRows.get(lines);
  if (!hit) { hit = diffRows(lines.join("\n"), false); parsedRows.set(lines, hit); }
  return hit;
}

function fileSections(patch) {
  const out = [];
  let current = null;
  for (const line of patch.split("\n")) {
    const quoted = /^diff --git "a\/((?:\\.|[^"\\])*)" "b\/((?:\\.|[^"\\])*)"$/.exec(line);
    const plain = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (quoted || plain) {
      const path = quoted ? unquoteGitPath(quoted[2]) : plain[2];
      current = { path, lines: [] };
      out.push(current);
    }
    if (current) current.lines.push(line);
  }
  // Search and change-detection need the file's text, once per diff: doing it
  // per keystroke meant re-joining every file's lines on every character typed.
  for (const s of out) {
    s.text = s.lines.join("\n");
    s.hay = `${s.path}\n${s.text}`.toLowerCase();
    s.chars = s.text.length;
  }
  return out;
}

// Why a file has no hunks: say what git actually reported instead of one generic line.
function noHunkMessage(lines, ignoreWs) {
  const find = (re) => { for (const l of lines) { const m = re.exec(l); if (m) return m; } return null; };
  const from = find(/^rename from (.*)$/);
  if (from) {
    const was = unquoteGitPath(from[1].replace(/^"|"$/g, ""));
    const sim = find(/^similarity index (\d+)%/);
    if (ignoreWs && !(sim && sim[1] === "100")) return `Renamed from ${was} — remaining changes are whitespace only (hidden by Ignore whitespace).`;
    return `Renamed from ${was} — no content changes.`;
  }
  if (find(/^(Binary files .* differ|GIT binary patch)/)) return "Binary file changed — no text diff available.";
  const mode = [find(/^old mode (\d+)/), find(/^new mode (\d+)/)];
  if (mode[0] && mode[1]) return `Mode changed ${mode[0][1]} → ${mode[1][1]} — no content changes.`;
  if (find(/^new file mode/)) return "Empty file added.";
  if (find(/^deleted file mode/)) return "Empty file deleted.";
  if (ignoreWs) return "Only whitespace changes — hidden by Ignore whitespace.";
  return "No line changes to show.";
}

const basename = (p) => p.split(/[\\/]/).pop();
// A remote-qualified ref and its local branch are one branch to a reviewer:
// "origin/main" is just "main" unless no local branch of that name exists.
const shortLabel = (ref) => {
  const cut = ref.indexOf("/");
  return cut > 0 && ["origin", "upstream"].includes(ref.slice(0, cut)) ? ref.slice(cut + 1) : ref;
};

// Group file paths into a folder tree with aggregated churn (mirrors core
// review tree-data.ts: dirs aggregate descendants' +/-).
function buildTree(paths) {
  const root = Object.create(null);
  for (const p of paths) {
    const parts = p.split(/[\\/]/);
    let node = root;
    // Prefix directory keys so names such as "__proto__" and "__files"
    // never collide with object internals or the file-list sentinel.
    for (let i = 0; i < parts.length - 1; i++) node = (node[`:${parts[i]}`] ??= Object.create(null));
    (node.__files ??= []).push(p);
  }
  return root;
}

// Merge single-child folder chains for display: "a/b/c" stays one row when no
// intermediate level has its own files (Cursor's compact folders).
function compactTree(node) {
  const out = Object.create(null);
  for (const key of Object.keys(node)) {
    if (key === "__files") { out.__files = node.__files; continue; }
    let label = key.slice(1);
    let subtree = node[key];
    while (subtree && !subtree.__files && Object.keys(subtree).length === 1) {
      const only = Object.keys(subtree)[0];
      label += "/" + only.slice(1);
      subtree = subtree[only];
    }
    out[`:${label}`] = compactTree(subtree);
  }
  return out;
}

function countFiles(node) {
  let n = (node.__files || []).length;
  for (const k of Object.keys(node)) if (k !== "__files") n += countFiles(node[k]);
  return n;
}

function subtreeHas(node, q) {
  if ((node.__files || []).some((f) => f.toLowerCase().includes(q))) return true;
  return Object.keys(node).filter((k) => k !== "__files").some((k) => subtreeHas(node[k], q));
}

// Per-status codicon + tone (mirrors core review STATUS_GLYPH).
const STATUS_GLYPH = {
  added: { icon: "diff-added", tone: "text-(--ui-green)" },
  deleted: { icon: "diff-removed", tone: "text-(--ui-red)" },
  renamed: { icon: "diff-renamed", tone: "text-(--ui-blue)" },
  untracked: { icon: "diff-added", tone: "text-(--ui-text-tertiary)" },
  modified: { icon: "diff-modified", tone: "text-(--ui-orange)" },
  changed: { icon: "diff-modified", tone: "text-(--ui-orange)" },
};

const SCOPES = [
  { id: "agent_turn", label: "Last agent turn" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "staged", label: "Staged" },
  { id: "unstaged", label: "Unstaged" },
  { id: "commits", label: "Commits" },
];

// Cursor's "Show:" tree filters: hide deletions / test files.

// Pane-scoped settings persisted via plugin storage (namespaced to the plugin).
const SETTINGS_KEY = "display.v1";
// Pane settings are scoped to the work they were chosen for: the connection and
// profile, plus the focused workspace. Shared with the tests so both sides build
// the same key.
const settingsKeyFor = (identity) => `${SETTINGS_KEY}:${identity}`;
// A partial identity sample (no profile or no connection) means "not known yet",
// never "another backend": resolve it against the last fully resolved identity.
// Should the pane adopt the focused workspace's repository? Only when the reviewer
// has not chosen one: following cwd on every session switch silently overrode the
// chosen repository and reset the pane to the workspace's own worktree.
const shouldFollowWorkspace = ({ cwd, saved, picked }) =>
  Boolean(cwd) && !saved && !picked;
const resolveIdentity = (raw, last) => {
  try {
    const [connection, profile] = JSON.parse(raw);
    return connection == null || profile == null ? last : raw;
  } catch { return last; }
};
// Which files a new diff opens: ones the reviewer had collapsed whose changes
// just changed (a fresh edit), and files that were not in the previous diff at
// all (a new file). The first observation of a scope is not a change, so a file
// that is collapsed stays collapsed when the pane loads.
const filesToOpen = (prev, next, collapsed) => {
  if (!prev) return [];
  const open = [];
  for (const [path, sig] of next) {
    if (!collapsed[path]) continue;
    if (prev.get(path) !== sig) open.push(path);
  }
  return open;
};
// A file's changes, cheaply: the counts the header shows plus the patch size.
const sectionSignature = (s) => `${s.added}:${s.removed}:${s.chars}`;
const EMPTY_ATOM = { get: () => "", subscribe: () => () => {} };

const css = `
.grd{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;color:var(--ui-text-primary);font:13px/1.5 var(--font-sans,system-ui);container-type:inline-size}
.grd *{box-sizing:border-box}
.grd .toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--ui-stroke-tertiary);flex-wrap:nowrap;overflow:hidden}
.grd .toolbar > *{flex:0 0 auto;min-width:0}
.grd .toolbar > .toolbar-end{display:flex;align-items:center;gap:4px;margin-left:auto;flex:0 0 auto}
.grd .toolbar-end > *{flex:0 0 auto}
.grd .toolbar .repo-name{flex:1 1 0;min-width:0;max-width:max-content}
/* Equal widths when tight (flex-basis 0); each caps at its own content width
   (max-content), spare space flows to the auto margin of the end group. */
.grd .repo-label{display:flex;align-items:center;gap:6px;min-width:0;width:100%}
.grd .repo-label > :not(.repo-text){flex-shrink:0}
.grd .repo-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;direction:ltr;flex:1}
.grd .toolbar > .scope-btn{flex:0 1 auto;max-width:35%}
.grd .scope-btn > span{min-width:0;max-width:100%}
.grd .scope-btn .scope-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.grd .scope-btn .codicon,.grd .scope-btn .fdelta{flex-shrink:0}
.grd .scope-btn{font-size:12px;font-variant-numeric:tabular-nums}
.grd .repo-name{font-size:12px;color:var(--ui-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* A menu portals to document.body, outside .grd, so the rules its content needs
   carry the menu surface class as a second scope: churn colours, group headers
   and the scroll cap all apply to the menu, not to the pane. */
.grd .fdelta,.gr-menu .fdelta{font-family:var(--font-mono,monospace);font-size:10.5px;font-variant-numeric:tabular-nums;display:inline-flex;gap:6px}
.grd .fdelta .add,.gr-menu .fdelta .add{color:var(--ui-green)}.grd .fdelta .del,.gr-menu .fdelta .del{color:var(--ui-red)}
.grd .body{min-height:0;min-width:0;flex:1;display:grid;grid-template-columns:minmax(0,1fr) var(--files-w,minmax(210px,28%))}
.grd .tree-side{position:relative}
/* Same shape as the desktop's pane sash: a 4px grab area straddling the seam,
   invisible until it is hovered or dragged, then filled with the accent mix. */
.grd .resizer{position:absolute;left:-2px;top:0;bottom:0;width:4px;cursor:col-resize;z-index:2;background:transparent}
.grd .resizer:hover,.grd .resizer:focus-visible,.grd .resizer:active{background:var(--ui-sash-hover-background,var(--ui-stroke-tertiary))}
.grd .resizer::after{content:"";position:absolute;left:1px;top:0;bottom:0;width:2px;background:transparent}
.grd .resizer:hover::after,.grd .resizer:focus-visible::after,.grd .resizer:active::after{background:var(--ui-sash-hover-border,var(--ui-accent))}
.grd .body.tree-hidden{grid-template-columns:minmax(0,1fr)}
.grd .allfiles{overflow:auto;position:relative;scrollbar-width:none;min-width:0;min-height:0;padding:0;border-right:1px solid var(--ui-stroke-tertiary);margin:0}
.grd .tree-side{display:flex;flex-direction:column;min-height:0;min-width:0;margin:0;border-left:0;background:transparent}
.grd .body{column-gap:0}
.grd .tree-side .tree{overflow:auto;flex:1;min-height:0}
.grd .sidebar{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--ui-stroke-tertiary)}
.grd .search{padding:8px 10px;display:flex;align-items:center;gap:6px;flex-wrap:nowrap;min-width:0}
.grd .search-field{flex:1 1 0;min-width:0;opacity:1;background:var(--ui-bg-input);color:var(--ui-text-primary);border:1px solid var(--ui-stroke-secondary);border-radius:6px;padding:0 6px}
.grd .search-field:focus-within{border-color:var(--ui-accent)}
.grd .search-field input{width:0;min-width:0;flex:1 1 0;field-sizing:fixed;color:var(--ui-text-primary);background:transparent;font-size:12px}
.grd .search-field input::placeholder{color:var(--ui-text-secondary);opacity:1}
  .dark .grd{background:#141416;color:#e8e8e8}
  .dark .grd .toolbar{border-color:#2b2b2d}
  .dark .grd .toolbar .repo-name{color:#9a9a9a}
  .dark .grd .folder{color:#c9c9c9}
  .dark .grd .folder:hover{background:#1c1c20}
  .dark .grd .file{color:#e8e8e8}
  .dark .grd .file:hover{background:#1c1c20}
  .dark .grd .file[aria-pressed=true]{background:#242426}
  .dark .grd .fname{color:#e8e8e8}
/* Churn counts sit immediately after the name, in the file tree as in the folders'
   file counts: the numbers describe the row they follow, not a right-hand column. */
.grd .file .fname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The counts are 10.5px against a 12px label. With normal line-height their text box
   centres on a different baseline, so the digits read a pixel low next to the name;
   one line-height for both boxes, and the numbers centre on the label. */
.grd .file .fname,.grd .folder > span:first-of-type{line-height:1.2}
.grd .file .fdelta,.grd .folder .cnt{line-height:1;align-self:center}
  .dark .grd .detailhead{border-color:#2b2b2d}
  .dark .grd .detailtitle .fdir{color:#6b6b6b}
  .dark .grd .search{border-bottom-color:#2b2b2d}
  .dark .grd .search-field{background:#1c1c1f;color:#e8e8e8;border-color:#2b2b2d;border-radius:6px;padding:0 6px}
  .dark .grd .search-field input{background:transparent;color:#e8e8e8;font-size:12px}
  .dark .grd .search-field:focus-within{border-color:var(--ui-accent)}
  .dark .grd .search-field input::placeholder{color:#9b9b9b;opacity:.9}
  .dark .grd .search-field > svg{color:#9b9b9b}
  .dark .grd .filter-wrap.active{color:#e8e8e8}
  .dark .grd .filter-wrap.active .filter-btn{background:#2b2b2d}
  .dark .grd .lineno{color:#6b6b6b;user-select:none;-webkit-user-select:none}
  .dark .grd .line.hunk{color:#9a9a9a;background:#161618}
  .dark .grd .fold{color:#6b6b6b}
  .dark .grd .fold-strip{background:var(--ui-surface-background)}
  .dark .grd .menu-group,.dark .gr-menu .menu-group{color:#6b6b6b}
  .dark .grd .af-head{background:#161618}
  .dark .grd .af-head:hover{background:#1c1c20}
  .dark .grd .af-head .fdir{color:#6b6b6b}
  .dark .grd .af-copy{color:#6b6b6b}
  .dark .grd .af-copy:hover{color:#c9c9c9}
  .dark .grd .notice{background:#161618;color:#9a9a9a}
  .dark .grd .fold-inline{background:var(--ui-surface-background)}
  .dark .grd .fold-inline:hover{background:#242426}
  .dark .grd .line.add{background:#123a24}
  .dark .grd .line.add .lineno{color:#4ade80}
  .dark .grd .line.remove{background:#3a1c1c}
  .dark .grd .line.remove .lineno{color:#f87171}
  .dark .grd .line.line-selected{background:#242426}
  .dark .grd .split-row > .line + .line{border-color:#2b2b2d}

.grd .search-field > svg{color:var(--ui-text-secondary);flex-shrink:0}
.grd .search .filter-wrap{flex:0 0 auto;display:inline-flex}
.grd .search .filter-wrap.active{color:var(--ui-accent)}
.grd .search .filter-wrap.active .filter-btn{color:var(--ui-accent);background:color-mix(in srgb,var(--ui-accent) 12%,transparent)}
.grd .tree{overflow:auto;flex:1;min-height:0;padding-bottom:10px}
.grd .folder{display:flex;align-items:center;gap:5px;padding:4px 10px;color:var(--ui-text-secondary);font-size:12px;cursor:pointer;user-select:none}
.grd .folder:hover{background:var(--ui-row-hover-background)}
.grd .folder .cnt{font-size:10.5px;color:var(--ui-text-tertiary)}
.grd .file{width:100%;text-align:left;border:0;border-radius:0;padding:5px 10px 5px 24px;background:transparent;display:flex;align-items:center;gap:8px;min-width:0;color:inherit;font:inherit}
.grd .file:hover{background:var(--ui-row-hover-background)}
.grd .file[aria-pressed=true]{background:var(--ui-row-active-background)}
.grd .file:focus-visible{outline:2px solid var(--ui-accent);outline-offset:-2px}
.grd .fname{font-family:var(--font-mono,monospace);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
.grd .detail{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.grd .detailhead{padding:10px 14px;border-bottom:1px solid var(--ui-stroke-tertiary);display:flex;flex-direction:column;gap:8px}
.grd .detailtitle{display:flex;align-items:center;gap:8px;min-width:0}
.grd .detailtitle .fname{font-weight:600;flex:0 0 auto}
.grd .detailtitle .fdir{flex:1 1 0;color:var(--ui-text-tertiary);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grd .actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.grd .diff{overflow:auto;flex:1;min-height:0;margin:0;tab-size:4;font:12px/1.75 var(--font-mono,monospace)}
/* Each file's diff is its own horizontal scroller, so a row's width:100% is the
   VISIBLE width, never the scrolled one: past the first screen a change lost its
   background. A one-column grid sized minmax(max-content, 1fr) is at least as wide
   as the widest row and grows to fill the view when every line is short; rows
   stretch to it, change backgrounds and unmodified-lines bars included. (Measured:
   minmax(100%, max-content) stays at the view width in Chromium, and a bare
   max-content column shrinks short files below the view.) Rows carry no width of
   their own - a percentage there resolves to the view and pins the column to it.
   Wrapped, the column is the view: nothing overflows. */
.grd .diff{display:grid;grid-template-columns:minmax(max-content,1fr);align-content:start}
.grd .diff.wordw{grid-template-columns:minmax(0,1fr)}
.grd .line{display:flex;width:auto;min-width:0;white-space:pre;padding:0 6px;align-items:baseline;cursor:text;user-select:text;-webkit-user-select:text}
.grd .line:hover{background:var(--ui-row-hover-background)}
.grd .line.line-selected{background:var(--ui-row-active-background, var(--ui-row-hover-background));box-shadow:inset 2px 0 0 var(--ui-accent)}
.grd .line.line-selected.line:is(.add,.remove,.context,.meta){background-image:linear-gradient(color-mix(in srgb,var(--ui-accent) 16%,transparent),color-mix(in srgb,var(--ui-accent) 16%,transparent))}
.grd .cite-bar{display:flex;align-items:center;line-height:1;gap:8px;padding:6px 12px;border-bottom:1px solid var(--ui-stroke-tertiary);color:var(--ui-text-secondary);font-size:12px}
.grd .cite-bar .cite-ref{font-family:var(--font-mono,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.grd .gutter{display:flex;align-items:baseline;flex:none;cursor:pointer;user-select:none;-webkit-user-select:none;position:relative}
/* Selection is click-based: click a line, click another to close the range. A grab
   handle is deliberately not drawn - pressing the gutter began a selection that a
   release dropped, which read as a broken affordance. Real drag-to-select needs
   pointer capture, not hover handlers. */
/* The handle needs its own room, or it lands on the digits. The gutter reserves it
   permanently so the numbers never shift when the handle appears on hover. */
.grd .gutter{padding-left:11px;cursor:grab}
.grd .gutter:active{cursor:grabbing}
.grd .gutter::before{content:"";position:absolute;left:2px;top:50%;width:3px;height:3px;border-radius:50%;
  background:var(--ui-text-secondary);transform:translateY(-50%);opacity:0;transition:opacity .12s ease;
  box-shadow:4px 0 0 var(--ui-text-secondary),
             0 -5px 0 var(--ui-text-secondary),4px -5px 0 var(--ui-text-secondary),
             0 5px 0 var(--ui-text-secondary),4px 5px 0 var(--ui-text-secondary)}
.grd .line:hover .gutter::before,.grd .line-selected .gutter::before{opacity:0.85}
.grd .lineno{flex:0 0 calc(var(--gr-gutter-width,4ch) + 5px);width:calc(var(--gr-gutter-width,4ch) + 5px);min-width:calc(var(--gr-gutter-width,4ch) + 5px);text-align:right;padding:0;color:var(--ui-text-tertiary);user-select:none;font-variant-numeric:tabular-nums;font:inherit;opacity:0.75}
.grd .lineno + .lineno{flex-basis:calc(var(--gr-gutter-width,4ch) + 5px);width:calc(var(--gr-gutter-width,4ch) + 5px);min-width:calc(var(--gr-gutter-width,4ch) + 5px);margin-left:4px;padding-left:4px;border-left:1px solid var(--ui-stroke-tertiary)}
.grd .linecode{padding-left:6px;flex:1 0 auto;min-width:0}
.grd .line.hunk .linecode,.grd .line.meta .linecode{padding:0 12px}
.grd .line.meta{color:var(--ui-text-tertiary)}
.grd .line.add{background:var(--ui-diff-add-background)}
.grd .line.add .lineno{color:var(--ui-diff-add-foreground)}
.grd .line.remove{background:var(--ui-diff-remove-background)}
.grd .line.remove .lineno{color:var(--ui-diff-remove-foreground)}
.grd .line.hunk{color:var(--ui-text-secondary);background:var(--ui-row-hover-background);padding:5px 0;margin:0 0 4px}
.grd .line.hunk:not(:first-child){margin-top:12px}
.grd .fold{position:relative;display:flex;align-items:center;gap:8px;padding:2px 0;color:var(--ui-text-tertiary);font-size:11px;cursor:default;user-select:none}
.grd .fold::before,.grd .fold::after{content:"";flex:1;border-top:1px solid var(--ui-stroke-tertiary)}
.grd .fold-strip{position:absolute;left:0;top:0;bottom:0;width:100%;background:var(--ui-surface-background);pointer-events:none}
.grd .fold-inner{position:relative;z-index:1;display:inline-flex;align-items:center;gap:6px}
/* Hermes core styles *::-webkit-scrollbar globally, so every scroller gets a
   classic bar that reserves its width. The column hides it and draws .ov-bar
   instead: absolutely positioned over the diff, so it takes no width, and it
   fades a moment after scrolling stops. */
.grd .allfiles::-webkit-scrollbar{width:0;height:0}
/* Hermes styles every scrollbar, which reserves a band under each file that scrolls
   sideways. scrollbar-width is the standard switch and, once set, Chromium ignores
   the global ::-webkit-scrollbar rule; the pseudo-element covers older engines.
   Horizontal scrolling stays available by trackpad and shift+wheel. */
.grd .diff,.grd .splitwrap{scrollbar-width:none}
.grd .diff::-webkit-scrollbar,.grd .splitwrap::-webkit-scrollbar{display:none;width:0;height:0}
.grd .ov-bar{position:absolute;right:2px;top:0;width:6px;border-radius:3px;pointer-events:none;z-index:6;
  background:color-mix(in srgb,var(--dt-scrollbar-thumb) 45%,transparent);opacity:0;transition:opacity .18s ease;will-change:transform}
/* Right sidebar: vertical scroll only; long names ellipsize, never overflow. */
.grd .tree-side .tree{overflow-x:hidden}
.grd .folder{min-width:0}
.grd .folder > span:not(.cnt){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.grd .splitwrap{min-width:0;margin:0;overflow-x:auto;font:12px/1.75 var(--font-mono,monospace);tab-size:4}
.grd .split-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);min-width:0;align-items:stretch}
.grd .split-row > .line{min-width:0;overflow-x:auto;align-items:flex-start;padding:0 6px}
.grd .split-row > .line + .line{border-left:1px solid var(--ui-stroke-tertiary)}
.grd .split-row .linecode{min-width:0}
.grd .line.empty{background:transparent}
.grd .splitwrap > .line{min-width:0}
.grd .repo-menu,.gr-menu .repo-menu{max-height:380px;overflow-y:auto;padding:0;margin:0}
.grd .menu-head,.gr-menu .menu-head{position:static;top:auto;z-index:auto;padding:6px 10px 3px}
/* The menu surface carries no padding of its own: any top padding became a band
   above a pinned group label, where a scrolled row could still show through.
   Rows and labels bring their own spacing, so nothing needs it. */
.grd .gr-menu,.gr-menu{padding:0}
.grd .gr-menu [role="separator"]{margin:4px 0}
.grd .menu-group,.gr-menu .menu-group{padding:4px 10px 3px;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:var(--ui-text-tertiary);user-select:none;position:sticky;top:0;z-index:1;/* The menu paints its surface 96% opaque on the content element itself; a sticky
   child inheriting from the wrapper gets nothing, so name the token and stay opaque. */background:var(--ui-bg-elevated,var(--ui-surface-background))}
.grd .af-file{/* Skip layout and paint for file sections that are off-screen. The browser
   remembers each section's measured height, so the scrollbar does not jump. No
   padding or margin of its own: the section's border is the only gap between files,
   whether the file ends in a change line or in an unmodified-lines bar. */
  content-visibility:auto;contain-intrinsic-size:auto 600px;padding:0;margin:0;border-bottom:1px solid var(--ui-stroke-tertiary)}
.grd .af-file.af-collapsed{border-bottom:0}
.grd .af-head{display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;user-select:none;position:sticky;top:0;background:var(--ui-surface-background);z-index:2;border-bottom:1px solid var(--ui-stroke-tertiary)}
.grd .af-head:hover{background:var(--ui-surface-background)}
.grd .af-head{min-width:0}
.grd .af-head .fname{flex:0 1 auto}
.grd .af-head > button{flex-shrink:0}
.grd .af-head .file-toggle{min-width:0;flex:1;display:flex;align-items:center;gap:8px;border:0;padding:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
.grd .af-head .fdir{flex:1 1 0;color:var(--ui-text-tertiary);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grd .af-copy{display:inline-flex;color:var(--ui-text-tertiary);cursor:pointer}
.grd .af-copy:hover{color:var(--ui-text-secondary)}
.grd .notice{padding:8px 14px;font-size:12px;border-bottom:1px solid var(--ui-stroke-tertiary);color:var(--ui-text-secondary);display:flex;align-items:center;gap:8px}
.grd .wordw .line{min-width:0;width:100%;white-space:pre-wrap}
.grd .wordw .linecode{flex:1 1 0;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal}
.grd .wordw,.grd .wordw .split-row > .line{overflow-x:visible}
.grd .fold-inline{display:inline-flex;align-items:center;gap:4px;margin:2px 0;padding:1px 6px;border:0;border-radius:8px;background:transparent;color:var(--ui-text-tertiary);font-size:11px;cursor:pointer;user-select:none;vertical-align:middle}
.grd .fold-inline:hover{color:var(--ui-text-secondary);background:var(--ui-row-hover-background)}
.grd .fold-inline:focus-visible{outline:2px solid var(--ui-accent);outline-offset:-2px}
.grd .fold-inline .codicon{flex-shrink:0}
/* Square slot for icon-only controls, so the glyph is centred rather than
   inheriting a text line box. */
.grd .fold-icon{padding:2px;min-width:18px;min-height:16px;justify-content:center;line-height:1}
.grd .fold{width:100%;border:0;background:transparent;font-family:inherit;white-space:normal}
.grd .fold:focus-visible{outline:2px solid var(--ui-accent);outline-offset:-2px}
@container(max-width:560px){.grd .body{grid-template-columns:minmax(0,1fr) minmax(150px,30%)}.grd .toolbar{gap:4px;padding-inline:6px}}
.grd .fold,.grd .fold-inner{white-space:nowrap}
/* The fold row spans the whole scrolled width (its strip must reach the end), but
   its label belongs to the view: centred in a row thousands of pixels wide it sat
   off-screen. The label is pinned to the scroller's visible box - sticky at left 0,
   one view wide (cqw of the per-file scroller) - and centres inside it. The rule
   segments beside it were painted under the strip and never visible; without them
   the label is the only flex item and nothing pushes it sideways. */
.grd .diff,.grd .splitwrap{container-type:inline-size}
.grd .fold::before,.grd .fold::after{display:none}
.grd .fold-inner{position:sticky;left:0;flex:none;width:100cqw;justify-content:center}
.check-slot{display:inline-flex;align-items:center;justify-content:center;width:1rem;flex:0 0 1rem}
@container(max-width:480px){.grd .body:not(.tree-hidden){grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(96px,34%)}.grd .resizer{display:none}.grd .tree-side{border-top:1px solid var(--ui-stroke-tertiary)}.grd .toolbar{flex-wrap:wrap;row-gap:2px}.grd .toolbar > .scope-btn{max-width:none;flex:1 1 auto;order:1}.grd .toolbar > .toolbar-end{order:2}.grd .toolbar > .repo-name{order:3;flex:1 1 40%;min-width:96px}}
`;

// Fixed-width check column: unchecked rows keep the same indent as checked ones, so labels align.
function CheckSlot({ on, size }) {
  return jsx("span", { className: "check-slot", "aria-hidden": true, children: on ? jsx(Codicon, { name: "check", size }) : null });
}

// Repo/branch triggers share all available toolbar space via pure flex
// (flex:1 1 0): equal widths when both labels are long, spare flows to the
// short one, no JS measurement.
const RepoButton = forwardRef(function RepoButton({ icon, label, ...props }, ref) {
  return jsx(Button, { ...props, ref, variant: "ghost", size: "sm", className: cn("repo-name", props.className), title: label, children:
    jsxs("span", { className: "repo-label", children: [
      jsx(Codicon, { name: icon, size: "0.85rem" }),
      jsx("span", { className: "repo-text", children: label }),
      jsx(Codicon, { name: "chevron-down", size: "0.8rem" }),
    ] })
  });
});

function DeltaCounts({ added, removed, className }) {
  if (!added && !removed) return null;
  return jsxs("span", { className: cn("fdelta", className), children: [
    added > 0 ? jsx("span", { className: "add", children: `+${added}` }) : null,
    removed > 0 ? jsx("span", { className: "del", children: `−${removed}` }) : null,
  ] });
}

// Sidebar tree with collapsible folders and per-file churn. repoRoot anchors
// composer-native drags (absolute path payload, core files-tree contract).
function Tree({ tree, filter, selected, onSelect, stats, repoRoot }) {
  const [open, setOpen] = useState({});
  const q = filter.trim().toLowerCase();
  const renderNode = (node, prefix, depth) => {
    const rows = [];
    const folders = Object.keys(node).filter((k) => k !== "__files").sort();
    for (const key of folders) {
      const folder = key.slice(1);
      const path = prefix ? `${prefix}/${folder}` : folder;
      const subtree = node[key];
      const filesUnder = countFiles(subtree);
      if (q && !subtreeHas(subtree, q)) continue;
      const isOpen = q ? true : open[path] !== false;
      rows.push(jsxs("div", { className: "folder", style: { paddingLeft: 10 + depth * 12 }, role: "button", tabIndex: 0, "aria-expanded": isOpen, onClick: () => setOpen((o) => ({ ...o, [path]: !(o[path] !== false) })), onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => ({ ...o, [path]: !(o[path] !== false) })); } }, children: [
        jsx(Codicon, { name: isOpen ? "folder-opened" : "folder", size: "0.8rem" }),
        jsx("span", { children: folder }),
        jsx("span", { className: "cnt", children: filesUnder })
      ] }, path));
      if (isOpen) rows.push(...renderNode(subtree, path, depth + 1));
    }
    for (const file of node.__files || []) {
      if (q && !file.toLowerCase().includes(q)) continue;
      const st = stats.get(file) || { added: 0, removed: 0, isNew: false, status: "modified" };
      const glyph = STATUS_GLYPH[st.status] || STATUS_GLYPH.modified;
      // Composer-native drag (core files tree contract): one absolute-path entry.
      rows.push(jsxs("button", { className: "file", style: { paddingLeft: 10 + depth * 12 + 14 },
        draggable: true,
        onDragStart: (event) => {
          try {
            const root = (repoRoot || "").replace(/\/$/, "");
            const abs = root ? `${root}/${file}` : file;
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData("application/x-hermes-paths", JSON.stringify([{ isDirectory: false, path: abs }]));
            event.dataTransfer.setData("text/plain", abs);
          } catch { /* DataTransfer may be unavailable; a failed drag payload is non-fatal */ }
        },
        "aria-pressed": file === selected, onClick: () => onSelect(file), children: [
        jsx(Codicon, { className: cn("shrink-0", glyph.tone), name: glyph.icon, size: "0.8rem" }),
        jsx("span", { className: "fname", children: basename(file) }),
        st.isNew ? jsx(Badge, { size: "xs", children: "new" }) : null,
        jsx(DeltaCounts, { added: st.added, removed: st.removed })
      ] }, file));
    }
    return rows;
  };
  return jsx("div", { className: "tree", children: renderNode(tree, "", 0) });
}

// Checkable commit rows inside the Commits submenu (multi-select)
function CommitsSubmenu({ commits, selected, onToggle, onAll, onNone, hasMore, loadingMore, onMore, onOpen, range, onRange }) {
  const row = (label, on, pick, key) => jsx(DropdownMenuItem, { onSelect: (event) => { event.preventDefault(); pick(); }, children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [jsx(CheckSlot, { on, size: "0.8rem" }), jsx("span", { style: { flex: "1 1 0", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: label })] }) }, key);
  return jsxs(Fragment, { children: [
    jsx("div", { className: "menu-group", role: "presentation", children: `Commits · ${selected.size}/${commits.length} against ${shortLabel((range && (range.base || range.auto)) || "main")}` }),

    // preventDefault keeps the menu open: picking commits is a multi-select, and
    // a closing dropdown would cost one reopen per commit.
    jsx(DropdownMenuItem, { onSelect: (event) => { event.preventDefault(); onAll() }, children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [jsx(CheckSlot, { on: commits.length > 0 && selected.size >= commits.length, size: "0.8rem" }), "Select all"] }) }),
    jsx(DropdownMenuItem, { onSelect: (event) => { event.preventDefault(); onNone() }, children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [jsx(CheckSlot, { on: selected.size === 0, size: "0.8rem" }), "Clear"] }) }),
    jsx(DropdownMenuItem, { disabled: !commits.length, onSelect: () => onOpen(0), children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [jsx(CheckSlot, { on: false, size: "0.8rem" }), "Browse commit by commit"] }) }),
    jsx(DropdownMenuSeparator, {}),
    commits.length
      ? commits.map((c) => jsxs(DropdownMenuItem, { onSelect: (event) => { event.preventDefault(); onToggle(c.sha) }, children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [
        jsx(CheckSlot, { on: selected.has(c.sha), size: "0.8rem" }),
        jsx("span", { style: { flex: "1 1 0", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: c.subject || c.short }),
        jsx(DeltaCounts, { added: c.added, removed: c.removed })
      ] }) }, c.sha))
      : jsx(DropdownMenuItem, { disabled: true, children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [jsx(CheckSlot, { on: false, size: "0.8rem" }), "No commits to show"] }) }),
    hasMore ? jsx(DropdownMenuItem, { disabled: loadingMore, onSelect: (event) => { event.preventDefault(); onMore() }, children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [jsx(CheckSlot, { on: false, size: "0.8rem" }), loadingMore ? "Loading older commits…" : "Load older commits"] }) }) : null
  ] });
}

// ── Last agent turn: Hermes-native turn baselines (core review-pane semantics).
// On a busy rising edge for the focused cwd we snapshot HEAD + untracked files
// (POST /turn-base); the agent_turn scope diffs working tree vs that snapshot
// (POST /turn-diff), so committed + uncommitted + terminal-made edits all show.
const TURN_BASE_KEY = "turnBase.v1";
const TURN_BASE_CAP = 8;

function recordTurnBase(storage, cwd, snapshot) {
  const prev = storage.get(TURN_BASE_KEY, {});
  if (prev[cwd]?.base === snapshot.base && JSON.stringify(prev[cwd]?.untracked) === JSON.stringify(snapshot.untracked)) return;
  const rest = Object.entries(prev).filter(([key]) => key !== cwd);
  while (rest.length >= TURN_BASE_CAP) rest.shift();
  rest.push([cwd, { ...snapshot, at: Date.now() }]);
  storage.set(TURN_BASE_KEY, Object.fromEntries(rest));
}

function GitReview({ ctx }) {
  const [worktrees, setWorktrees] = useState([]);
  const [chosen, setChosen] = useState("");
  const [meta, setMeta] = useState(null);
  const [scope, setScope] = useState("uncommitted");
  const [base, setBase] = useState("");
  const [ref, setRef] = useState("");
  const [pathFilter, setPathFilter] = useState("");
  const [picked, setPicked] = useState(() => new Set()); // multi-select commits
  const [commits, setCommits] = useState([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [historyNote, setHistoryNote] = useState("");
  const commitSelectionOwner = useRef("");
  const commitSelectionExplicit = useRef(false);
  const [diff, setDiff] = useState(null);
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState({});
  const [contextModes, setContextModes] = useState({});
  const [copied, setCopied] = useState("");

  const [autoBase, setAutoBase] = useState("");
  const [allHistory, setAllHistory] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [navIndex, setNavIndex] = useState(-1); // >=0: single-commit mode on commits[navIndex]
  const [fullFiles, setFullFiles] = useState({}); // files whose every unchanged line is being opened
  // Last-agent-turn baselines live in STATE (mirror of storage) so recording a
  // new snapshot re-renders the pane immediately.
  const [turnBases, setTurnBases] = useState(() => ctx.storage.get(TURN_BASE_KEY, {}));
  // A scope or repository switch re-derives the collapse state from what was
  // saved for this workspace, instead of carrying the old one over or wiping the
  // reviewer's own toggles on every live poll.
  useEffect(() => {
    let saved = {};
    try {
      saved = ctx.storage.get(settingsKey, {}) || {};
      if (!Object.keys(saved).length) saved = ctx.storage.get(SETTINGS_KEY, {}) || {};
    } catch { saved = {}; }
    setCollapsedFiles(saved.collapsedFiles || {});
    // re-derive when the file set changes (scope/repo switch)
  }, [chosen, scope]);
  const [pr, setPr] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const generation = useRef(0);
  const focusGeneration = useRef(0);
  const chooseRepository = (repo) => {
    ++focusGeneration.current;
    pickedRepo.current = true;
    if (repo) savedRepo.current = repo;
    setChosen(repo);
  };

  const cwd = useValue(host.state.cwd);
  // ctx.rest follows the ambient gateway route, not the focused chat's profile.
  const profile = useValue(host.state.profile || EMPTY_ATOM);
  const connectionId = useValue(host.state.connectionId || EMPTY_ATOM);
  // A session switch can momentarily report no profile/connection (the atoms are
  // absent for a render or two). Stringifying that gives "[null,null]", which read as
  // a different backend and wiped the reviewer's scope, base and repository on every
  // switch - the pane came back on the first worktree and "main". Only a fully
  // resolved identity counts; a partial sample keeps the last resolved one.
  const identityRef = useRef("");
  const identity = (identityRef.current = resolveIdentity(
    JSON.stringify([connectionId, profile]),
    identityRef.current,
  ));

  // Pane settings belong to the person, not to the chat: switching session must
  // hand the pane back the way it was left. The key is profile + connection only.
  // Keying it by the focused workspace looked tidier, but a window can hold
  // sessions on different worktrees, so every switch produced a fresh key and the
  // pane reset - and cwd is not even known at mount, so the first read missed the
  // saved entry. The plugin is never handed the focused session id (the loader's
  // allowlist exposes no such atom), so this is as fine-grained as the host allows.
  const settingsKey = settingsKeyFor(identity);
  // The repository the reviewer chose last time, read once: it outranks the focused
  // workspace so a session switch does not drag the pane back to that worktree.
  const savedRepo = useRef("");
  const pickedRepo = useRef(false);
  try { savedRepo.current = (ctx.storage.get(settingsKey, {}) || {}).repo || ""; } catch { /* no storage */ }
  // Scoped first, then the unscoped key older versions wrote, so an existing
  // install keeps its settings and a new workspace starts from them.
  const readSettings = () => {
    try {
      const scoped = ctx.storage.get(settingsKey, {}) || {};
      if (Object.keys(scoped).length) return scoped;
      return ctx.storage.get(SETTINGS_KEY, {}) || {};
    } catch { return {}; }
  };
  const [ignoreWs, setIgnoreWs] = useState(() => !!readSettings().ignoreWs);
  const [wordWrap, setWordWrap] = useState(() => !!readSettings().wordWrap);
  const [layout, setLayout] = useState(() => readSettings().layout || "unified"); // unified | split
  const [showDeleted, setShowDeleted] = useState(() => readSettings().showDeleted !== false);
  const [showTests, setShowTests] = useState(() => readSettings().showTests !== false);
  const [visible, setVisible] = useState(() => ({ files: readSettings().files !== false }));
  // Collapse state is part of the review: it is restored with the other settings
  // and a file that changes while collapsed opens itself.
  const [collapsedFiles, setCollapsedFiles] = useState(() => readSettings().collapsedFiles || {});
  // The file list keeps its default share of the pane until it is dragged; the
  // diff column stays minmax(0,1fr) so it reflows rather than overflowing.
  const [filesWidth, setFilesWidth] = useState(() => {
    const w = readSettings().filesWidth;
    return typeof w === "number" ? w : null;
  });
  const filesWidthRef = useRef(filesWidth);
  const resizeFrom = useRef(null);
  const onResizeStart = (e) => {
    const body = e?.currentTarget?.closest?.(".body");
    if (!body || typeof e?.clientX !== "number") return;
    resizeFrom.current = { right: body.getBoundingClientRect().right, id: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault?.();
  };
  const onResizeMove = (e) => {
    if (!resizeFrom.current || typeof e?.clientX !== "number") return;
    const room = resizeFrom.current.right;
    // Clamp: the list stays usable and the diff keeps most of the pane.
    const w = Math.max(180, Math.min(Math.round(room - e.clientX), Math.max(240, Math.round(room - 320))));
    filesWidthRef.current = w;
    setFilesWidth(w);
  };
  const onResizeEnd = () => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    persist({ filesWidth: filesWidthRef.current });
  };
  const onResizeReset = () => { filesWidthRef.current = null; setFilesWidth(null); persist({ filesWidth: null }); };

  const [repositoryIdentity, setRepositoryIdentity] = useState(identity);
  const repositoryReady = repositoryIdentity === identity;
  const lastHandled = useRef(-1);
  useEffect(() => {
    if (repositoryReady) return;
    lastHandled.current = -1;
    ++generation.current; ++focusGeneration.current;
    setWorktrees([]); setChosen(""); setMeta(null); setDiff(null); setPr(null);
    // A different profile or connection is a different backend: its scope, base and
    // repository do not carry over. A WORKSPACE switch inside one connection does not
    // run this effect, which is what keeps the reviewer's choices across sessions.
    setScope("uncommitted"); setBase("");
    setRef(""); setPathFilter("");
    setCommits([]); setPicked(new Set()); setCommitsLoading(false); setHistoryNote(""); setAllHistory(false); setNavIndex(-1); setHasMore(false);
    commitSelectionOwner.current = ""; commitSelectionExplicit.current = false;
    setSelected(""); setFilter(""); setExpanded({}); setContextModes({}); setFullFiles({});
    setError(""); setRepositoryIdentity(identity);
  }, [identity, repositoryReady]);

  // Saved on change only: the first run of each effect fires with the value restore
  // just read, and writing it back would race the display-settings restore.
  // Restore the reviewer's scope and comparison base once the settings are readable:
  // they are pane state, not workspace state, so a session or workspace switch keeps
  // them. This runs before the persist effects, whose first run is skipped.
  const restoredScope = useRef(false);
  useEffect(() => {
    if (restoredScope.current) return;
    restoredScope.current = true;
    const saved = readSettings();
    if (saved.scope) setScope(saved.scope);
    if (typeof saved.base === "string" && saved.base) setBase(saved.base);
  }, [readSettings]);
  const firstPersist = useRef({ base: true, repo: true, scope: true });
  useEffect(() => {
    if (firstPersist.current.scope) { firstPersist.current.scope = false; return; }
    persist({ scope });
  }, [scope]);
  useEffect(() => {
    if (firstPersist.current.base) { firstPersist.current.base = false; return; }
    persist({ base });
  }, [base]);
  useEffect(() => {
    if (firstPersist.current.repo) { firstPersist.current.repo = false; return; }
    if (chosen) persist({ repo: chosen });
  }, [chosen]);

  // Selections are repo/scope bound: drop them when either changes.
  // Only a scope switch invalidates a line selection. Keying this on `chosen` too
  // wiped it on every background refresh, which is why a second click landed on an
  // already-cleared state.
  useEffect(() => { setLineSelection(null); }, [scope]);

  const persist = (patch) => { try { ctx.storage.set(settingsKey, { ...ctx.storage.get(settingsKey, {}), ...patch }); } catch { /* best-effort */ } };

  // Switching the focused workspace switches the settings in play; re-apply the
  // stored ones for the workspace being entered (the first run is the mount read).
  const lastSession = useRef(settingsKey);
  useEffect(() => {
    if (lastSession.current === settingsKey) return;
    lastSession.current = settingsKey;
    let s = {};
    try {
      s = ctx.storage.get(settingsKey, {}) || {};
      if (!Object.keys(s).length) s = ctx.storage.get(SETTINGS_KEY, {}) || {};
    } catch { s = {}; }
    setLayout(s.layout || "unified");
    setWordWrap(!!s.wordWrap);
    setIgnoreWs(!!s.ignoreWs);
    setShowDeleted(s.showDeleted !== false);
    setShowTests(s.showTests !== false);
    setVisible({ files: s.files !== false });
    setCollapsedFiles(s.collapsedFiles || {});
    const w = s.filesWidth;
    filesWidthRef.current = typeof w === "number" ? w : null;
    setFilesWidth(typeof w === "number" ? w : null);
  }, [settingsKey, ctx]);

  // Follow the focused chat's workspace only while the reviewer has not chosen a
  // repository: a session switch changes cwd, and adopting it reset the pane.
  useEffect(() => {
    if (!repositoryReady) return;
    if (!shouldFollowWorkspace({ cwd, saved: savedRepo.current, picked: pickedRepo.current })) return;
    const current = ++focusGeneration.current;
    let gone = false;
    ctx.rest(`/meta?repo=${encodeURIComponent(cwd)}`, { timeoutMs: 10000 })
      .then((r) => { if (!gone && current === focusGeneration.current && r?.repo) setChosen(r.repo); }).catch(() => {});
    return () => { gone = true; };
  }, [cwd, ctx, identity, repositoryReady]);

  useEffect(() => {
    if (!repositoryReady) return;
    let gone = false;
    setBusy(true);
    ctx.rest(`/worktrees?cwd=${encodeURIComponent(cwd || "")}`, { timeoutMs: 15000 })
      .then((r) => { if (!gone) { setWorktrees(r.worktrees || []); setError(""); } })
      .catch(() => { if (!gone) setError("git-review backend unavailable — check the gateway"); })
      .finally(() => { if (!gone) setBusy(false); });
    return () => { gone = true; };
  }, [ctx, cwd, tick, identity, repositoryReady]);

  useEffect(() => {
    if (!repositoryReady || chosen || !worktrees.length) return;
    const saved = savedRepo.current;
    setChosen(saved && worktrees.some((w) => w.path === saved) ? saved : worktrees[0].path);
  }, [worktrees, chosen, repositoryReady]);

  // Agent-driven selection: the git_review_select tool pushes a request into the
  // shared store; poll gently and apply the newest one we haven't handled yet.
  // lastHandled starts at the store's current latest so a pane (re)mount never
  // replays an older agent request over what the user is already looking at.
  useEffect(() => {
    if (!repositoryReady) return;
    let timer;
    let gone = false;
    let primed = lastHandled.current >= 0;
    async function poll() {
      try {
        const r = await ctx.rest(`/pending-select?after=${primed ? lastHandled.current : 0}`, { timeoutMs: 10000 });
        const req = r?.request;
        if (!gone) {
          if (!primed) {
            // Even an empty successful response primes the cursor. Only a
            // preexisting request on that first response is skipped.
            lastHandled.current = req?.id ?? 0;
            primed = true;
          } else if (req) {
            lastHandled.current = req.id;
            chooseRepository(req.repo);
            setScope(req.scope || "uncommitted");
            setRef(req.ref || "");
            setBase(req.base || "");
            setPathFilter(req.path || "");
            commitSelectionOwner.current = `${req.repo}:${req.base || ""}:${req.scope || "uncommitted"}`;
            commitSelectionExplicit.current = !!req.ref;
            setPicked(new Set((req.ref || "").split(",").filter(Boolean)));
            if (typeof req.ignore_ws === "boolean") setIgnoreWs(req.ignore_ws);
            host.revealPane("git-review:pane");
            host.notify({ kind: "info", message: `Git review: showing ${req.scope} changes${req.path ? ` for ${basename(req.path)}` : ""}` });
          }
        }
      } catch { /* backend unreachable — retry on the next tick */ }
      if (!gone) timer = setTimeout(poll, isHidden() ? 10000 : 3000);
    }
    poll();
    return () => { gone = true; clearTimeout(timer); };
  }, [ctx, identity, repositoryReady]);

  useEffect(() => {
    if (!repositoryReady || !chosen) return;
    let gone = false;
    setMeta(null); setSelected(""); setDiff(null); setExpanded({}); setContextModes({}); setFullFiles({}); setPr(null);
    ctx.rest(`/meta?repo=${encodeURIComponent(chosen)}&cwd=${encodeURIComponent(cwd || "")}`, { timeoutMs: 10000 }).then((r) => { if (!gone) setMeta(r); }).catch(() => {});
    return () => { gone = true; };
  }, [ctx, chosen, tick, identity, repositoryReady]);

  // PR badge for the checked-out branch (best-effort; silently absent when unavailable)
  useEffect(() => {
    if (!repositoryReady || !chosen || !meta?.current) return;
    let gone = false;
    ctx.rest(`/pr?repo=${encodeURIComponent(chosen)}&cwd=${encodeURIComponent(cwd || "")}`, { timeoutMs: 15000 })
      .then((r) => { if (!gone) setPr(r); })
      .catch(() => { if (!gone) setPr(null); });
    return () => { gone = true; };
  }, [ctx, chosen, meta, identity, repositoryReady]);

  // Commit list for commit/commits scopes
  useEffect(() => {
    if (!repositoryReady || !chosen || (scope !== "commit" && scope !== "commits")) return;
    let gone = false;
    setCommitsLoading(true); setHistoryNote("");
    ctx.rest(`/commits?repo=${encodeURIComponent(chosen)}&base=${encodeURIComponent(base)}${allHistory ? "&all=true" : ""}&cwd=${encodeURIComponent(cwd || "")}`, { timeoutMs: 15000 })
      .then((r) => { if (!gone) {
        const list = r.commits || [];
        // An empty range is information: the branch has nothing the base lacks.
        // Switching to the whole history here is what showed unrelated commits as
        // if they belonged to this branch.
        if (!list.length && !base && !allHistory) setHistoryNote(r.base_label ? `Nothing on this branch since ${r.base_label} yet.` : "");
        setCommits(list); setAutoBase(r.base_label || ""); setHasMore(!!r.has_more); setNavIndex(-1);
        setHistoryNote(r.note || (r.truncated ? "Older history is omitted from this commit list." : ""));
        if (scope === "commits" && !commitSelectionExplicit.current) {
          setPicked(new Set(list.map((c) => c.sha)));
          commitSelectionExplicit.current = true;
        }
      } }).catch(() => {}).finally(() => { if (!gone) setCommitsLoading(false); });
    return () => { gone = true; };
  }, [ctx, chosen, scope, base, allHistory, tick, identity, repositoryReady]);

  const loadOlder = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const r = await ctx.rest(`/commits?repo=${encodeURIComponent(chosen)}&base=${encodeURIComponent(base)}${allHistory ? "&all=true" : ""}&skip=${commits.length}&cwd=${encodeURIComponent(cwd || "")}`, { timeoutMs: 20000 });
      const more = (r.commits || []).filter((c) => !commits.some((x) => x.sha === c.sha));
      setCommits((prev) => prev.concat(more)); setHasMore(!!r.has_more);
    } catch { /* keep the list as is */ } finally { setLoadingMore(false); }
  };
  // Single-commit navigation: show exactly commits[i]; -1 returns to the multi-select.
  const goCommit = (i) => {
    if (i < 0 || i >= commits.length) return;
    commitSelectionExplicit.current = true; setNavIndex(i); setPicked(new Set([commits[i].sha]));
  };

  // With every loaded commit selected — the default — a position counter and a
  // churn total describe the whole history rather than a reviewable selection.
  const wholeHistorySelected = scope === "commits" && picked.size >= commits.length && !hasMore;

  // The commits-scope ref param: selected shas in commit order
  const commitsRef = useMemo(() => [...picked].join(","), [picked]);

  // Last-agent-turn: capture a Hermes-native turn baseline. Watch the focused
  // session's busy flag; a false→true rising edge means a new agent turn began —
  // snapshot HEAD + untracked for that repo (read-only POST /turn-base).
  const busyNow = useValue(host.state.busy || EMPTY_ATOM);
  const turnBase = chosen ? turnBases[chosen] : null;
  const prevBusy = useRef(busyNow);
  useEffect(() => {
    if (repositoryReady && busyNow && !prevBusy.current && cwd) {
      let gone = false;
      ctx.rest("/turn-base", { method: "POST", body: { repo: cwd }, timeoutMs: 15000 })
        .then((r) => {
          if (gone || !r) return;
          recordTurnBase(ctx.storage, r.repo || cwd, { base: r.base ?? null, untracked: r.untracked || [] });
          setTurnBases(ctx.storage.get(TURN_BASE_KEY, {})); // re-render with the fresh baseline
        })
        .catch(() => {});
      return () => { gone = true; };
    }
  }, [busyNow, repositoryReady, cwd, ctx]);
  useEffect(() => { prevBusy.current = busyNow; }, [busyNow]);

  // agent_turn diffs working tree vs the turn baseline (committed + uncommitted
  // + terminal-made edits). No baseline for this repo yet → friendly empty state.
  useEffect(() => {
    if (scope !== "agent_turn" || !repositoryReady || !chosen) return;
    if (!turnBase) { setDiff(null); return; }
    const current = ++generation.current;
    let gone = false;
    let timer;
    let loaded = false;
    async function load() {
      if (loaded && isHidden()) { timer = setTimeout(load, 5000); return; } // no polling while hidden
      try {
        const r = await ctx.rest("/turn-diff", { method: "POST", timeoutMs: 20000, body: {
          repo: chosen, base: turnBase.base ?? null, preexisting_untracked: turnBase.untracked || [], ignore_ws: ignoreWs,
        } });
        if (!gone && current === generation.current) { setDiff((prev) => (sameData(prev, r) ? prev : r)); setError(""); loaded = true; }
      } catch {
        // keep the last good diff on a transient failure; only blank on the very first load
        if (!gone && current === generation.current && !loaded) setDiff(null);
      }
      if (!gone) timer = setTimeout(load, 5000);
    }
    load();
    return () => { gone = true; clearTimeout(timer); };
  }, [ctx, chosen, scope, turnBase, ignoreWs, repositoryReady]);

  useEffect(() => {
    const owner = `${chosen}:${base}:${scope}`;
    if (commitSelectionOwner.current !== owner) {
      commitSelectionOwner.current = owner;
      commitSelectionExplicit.current = false;
      if (scope === "commits") setPicked(new Set());
    }
  }, [chosen, base, scope]);

  // Diff — gentle poll only for live scopes
  useEffect(() => {
    if (!repositoryReady || !chosen) return;
    if (scope === "agent_turn") return; // served by the /turn-diff effect above
    const live = scope === "uncommitted" || scope === "unstaged" || scope === "staged";
    const current = ++generation.current;
    let timer;
    let gone = false;
    let loaded = false;
    async function load() {
      if (loaded && isHidden()) { if (!gone && live) timer = setTimeout(load, 5000); return; } // no polling while hidden
      if (scope === "commits" && !commitsRef) { setDiff(null); return; }
      let url = `/diff?repo=${encodeURIComponent(chosen)}&scope=${encodeURIComponent(scope)}&ignore_ws=${ignoreWs}&cwd=${encodeURIComponent(cwd || "")}`;
      if (base && scope === "commits") url += `&base=${encodeURIComponent(base)}`;
      if (pathFilter) url += `&path=${encodeURIComponent(pathFilter)}`;
      if (scope === "commits" && commitsRef) url += `&ref=${encodeURIComponent(commitsRef)}`;
      try {
        const r = await ctx.rest(url, { timeoutMs: 20000 });
        if (!gone && current === generation.current) { setDiff((prev) => (sameData(prev, r) ? prev : r)); setError(""); loaded = true; }
      } catch (err) {
        if (!gone && current === generation.current) {
          if (!loaded) setDiff(null); // keep the last good diff during a live refresh failure
          const status = err?.status || err?.response?.status;
          setError(status === 404
            ? "Backend route not found — restart the Hermes Desktop app so its backend picks up this plugin"
            : "Could not compute this diff — check scope/ref");
        }
      }
      if (!gone && live) timer = setTimeout(load, 5000);
    }
    load();
    return () => { gone = true; clearTimeout(timer); };
  }, [ctx, chosen, scope, base, ref, commitsRef, pathFilter, ignoreWs, tick, identity, repositoryReady]);

  const sections = useMemo(() => {
    const patches = scope === "commits"
      ? (diff?.commits || []).map((c) => ({ sha: c.sha, patch: c.patch }))
      : null;
    if (patches) return patches.flatMap((entry) => {
      const sha = typeof entry === "object" ? entry.sha : undefined;
      const patch = typeof entry === "object" ? entry.patch : entry;
      return fileSections(patch).map((s) => ({
        ...s, filePath: s.path, path: sha ? `${sha.slice(0, 8)}/${s.path}` : s.path, sha,
      }));
    });
    return diff?.patch ? fileSections(diff.patch) : [];
  }, [diff, scope]);

  // One row per branch: a local branch and its remote counterpart are the same
  // branch to the reviewer, so the menu lists it once instead of twice under
  // "main" and "origin/main".
  const branchRows = useMemo(() => {
    const local = meta?.local || [];
    const remotes = (meta?.remote || []).filter((b) => b.includes("/") && !b.endsWith("/HEAD"));
    const rows = local.map((name) => ({ value: name, name, remote: false }));
    const seen = new Set(local);
    for (const full of remotes) {
      const short = shortLabel(full);
      if (seen.has(short)) continue;
      seen.add(short);
      rows.push({ value: full, name: short, remote: true });
    }
    // The branch you are on leads; the rest read alphabetically.
    return rows.sort((a, b) => (
      a.name === meta?.current ? -1 : b.name === meta?.current ? 1 : a.name.localeCompare(b.name)
    ));
  }, [meta]);
  const shownBase = base || autoBase;

  // A file that changes while it is collapsed opens itself, so the review keeps
  // showing what is new without a click per edit. Signatures are kept per scope:
  // switching scope is not a change.
  const seenSections = useRef(null);
  // The floating scrollbar updates the DOM directly: a scroll event must never
  // re-render the diff tree, which is the expensive part of this pane.
  const barRef = useRef(null);
  const barTimer = useRef(null);
  const onDiffScroll = (event) => {
    const el = event.currentTarget;
    const bar = barRef.current;
    if (!bar) return;
    const max = Math.max(1, el.scrollHeight - el.clientHeight);
    const h = Math.max(28, (el.clientHeight * el.clientHeight) / el.scrollHeight);
    bar.style.height = `${h}px`;
    bar.style.transform = `translateY(${el.scrollTop + (el.scrollTop / max) * (el.clientHeight - h)}px)`;
    bar.style.opacity = "1";
    clearTimeout(barTimer.current);
    barTimer.current = setTimeout(() => { bar.style.opacity = "0"; }, 800);
  };
  useEffect(() => {
    const sigs = new Map(sections.map((s) => [s.path, sectionSignature(s)]));
    // Nothing loaded yet is not an observation: recording an empty list would make
    // the first real diff look like every file is new, opening collapsed ones.
    if (!sigs.size) return;
    const prev = seenSections.current;
    seenSections.current = { scope, sigs };
    if (!prev || prev.scope !== scope || !prev.sigs.size) return;
    const open = filesToOpen(prev.sigs, sigs, collapsedFiles);
    if (!open.length) return;
    setCollapsedFiles((c) => {
      const next = { ...c };
      for (const path of open) delete next[path];
      return next;
    });
  }, [sections, scope]);

  // Only on a real change: persisting on mount would write an empty map over the
  // state being restored, and the restore reads the scoped key first.
  const persistedCollapse = useRef(collapsedFiles);
  useEffect(() => {
    if (persistedCollapse.current === collapsedFiles) return;
    persistedCollapse.current = collapsedFiles;
    persist({ collapsedFiles });
  }, [collapsedFiles]);
  const stats = useMemo(() => {
    const m = new Map();
    for (const s of sections) {
      const added = s.lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
      const removed = s.lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
      const isNew = s.lines.some((l) => l === "--- /dev/null" || l.startsWith("new file mode"));
      const isDeleted = s.lines.some((l) => l === "+++ /dev/null" || l.startsWith("deleted file mode"));
      const isRenamed = s.lines.some((l) => l.startsWith("rename from "));
      m.set(s.path, { added, removed, isNew, status: isNew ? "added" : isDeleted ? "deleted" : isRenamed ? "renamed" : "modified" });
    }
    return m;
  }, [sections]);

  const q = filter.trim().toLowerCase();
  // Cursor's "Show:" filters: deleted files and test files can be hidden from
  // the tree. Deleted = every hunk is a whole-file deletion.
  const isTestPath = (p) => /(^|[/\\])(test|tests|__tests__|spec)([/\\]|$)|\.(test|spec)\.[^.]+$|\btest_[^/]*\.py$/i.test(p);
  // Stable across renders: a fresh array here invalidated every downstream memo
  // and re-mapped the whole diff tree on any click.
  const dq = filter.trim().toLowerCase();
  const visibleFiles = useMemo(() => sections.filter((s) => {
    // Search covers the changes, not only the file names: a reviewer looks for
    // the identifier they changed, which is not in the path.
    if (dq && !(s.hay || "").includes(dq)) return false;
    const st = stats.get(s.path);
    if (!showDeleted && st?.status === "deleted") return false;
    if (!showTests && isTestPath(s.path)) return false;
    return true;
  }), [sections, dq, showDeleted, showTests, stats]);
  const hiddenByFilters = sections.filter((s) => (!showDeleted && stats.get(s.path)?.status === "deleted") || (!showTests && isTestPath(s.path))).length;
  const allCollapsed = visibleFiles.length > 0 && visibleFiles.every((s) => collapsedFiles[s.path]);
  const tree = useMemo(() => compactTree(buildTree(visibleFiles.map((s) => s.path))), [visibleFiles]);
  const active = visibleFiles.find((s) => s.path === selected) || visibleFiles[0];
  // Click a line, then click another: the range between the two clicks highlights
  // and a floating "Cite in message" action inserts the Hermes-native reference
  // (@line:`path:start-end`) into the focused composer draft. Never auto-sends.
  const [lineSelection, setLineSelection] = useState(null); // {file, sha, side, anchor?, start, end}
  // Only new-side lines of the CURRENT file reach here (callers gate on
  // scope and row kind): ranges always cite the file the composer will read.
  // The gutter is the selection surface, the way an editor does it: the code itself
  // keeps its text cursor and native copy, so a drag over code selects text while a
  // drag down the line numbers selects a cite range.
  const gutterAnchor = useRef(null);
  const onGutterDown = (s, row) => (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const line = row.after;
    if (line == null) return;
    const file = s.filePath || s.path;
    gutterAnchor.current = { file, line };
    onLineClick(s, row)(event);
  };
  const onGutterEnter = (s, row) => (event) => {
    if (event.buttons !== 1 || !gutterAnchor.current) return;
    const line = row.after;
    if (line == null) return;
    const file = s.filePath || s.path;
    if (gutterAnchor.current.file !== file) return;
    const anchor = gutterAnchor.current.line;
    const lo = Math.min(anchor, line), hi = Math.max(anchor, line);
    setLineSelection({ file, sha: s.sha, anchor: null, start: lo, end: hi });
  };
  const onLineClick = (s, row) => (event) => {
    event.stopPropagation();
    const line = row.after;
    if (line == null) return;
    const file = s.filePath || s.path;
    setLineSelection((sel) => {
      if (sel && sel.file === file && sel.anchor != null) {
        // Clicking the anchor line itself leaves selection mode.
        if (sel.anchor === line) return null;
        const lo = Math.min(sel.anchor, line), hi = Math.max(sel.anchor, line);
        return { file, sha: s.sha, anchor: null, start: lo, end: hi };
      }
      // Clicking the only selected line again leaves selection mode too.
      if (sel && sel.file === file && sel.start === line && sel.end === line) return null;
      return { file, sha: s.sha, anchor: line, start: line, end: line };
    });
  };
  // Cite reference text — one shared formatter for click and drag. The ref must
  // point at the file in the REVIEWED repo: build the absolute repo path first,
  // then make it session-relative exactly like core contextPath(). Quote with
  // backticks only when the value contains whitespace (core formatRefValue).
  const citeRefText = (relFile, start, end) => {
    const root = (chosen || "").replace(/\/$/, "");
    const abs = root ? `${root}/${relFile}` : relFile;
    const cwdHere = (cwd || "").replace(/\/$/, "");
    const rel = cwdHere && abs.startsWith(`${cwdHere}/`) ? abs.slice(cwdHere.length + 1) : abs;
    const value = `${rel}:${start}-${end}`;
    return /\s/.test(value) ? `@line:\`${value}\`` : `@line:${value}`;
  };
  const citeSelection = () => {
    if (!lineSelection) return;
    if (!CITABLE_SCOPES.has(scope)) return; // stored selection predates a scope switch
    const { file, start, end } = lineSelection;
    const ref = citeRefText(file, start, end);
    // setDraft is the contract that turns an `@`-ref token into a composer chip: the
    // app re-renders the draft through its own paint path (insertText only appends
    // plain text). Read the draft first so the reference is appended, not the draft
    // replaced; fall back to insertText on a host that predates getDraft/setDraft.
    const composer = host.composer || {};
    if (typeof composer.getDraft === "function" && typeof composer.setDraft === "function") {
      Promise.resolve(composer.getDraft(null)).catch(() => null).then((base) => {
        const draft = typeof base === "string" ? base : "";
        const text = draft.trim() ? `${draft.trimEnd()} ${ref}` : ref;
        return Promise.resolve(composer.setDraft(null, text));
      }).then((ok) => {
        // setDraft fails closed when no mounted composer answers for the address: the
        // chat may be on another surface, or the pane has focus. Append through
        // insertText instead of leaving the reviewer with a toast and no citation.
        if (ok !== false) return undefined;
        const insert = host.composer && host.composer.insertText;
        if (typeof insert !== "function") throw new Error("no composer verbs");
        return Promise.resolve(insert(null, ref, { mode: "inline" })).then((done) => {
          if (done === false) host.notify({ kind: "info", message: "No focused composer — click into the chat input first." });
        });
      }).catch(() => {});
    } else {
      const result = composer.insertText(null, ref, { mode: "inline" });
      Promise.resolve(result).catch(() => {}).then((ok) => {
        if (ok === false) host.notify({ kind: "info", message: "No focused composer — click into the chat input first." });
      });
    }
    setLineSelection(null);
  };
  // Drag-to-cite: every code line is draggable. The payload mirrors the composer's
  // real drop contract (use-composer-actions.ts extractDroppedFiles): MIME
  // `application/x-hermes-paths`, JSON `[{ path, line, lineEnd? }]` — ONE entry
  // per range, path as the session-relative form the gateway resolves. A
  // cancelled drag (dropEffect 'none') inserts nothing.
  // Citation scope rule: @line: refs resolve against the worktree file, so
  // only scopes whose new side IS the worktree may cite or drag. Staged diffs
  // number lines against the index (which can drift from the worktree) and
  // commits against a historical blob — both stay non-interactive.
  // Empty states name the scope, the way Cursor's Changes panel does: "No staged
// changes" says what to do next where "No changes" says nothing.
const EMPTY_SCOPE = {
  agent_turn: ["No changes in the last agent turn", "The next turn is captured automatically."],
  uncommitted: ["No uncommitted changes", "The worktree matches HEAD and nothing is staged."],
  staged: ["No staged changes", "Stage files in your VCS, or review the worktree instead."],
  unstaged: ["No unstaged changes", "The worktree matches the index."],
  commits: ["No changes in the selected commits", "Pick different commits or a different comparison base."],
};
const CITABLE_SCOPES = new Set(["uncommitted", "unstaged", "agent_turn"]);
  const LINE_DRAG_MIME = "application/x-hermes-paths";
  const gutterHandlers = (s, file) => (row) => {
    if (!CITABLE_SCOPES.has(scope) || !row || row.after == null || row.kind === "remove") return null;
    // Press and drag, with pointer capture: the capture keeps pointermove events on
    // the gutter, so the range extends across rows even when the pointer leaves the
    // cell. A press without movement is the click that anchors one line.
    const lineOf = (event) => {
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const rowEl = el && el.closest ? el.closest(".line[data-line]") : null;
      const n = rowEl && rowEl.getAttribute("data-line");
      return n == null || n === "" ? null : Number(n);
    };
    return {
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();   // the pane clears a selection on an outside click
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* optional */ }
        gutterAnchor.current = { file, line: row.after };
        onLineClick(s, row)(event);
      },
      onPointerMove: (event) => {
        const anchor = gutterAnchor.current;
        if (!anchor || anchor.file !== file || event.buttons !== 1) return;
        const target = lineOf(event);
        if (target == null) return;
        setLineSelection({
          file, sha: s.sha, anchor: null,
          start: Math.min(anchor.line, target), end: Math.max(anchor.line, target),
        });
      },
      onPointerUp: (event) => {
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* released */ }
      },
      onClick: (event) => event.stopPropagation(),
    };
  };
  const lineDragProps = (file) => (row) => {
    if (!CITABLE_SCOPES.has(scope)) return {};
    if (!chosen) return {};
    if (!row || (row.kind !== "context" && row.kind !== "add")) return {};
    const line = row.after;
    if (line == null) return {};
    const inSel = lineSelection && lineSelection.file === file && line >= lineSelection.start && line <= lineSelection.end;
    const start = inSel ? lineSelection.start : line;
    const end = inSel ? lineSelection.end : line;
    const absPath = `${chosen.replace(/\/$/, "")}/${file}`;
    return {
      draggable: true,
      onDragStart: (event) => {
        try {
          event.dataTransfer.setData(LINE_DRAG_MIME, JSON.stringify([{ path: absPath, line: start, ...(end > start ? { lineEnd: end } : {}) }]));
          event.dataTransfer.setData("text/plain", citeRefText(file, start, end));
          event.dataTransfer.effectAllowed = "copy";
        } catch { /* DataTransfer may be unavailable; a failed drag payload is non-fatal */ }
      },
    };
  };

  // "Review next file", the way Cursor's Changes tab does it: step through the
  // files that changed, opening each, without hunting in the tree.
  const reviewNext = () => {
    if (!visibleFiles.length) return;
    // The destination is the next file the reviewer COLLAPSED - a collapsed file is
    // the one still waiting for review - not simply the next row. With nothing
    // collapsed the button still advances, so it never goes dead.
    const at = visibleFiles.findIndex((s) => s.path === active.path);
    const after = [...visibleFiles.slice(at + 1), ...visibleFiles.slice(0, Math.max(0, at + 1))];
    const next = after.find((s) => collapsedFiles[s.path]) || after.find((s) => s.path !== active.path);
    // Stepping through files is navigation, not a layout edit: the target keeps its
    // collapsed state and its header is the destination.
    if (next) scrollToSelection(next.path, { reveal: false });
  };

  // Clicking a file in the tree scrolls the stacked diff to that file's section.
  // `reveal` is for the tree, where clicking a file means "show me this one". The
  // toolbar's step-through does not pass it, so collapse state survives.
  const scrollToSelection = (path, { reveal = true } = {}) => {
    setSelected(path);
    if (reveal) setCollapsedFiles((c) => (c[path] ? { ...c, [path]: false } : c));
    requestAnimationFrame(() => {
      const scroller = document.querySelector(".grd .allfiles");
      const section = scroller?.querySelector(`.af-file[data-path="${CSS.escape(path)}"]`);
      if (!scroller || !section) return;
      const top = scrollTopFor({
        elementTop: section.getBoundingClientRect().top,
        scrollerTop: scroller.getBoundingClientRect().top,
        scrollTop: scroller.scrollTop,
      });
      // A file near the end of the list (collapsed files are short) cannot reach the
      // top: the column stops scrolling first, and the header stays under the
      // previous file's sticky one. Scroll past the end by exactly the missing
      // distance - the editor convention - and drop it on a jump that needs none.
      const tail = parseFloat(scroller.style.paddingBottom) || 0;
      const max = scroller.scrollHeight - tail - scroller.clientHeight;
      scroller.style.paddingBottom = `${Math.max(0, Math.ceil(top - max))}px`;
      scroller.scrollTo({ top, behavior: "smooth" });
    });
  };
  const scopeLabel = scope === "commits" ? (picked.size ? `Commits (${picked.size})` : "Commits")
    : scope === "agent_turn" ? "Last agent turn"
    : SCOPES.find((s) => s.id === scope)?.label;
  // Aggregate stats for the scope trigger (Cursor shows +N −N next to the scope).
  const total = useMemo(() => {
    let added = 0, removed = 0;
    for (const s of visibleFiles) { added += stats.get(s.path)?.added || 0; removed += stats.get(s.path)?.removed || 0; }
    return { added, removed };
  }, [visibleFiles, stats]);

  const copyPath = async (path) => {
    const ok = await Promise.resolve(ctx.os.writeClipboard ? ctx.os.writeClipboard(path) : false).catch(() => false);
    if (ok) { setCopied(path); setTimeout(() => setCopied(""), 1500); }
    else host.notify({ kind: "info", message: path });
  };


  const toggleCommit = (sha) => { commitSelectionExplicit.current = true; setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(sha)) next.delete(sha);
    else next.add(sha);
    return next;
  }); };

  const openPR = () => {
    if (!pr?.url || !/^https:\/\//i.test(pr.url)) return;
    const opener = ctx.os.openExternal(pr.url);
    Promise.resolve(opener).then((ok) => {
      if (!ok) host.notify({ kind: "info", message: pr.url });
    });
  };

  return jsxs("section", { className: "grd", "aria-label": "git-review", onClick: () => setLineSelection((sel) => (sel ? null : sel)), children: [
    jsx("style", { children: css }),
    // ── toolbar: scope · repo/branch · right group (PR · display ⋯ · collapse all · file list)
    jsxs("div", { className: "toolbar", children: [
      jsxs(DropdownMenu, { children: [
        jsx(DropdownMenuTrigger, { asChild: true, children:
          jsx(Button, { variant: "ghost", size: "sm", className: "scope-btn", children: jsxs("span", { style: { display: "inline-flex", alignItems: "center", gap: 6 }, children: [
            jsx(Codicon, { name: "git-branch", size: "0.85rem" }),
            jsx("span", { className: "scope-text", children: scopeLabel || "Scope" }),
            diff && !diff.note && !busy && !wholeHistorySelected ? jsx(DeltaCounts, { added: diff.added, removed: diff.removed }) : null,
            jsx(Codicon, { name: "chevron-down", size: "0.8rem" })
          ] }) })
        }),
        jsxs(DropdownMenuContent, { className: "gr-menu", children: [
          SCOPES.map((s) => jsx(DropdownMenuItem, { onSelect: () => setScope(s.id), children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [
            jsx(CheckSlot, { on: s.id === scope, size: "0.8rem" }),
            s.label
          ] }) }, s.id)),
          // Commits is a multi-select dropdown, not a page: checkable commits
          // inline in the scope menu (all checked by default).
          scope === "commits" ? jsxs(Fragment, { children: [
            jsx(DropdownMenuSeparator, {}),
            jsx(CommitsSubmenu, { commits, selected: picked, onToggle: toggleCommit, hasMore, loadingMore, onMore: loadOlder, onOpen: goCommit,
              range: { all: allHistory, base, auto: autoBase },
              onRange: ({ all, base: b }) => { setAllHistory(all); setBase(b); commitSelectionExplicit.current = false; },
              onAll: () => { commitSelectionExplicit.current = true; setPicked(new Set(commits.map((c) => c.sha))); },
              onNone: () => { commitSelectionExplicit.current = true; setPicked(new Set()); } })
          ] }) : null,
          jsx(DropdownMenuSeparator, {}),
          jsx(DropdownMenuItem, { onSelect: () => setTick((n) => n + 1), children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [jsx(CheckSlot, { on: false, size: "0.8rem" }), "Refresh"] }) })
        ] })
      ] }),
      jsxs(DropdownMenu, { children: [
        jsx(DropdownMenuTrigger, { asChild: true, children:
          jsx(RepoButton, { icon: "repo", label: meta?.name || "Choose repo…" })
        }),
        jsx(DropdownMenuContent, { className: "gr-menu repo-menu", children: (() => {
          // Group worktrees by parent folder (their "category"): sibling checkouts
          // of the same repo across workspaces keep distinguishable context, and
          // same-named repos in different groups don't collide visually.
          const groups = new Map();
          for (const w of worktrees) {
            const parent = w.path.split("/").slice(0, -1).filter(Boolean);
            const key = parent.length ? parent[parent.length - 1] : "(root)";
            (groups.get(key) || groups.set(key, []).get(key)).push(w);
          }
          const out = [];
          for (const [group, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            out.push(jsx("div", { className: "menu-group", role: "separator", children: group }, `g:${group}`));
            for (const w of items) {
              const rel = w.path.split("/").slice(0, -1).filter(Boolean);
              const inGroup = rel[rel.length - 1] === group ? rel.slice(0, -1).join("/") : rel.join("/");
              out.push(jsx(DropdownMenuItem, { onSelect: () => chooseRepository(w.path), children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [
                jsx("span", { className: "check-slot", children: jsx(Codicon, { name: w.path === chosen ? "check" : "repo", size: "0.8rem" }) }),
                jsxs("span", { style: { flex: "1 1 0", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: [
                  w.name, " ",
                  jsx("span", { style: { color: "var(--ui-text-tertiary)" }, children: `${inGroup ? `/${inGroup} · ` : ""}${w.branch || "(detached)"}` })
                ] })
              ] }) }, w.path));
            }
          }
          return out;
        })() })
      ] }),
      jsxs(DropdownMenu, { children: [
        jsx(DropdownMenuTrigger, { asChild: true, children:
          // The base, named plainly — Cursor says "against main" only inside a
          // sentence, never on the control.
          jsx(RepoButton, { icon: "git-branch", label: shortLabel(shownBase || "main") })
        }),
        jsx(DropdownMenuContent, { className: "gr-menu", children: [
          // The label sits OUTSIDE the scrolling list. Inside it, the list's own
          // padding showed a clipped row above the sticky label; outside, no row
          // can ever render above it.
          jsx("div", { className: "menu-group menu-head", role: "presentation", children: "Compare against…" }, "hdr"),
          jsx("div", { className: "repo-menu", children: branchRows.map((row) => jsx(DropdownMenuItem, { onSelect: () => {
            // A different base is a different commit range: the previous picks no
            // longer belong to it, so they must not stay selected.
            setAllHistory(false); setBase(row.value); setPicked(new Set()); setNavIndex(-1); commitSelectionExplicit.current = false;
          }, children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [
            jsx(CheckSlot, { on: shortLabel(shownBase) === row.name, size: "0.8rem" }),
            jsx("span", { style: { flex: "1 1 0", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: row.name }),
            row.name === meta?.current
              ? jsx("span", { style: { color: "var(--ui-text-tertiary)", fontSize: 11 }, children: "current" })
              : (shortLabel(shownBase) === row.name && !base ? jsx("span", { style: { color: "var(--ui-text-tertiary)", fontSize: 11 }, children: "default" }) : null)
          ] }) }, row.value)) })
        ] })
      ] }),
      // Right-side controls group (PR · display · collapse all · file list); margin-left:
      // auto pushes it right WITHOUT a spacer stealing flex space from the
      // repo/branch buttons.
      jsxs("div", { className: "toolbar-end", children: [
      pr?.url ? jsx(Tip, { label: pr.title || "Open merge request", children: jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": pr.iid != null ? `Open ${pr.url.includes("github") ? `PR #${pr.iid}` : `MR !${pr.iid}`}` : "Open pull request", onClick: openPR, children: jsx(Codicon, { name: "git-pull-request", size: "0.9rem" }) }) }) : null,
      jsxs(DropdownMenu, { children: [
        jsx(DropdownMenuTrigger, { asChild: true, children:
          jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": "Display options", children: jsx(Codicon, { name: "ellipsis", size: "0.9rem" }) })
        }),
        jsxs(DropdownMenuContent, { className: "gr-menu", children: [
          jsxs("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", fontSize: 12 }, children: [
            jsx(Switch, { size: "xs", checked: ignoreWs, onCheckedChange: (v) => { setIgnoreWs(v); persist({ ignoreWs: v }); }, "aria-label": "Ignore whitespace" }),
            "Ignore whitespace"
          ] }),
          jsxs("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", fontSize: 12 }, title: layout === "split" ? "Always on in split layout" : undefined, children: [
            jsx(Switch, { size: "xs", checked: wordWrap || layout === "split", disabled: layout === "split", onCheckedChange: (v) => { if (layout !== "split") { setWordWrap(v); persist({ wordWrap: v }); } }, "aria-label": "Word wrap" }),
            "Word wrap"
          ] }),
          jsx(DropdownMenuSeparator, {}),
          jsx(DropdownMenuItem, { onSelect: () => { setLayout("unified"); persist({ layout: "unified" }); }, children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [
            jsx(CheckSlot, { on: layout === "unified", size: "0.8rem" }),
            "Layout: Unified"
          ] }) }),
          jsx(DropdownMenuItem, { onSelect: () => { setLayout("split"); persist({ layout: "split" }); }, children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [
            jsx(CheckSlot, { on: layout === "split", size: "0.8rem" }),
            "Layout: Split"
          ] }) })
        ] })
      ] }),
      jsx(Tip, { label: "Review next file", children: jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": "Review next file",
        onClick: reviewNext, children: jsx(Codicon, { name: "arrow-right", size: "0.9rem" }) }) }),
      jsx(Tip, { label: allCollapsed ? "Expand all" : "Collapse all", children: jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": allCollapsed ? "Expand all" : "Collapse all",
        onClick: () => { setExpanded({}); setContextModes({}); setFullFiles({}); setCollapsedFiles(allCollapsed ? {} : Object.fromEntries(visibleFiles.map((s) => [s.path, true]))); },
        children: jsx(Codicon, { name: allCollapsed ? "expand-all" : "collapse-all", size: "0.9rem" }) }) }),
      // Order per spec: ⋯ display · Collapse all · Hide/Show right sidebar (last).
      jsx(Tip, { label: visible.files ? "Hide file list" : "Show file list", children: jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": visible.files ? "Hide file list" : "Show file list", "aria-pressed": visible.files, onClick: () => { setVisible((v) => { persist({ files: !v.files }); return { ...v, files: !v.files }; }); }, children: jsx(Codicon, { name: visible.files ? "layout-sidebar-right" : "layout-sidebar-right-off", size: "0.9rem" }) }) })
      ] })
    ] }),
    pathFilter && jsx(Button, { variant: "ghost", size: "sm", onClick: () => setPathFilter(""), children: `File: ${pathFilter} ×` }),
    lineSelection && lineSelection.anchor == null && jsxs("div", { className: "cite-bar", role: "toolbar", "aria-label": "Line selection actions", children: [
      jsx(Codicon, { name: "symbol-string", size: "0.85rem" }),
      jsxs("span", { className: "cite-ref", children: [
        lineSelection.file, ":", lineSelection.start, lineSelection.end !== lineSelection.start ? `-${lineSelection.end}` : "",
      ] }),
      jsx(Button, { variant: "outline", size: "sm", "aria-label": "Cite selected lines in focused message draft", onClick: citeSelection, children: "Cite in message" }),
      jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": "Clear line selection", onClick: () => setLineSelection(null), children: jsx(Codicon, { name: "close", size: "0.85rem" }) }),
    ] }),
    lineSelection && lineSelection.anchor != null && jsxs("div", { className: "cite-bar", role: "status", children: [
      jsx(Codicon, { name: "symbol-string", size: "0.85rem" }),
      jsx("span", { className: "cite-ref", children: `${lineSelection.file}:${lineSelection.start} — click another line to finish the range` }),
      jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": "Clear line selection", onClick: () => setLineSelection(null), children: jsx(Codicon, { name: "close", size: "0.85rem" }) }),
    ] }),
    (scope === "commits" && navIndex >= 0 && commits[navIndex]) && jsxs("div", { className: "notice commit-nav", role: "navigation", "aria-label": "Commit navigation", style: { display: "flex", alignItems: "center", gap: 6 }, children: [
      jsx(Button, { size: "icon", variant: "ghost", disabled: navIndex <= 0, "aria-label": "Newer commit", onClick: () => goCommit(navIndex - 1), children: "◀" }),
      jsx(Button, { size: "icon", variant: "ghost", disabled: navIndex >= commits.length - 1 && !hasMore, "aria-label": "Older commit", onClick: () => (navIndex >= commits.length - 1 ? loadOlder() : goCommit(navIndex + 1)), children: "▶" }),
      jsx("span", { style: { flex: "1 1 0", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: commits[navIndex].subject, children: `${commits[navIndex].short} · ${commits[navIndex].subject} — ${commits[navIndex].author}, ${new Date(commits[navIndex].at * 1000).toLocaleDateString()}${wholeHistorySelected ? "" : ` (${navIndex + 1}/${commits.length}${hasMore ? "+" : ""})`}` }),
      jsx(Button, { size: "sm", variant: "ghost", onClick: () => { setNavIndex(-1); setPicked(new Set(commits.map((c) => c.sha))); }, children: "All commits" })
    ] }),
    (scope === "commits" && historyNote) && jsx("div", { className: "notice", role: "status", children: historyNote }),
    (error || diff?.note) && jsxs("div", { className: "notice", role: "alert", children: [
      jsx(Codicon, { className: "text-(--ui-orange) shrink-0", name: "warning", size: "0.85rem" }),
      error || diff?.note
    ] }),
    !worktrees.length && !error
      ? jsx(EmptyState, { title: "No worktrees found", description: "Focus a chat in a Git repository or configure explicit repos/roots in plugin settings." })
      : !diff
        ? jsx(EmptyState, { title: error ? "Nothing to show" : (scope === "commits" && !commitsRef ? (commitsLoading ? "Loading commit list…" : commits.length ? "No commits selected — open the scope menu and check the commits to review" : "No commits to show") : scope === "agent_turn" ? (turnBase ? "Loading…" : "No agent turn observed for this repository yet — the next agent turn will be captured.") : "Loading…"), description: error ? "See the message above, then retry or switch scope." : undefined })
        : !sections.length && !diff.note
          ? jsx(EmptyState, { title: (EMPTY_SCOPE[scope] || ["No changes in this scope"])[0], description: (EMPTY_SCOPE[scope] || [null, "Try a different scope or worktree."])[1] })
          : jsxs("div", { className: cn("body", !visible.files && "tree-hidden"), style: visible.files && filesWidth ? { "--files-w": `${filesWidth}px` } : undefined, children: [
            // MAIN: every changed file's diff stacked (Cursor Changes), scroll to the last one.
            jsxs("div", { className: "allfiles", onScroll: onDiffScroll, children: [
              jsx("div", { ref: barRef, className: "ov-bar", "aria-hidden": true }),
              !visibleFiles.length && jsx(EmptyState, { title: q ? `No files match “${filter.trim()}”` : "All files are hidden by filters", description: sections.length ? "Clear the search or adjust the filters." : "" }),
              visibleFiles.map((s) => {
              const collapsed = !!collapsedFiles[s.path];
              const { rows: rawRows, hunks } = cachedDiffRows(s.lines);
              const gutterWidth = `${rawRows.reduce((width, row) => Math.max(width, String(row.before ?? "").length, String(row.after ?? "").length), 4)}ch`;
              const mode = contextModes[s.path] || "compact";
              const folded = mode === "full" ? rawRows : collapseRows(rawRows, mode === "hidden" ? 0 : 3);
              const hasContext = rawRows.some((row) => row.kind === "context");
              const srows = collapsed ? [] : folded.flatMap((row) =>
                row.kind === "fold" && expanded[`${s.path}:${row.key}`] ? row.rows : [row]);
              // Gap expanders: lines outside the patch context, fetched on demand.
              // Gaps are computed on the NEW side (the side /file-lines reads);
              // delta = newStart - oldStart converts new numbers back to old.
              const isDeletedFile = s.lines.some((l) => l === "+++ /dev/null");
              const rev = scope === "commits" ? s.sha : scope === "staged" ? "index" : "worktree";
              const gaps = [];
              if (hunks.length && !isDeletedFile && rev) {
                const first = hunks[0];
                // Top gap precedes every change: old and new numbering agree (delta 0).
                if (first.newStart > 1) gaps.push({ key: "top", from: 1, to: first.newStart - 1, count: first.newStart - 1, delta: 0 });
                for (let h = 1; h < hunks.length; h++) {
                  const from = hunks[h - 1].newStart + hunks[h - 1].newCount, to = hunks[h].newStart - 1;
                  if (to >= from) gaps.push({ key: `mid${h}`, from, to, count: to - from + 1, delta: hunks[h].newStart - hunks[h].oldStart });
                }
                const last = hunks.at(-1);
                const tailFrom = last.newStart + last.newCount;
                let trailing = 0;
                for (let i = rawRows.length - 1; i >= 0 && rawRows[i].kind === "context" && rawRows[i].hunk === last.index; i--) trailing++;
                // The backend counts the worktree file, so the run below the last
                // hunk can name its length instead of asking for an open-ended run.
                const total = diff?.total_lines?.[s.path];
                const bottomTo = typeof total === "number" && total >= tailFrom ? total : Number.MAX_SAFE_INTEGER;
                // One bar per run, and none for an empty run: when the diff knows the
                // file's length, a run that starts past the end is not a run.
                if (trailing >= PATCH_CONTEXT && bottomTo >= tailFrom) gaps.push({ key: "bottom", from: tailFrom, to: bottomTo, count: bottomTo === Number.MAX_SAFE_INTEGER ? null : bottomTo - tailFrom + 1, delta: (last.newStart + last.newCount) - (last.oldStart + last.oldCount), open: true });
              }
              const realPath = s.filePath || s.path;
              const fetchLines = (r, start, end) => ctx.rest("/file-lines", { method: "POST", timeoutMs: 15000, body: { repo: chosen, path: realPath, rev: r, start, end } });
              const fold = (row, gap) => jsx(FoldBar, {
                row, path: s.path, rev, gap, compact: layout === "split",
                autoAll: !!fullFiles[s.path],
                onExpandAll: () => {
                  setFullFiles((m) => ({ ...m, [s.path]: true }));
                  setContextModes((m) => ({ ...m, [s.path]: "full" }));
                  setExpanded((e) => ({ ...e, [`${s.path}:${row.key}`]: true }));
                },
                onFetch: fetchLines,
              }, `${chosen}|${rev}|${s.path}:${row.key}:${gap?.key || "fold"}|${fullFiles[s.path] ? "full" : "part"}`);
              const bars = mode === "full" && hasContext
                ? [jsx(FullBar, { path: s.path, label: "Hide all unchanged lines", onToggle: () => {
                    setContextModes((m) => ({ ...m, [s.path]: "hidden" }));
                    setFullFiles((m) => ({ ...m, [s.path]: false }));
                    setExpanded((e) => Object.fromEntries(Object.entries(e).filter(([key]) => !key.startsWith(`${s.path}:context:`))));
                  } }, `${s.path}:fullbar`)]
                : mode === "hidden" && hasContext
                  ? [jsx(FullBar, { path: s.path, label: "Show all unchanged lines", onToggle: () => {
                      setContextModes((m) => ({ ...m, [s.path]: "full" }));
                    } }, `${s.path}:hiddenbar`)]
                  : [];
              // Interleave gap expander bars (loaded via /file-lines) at hunk
              // boundaries: above the first hunk, between hunks, below the last.
              const gapFor = (beforeRowHunk) => {
                if (beforeRowHunk == null) return null;
                const g = gaps.find((g) => g.key === `mid${beforeRowHunk}`);
                return g || null;
              };
              // One bar per hidden run. A gap bar (lines outside the patch,
              // fetched on demand) and an in-patch fold that touch with no
              // change between them are the same run, so they merge into one
              // bar instead of stacking two "N unmodified lines" controls.
              const runBars = (out) => {
                let gap = null, foldRow = null;
                const flush = () => {
                  if (gap && foldRow) {
                    const nums = (foldRow.rows || []).map((r) => r.after ?? r.before).filter((n) => typeof n === "number");
                    if (nums.length) {
                      const from = Math.min(gap.from, ...nums);
                      const to = Math.max(gap.to, ...nums);
                      // A bottom gap has no count: it runs to the end of the file.
                      gap = { ...gap, from, to, count: gap.count == null ? null : to - from + 1 };
                    }
                  }
                  if (gap) out.push(fold({ key: `gap${gap.key}`, count: gap.count, rows: [] }, gap));
                  else if (foldRow) out.push(fold(foldRow, null));
                  gap = null; foldRow = null;
                };
                return {
                  fold: (row) => { foldRow = row; if (gap) flush(); },
                  gap: (g) => { gap = g; if (foldRow) flush(); },
                  // Anything that is not a bar ends the run.
                  row: () => { if (gap || foldRow) flush(); },
                  end: () => flush(),
                };
              };
              // Split layout pairs the rows, so the gap bars are interleaved
              // here the same way renderStream does for the unified stream.
              const splitStream = (pairs) => {
                const out = [];
                const run = runBars(out);
                const top = gaps.find((g) => g.key === "top");
                if (top) run.gap(top);
                let lastHunk = null;
                pairs.forEach((pair, i) => {
                  if (pair.shared?.kind === "fold") { run.fold(pair.shared); return; }
                  run.row();
                  const hunk = pair.shared?.hunk ?? pair.left?.hunk;
                  if (hunk != null && lastHunk != null && hunk !== lastHunk) {
                    const g = gapFor(hunk);
                    // Flush now: a queued bar would be emitted after this row,
                    // landing one row late and leaving the run it describes open.
                    if (g) { run.gap(g); run.row(); }
                  }
                  if (hunk != null) lastHunk = hunk;
                  out.push(pair.shared
                    ? renderUnifiedRow(pair.shared, `shared:${i}`, gutterFor, selectedLines, dragFor)
                    : jsxs("div", { className: "split-row", "data-diff-row": i, children: [
                        renderSplitRow(pair.left, i, "left", gutterFor, selectedLines, dragFor), renderSplitRow(pair.right, i, "right", gutterFor, selectedLines, dragFor),
                      ] }, i));
                });
                const bottom = gaps.find((g) => g.key === "bottom");
                if (bottom) run.gap(bottom);
                run.end();
                return out;
              };
              const renderStream = (rows, split) => {
                const out = [];
                // FullBar (mode full/hidden) always leads the stream.
                for (const bar of bars) out.push(bar);
                const run = runBars(out);
                const top = !split && gaps.find((g) => g.key === "top");
                if (top) run.gap(top);
                let lastHunk = null;
                for (const row of rows) {
                  if (row.kind === "fold") { run.fold(row); continue; }
                  run.row();
                  if (!split && row.hunk != null && lastHunk != null && row.hunk !== lastHunk) {
                    const g = gapFor(row.hunk);
                    // Same rule as split: the bar closes the run before the row.
                    if (g) { run.gap(g); run.row(); }
                  }
                  if (row.hunk != null) lastHunk = row.hunk;
                  out.push(split ? row : renderUnifiedRow(row, `${row.kind}:${row.before}:${row.after}:${row.hunk}`, gutterFor, selectedLines, dragFor));
                }
                if (!split) {
                  const bottom = gaps.find((g) => g.key === "bottom");
                  if (bottom) run.gap(bottom);
                }
                run.end();
                return out;
              };
              const file = s.filePath || s.path;
              const selectedLines = lineSelection && lineSelection.file === file
                ? new Set(Array.from({ length: lineSelection.end - lineSelection.start + 1 }, (_, n) => lineSelection.start + n))
                : null;
              // Range selection drives citations — same eligibility as drag.
              const gutterFor = CITABLE_SCOPES.has(scope) ? gutterHandlers(s, file) : null;
              const dragFor = lineDragProps(file);
              // Files whose patch carries no hunks (binary, mode-only, pure rename)
              // render a single muted note instead of an empty body.
              const note = !hunks.length
                ? [jsx("div", { className: "notice", role: "note", children: noHunkMessage(s.lines, ignoreWs) }, `${s.path}:note`)]
                : [];
              return jsxs("section", { className: cn("af-file", collapsed && "af-collapsed"), "data-path": s.path, style: { "--gr-gutter-width": gutterWidth }, children: [
                jsxs("div", { className: "af-head", children: [
                  jsxs("button", { type: "button", className: "file-toggle", "aria-expanded": !collapsed,
                    "aria-label": `${collapsed ? "Expand" : "Collapse"} diff for ${s.path}`,
                    onClick: () => setCollapsedFiles((c) => ({ ...c, [s.path]: !c[s.path] })), children: [
                      jsx(Codicon, { name: collapsed ? "chevron-right" : "chevron-down", size: "0.8rem" }),
                      jsx("span", { className: "fname", children: basename(s.path) }),
                      jsx("span", { className: "fdir", children: s.path }),
                    ] }),
                  jsx(DeltaCounts, { added: stats.get(s.path)?.added, removed: stats.get(s.path)?.removed }),
                  jsx(Button, { variant: "ghost", size: "icon-sm", className: "af-copy", title: "Copy path", "aria-label": `Copy path for ${s.path}`,
                    onClick: () => copyPath(s.path), children: jsx(Codicon, { name: copied === s.path ? "check" : "copy", size: "0.8rem" }) }),
                ] }),
                ...(!collapsed ? note : []),
                !collapsed && (layout === "split"
                  ? jsx("div", { className: cn("splitwrap", "wordw"), tabIndex: 0, "aria-label": `Split diff of ${s.path}`, children: [
                      ...bars,
                      ...splitStream(splitRows(srows).pairs),
                    ] })
                  : jsx("div", { className: cn("diff", wordWrap && "wordw"), tabIndex: 0, "aria-label": `Diff of ${s.path}`, children:
                      renderStream(srows, false) }))
              ] }, s.path);
            })
            ] }),
            // RIGHT: the file tree list, hide/show via the toolbar toggle.
            visible.files ? jsxs("aside", { className: "tree-side", children: [
              jsx("div", { className: "resizer", role: "separator", tabIndex: 0, title: "Drag to resize the file list; double-click to reset",
                "aria-label": "Resize file list", onPointerDown: onResizeStart, onPointerMove: onResizeMove, onPointerUp: onResizeEnd, onPointerCancel: onResizeEnd, onDoubleClick: onResizeReset }),
              jsxs("div", { className: "search", children: [
                jsx(SearchField, { containerClassName: "search-field", inputClassName: "search-input", value: filter, onChange: setFilter, placeholder: `Search ${sections.length} ${sections.length === 1 ? "file" : "files"} or their changes${hiddenByFilters ? ` (${hiddenByFilters} hidden)` : ""}`, "aria-label": "Search files" }),
                jsx("div", { className: cn("filter-wrap", (!showDeleted || !showTests) && "active"), children:
        jsxs(DropdownMenu, { children: [
          jsx(DropdownMenuTrigger, { asChild: true, children:
            jsx(Button, { variant: "ghost", size: "icon-sm", className: "filter-btn", title: "Show filters", "aria-label": "Show filters",
              children: jsx(Codicon, { name: "filter", size: "0.85rem" }) })
          }),
          jsxs(DropdownMenuContent, { className: "gr-menu", align: "end", children: [
            jsx(DropdownMenuItem, { onSelect: () => { setShowDeleted((v) => { persist({ showDeleted: !v }); return !v; }); }, children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [
              jsx(CheckSlot, { on: showDeleted, size: "0.8rem" }),
              "Deleted files"
            ] }) }),
            jsx(DropdownMenuItem, { onSelect: () => { setShowTests((v) => { persist({ showTests: !v }); return !v; }); }, children: jsxs("span", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" }, children: [
              jsx(CheckSlot, { on: showTests, size: "0.8rem" }),
              "Test files"
            ] }) })
          ] })
        ] })
      })
              ] }),
              jsx(Tree, { tree, filter, selected: active?.path, onSelect: scrollToSelection, stats, repoRoot: chosen })
            ] }) : null
          ] })
  ] });
}

// Full-context mode ("show all unchanged lines") and per-gap expanders.
// In-patch folds reveal their hidden rows progressively (↑20/↓20/all, GitHub
// style). Gap bars (above first hunk / between hunks / below last) have no
// local rows — they fetch through the bounded /file-lines backend route.
const EXPAND_STEP = 20;
// One request may cover a whole gap run; the backend clamps it to the file end
// and to its own per-request ceiling, and reports `done` when it reaches it.
const GAP_RUN_WINDOW = 5000;
// Pure gap math (exported as _gapInternals for regression tests): the next
// bounded window to fetch and the old/new line-number mapping for gap rows
// (delta = newStart - oldStart, so old = new - delta).
// The top gap grows upward from the first change (nearest lines first); every
// other gap grows downward from the change above it.
const nextGapWindow = (state, gap, step = EXPAND_STEP) => {
  if (gap.key === "top") {
    const end = state?.ls != null ? state.ls - 1 : gap.to;
    if (end < gap.from) return null;
    return { start: Math.max(gap.from, end - step + 1), end };
  }
  const start = state?.le != null ? state.le + 1 : gap.from;
  // The gap below the last hunk has no known end: it runs to the end of the file,
  // so it asks for one bounded window and the backend clamps it.
  if (gap.to == null) return { start, end: start + step - 1 };
  if (start > gap.to) return null;
  return { start, end: Math.min(gap.to, start + step - 1) };
};
// The backend sends exactly 3 lines of context (git -U3): a last hunk with fewer
// trailing lines than that means the file ended, so there is nothing below to reveal.
const PATCH_CONTEXT = 3;
const gapOldNumber = (n, delta) => n - (delta || 0);

const FoldBar = ({ row, path, rev, gap, compact, autoAll, onExpandAll, onFetch }) => {
  const [revealed, setRevealed] = useState({ up: 0, down: 0 });
  const [gapState, setGapState] = useState(null); // {ls, le, numbered, total, done, failed, loading}
  const hidden = row.rows || [];
  const isGap = !!gap;
  // In-patch partial reveal: the second side is capped by the unclaimed
  // remainder so up/down reveals can never overlap or double-render rows.
  const upCount = Math.min(revealed.up * EXPAND_STEP, hidden.length);
  const downCount = Math.min(revealed.down * EXPAND_STEP, hidden.length - upCount);
  const midHidden = hidden.length - upCount - downCount;
  // Gap remaining: against the gap's own bounds clamped by the file total the
  // backend reports — never against loaded counts or whole-file totals alone.
  // In-patch folds pass no gap: guard before touching gap.to.
  const gapLimit = isGap ? (gapState?.total != null ? Math.min(gap.to, gapState.total) : gap.to) : 0;
  const isTop = isGap && gap.key === "top";
  const remaining = isGap
    ? (gapState
        ? (isTop ? Math.max(0, gapState.ls - gap.from) : Math.max(0, gapLimit - gapState.le))
        : (gap.count ?? null))
    : midHidden;
  const stepCount = remaining == null ? EXPAND_STEP : Math.min(EXPAND_STEP, remaining);
  // GitHub-style: hide the bar once everything is revealed (or the gap is done).
  const barVisible = isGap ? !(gapState?.done) : midHidden > 0;

  const loadGap = async (mode) => {
    if (!onFetch || !isGap) return;
    // "all" fetches one bounded window: the backend caps /file-lines at
    // MAX_FILE_LINES (2000) lines per request, so no chunk loops are needed.
    // A gap bar's single control reveals its whole run: bounded by the next
    // change when the diff knows where that is, otherwise one window the backend
    // clamps at the file end (and at its own per-request ceiling).
    const w = nextGapWindow(gapState, gap, mode === "all" ? GAP_RUN_WINDOW : EXPAND_STEP);
    if (!w) { setGapState((p) => ({ ...(p || {}), done: true })); return; }
    setGapState((p) => ({ ...(p || { le: gap.from - 1, numbered: [] }), loading: true, failed: false }));
    try {
      const r = await onFetch(rev, w.start, w.end);
      setGapState((prev) => {
        const numbered = [...(prev?.numbered || []), ...r.lines.map((text, i) => ({ n: w.start + i, text }))]
          .sort((a, b) => a.n - b.n)
          .filter((l, i, arr) => i === 0 || l.n > arr[i - 1].n); // dedupe by line number
        const le = Math.max(prev?.le ?? gap.from - 1, r.end ?? w.end); // server-clamped end
        const total = r.total ?? prev?.total;
        const ls = numbered[0]?.n ?? gap.from;
        return {
          ls, le, numbered, total,
          loading: false, failed: false,
          done: isTop
            ? ls <= gap.from
            : (gap.to == null
              ? (total != null ? r.end >= total : r.lines.length < (w.end - w.start + 1))
              : (r.end >= Math.min(gap.to, total ?? r.end) || r.lines.length < (w.end - w.start + 1))),
        };
      });
    } catch { setGapState((p) => ({ ...(p || { le: gap.from - 1, numbered: [] }), loading: false, failed: true })); }
  };

  // "all" on any bar opens the whole file: every other gap of this file loads itself.
  useEffect(() => {
    if (isGap && autoAll && !gapState?.done && !gapState?.loading && !gapState?.failed) void loadGap("all");
  }, [isGap, autoAll, gapState?.done, gapState?.loading, gapState?.failed]);

  const expand = (mode) => {
    if (isGap) { if (mode === "all") onExpandAll?.(); void loadGap(mode); return; }
    if (mode === "all") { onExpandAll(); return; }
    setRevealed((r) => mode === "up" ? { ...r, up: r.up + 1 } : { ...r, down: r.down + 1 });
  };

  // Revealed in-patch rows: up-revealed at the top of the hidden block,
  // down-revealed at the bottom; the still-hidden count shows in the label.
  const upRows = hidden.slice(0, upCount);
  const downRows = downCount > 0 ? hidden.slice(hidden.length - downCount) : [];

  const barLabel = isGap
    ? (gapState?.failed ? "Load failed" : gapState ? `${gapState.numbered.length} loaded` : (gap.count == null ? "Show more lines below" : `${gap.count} unmodified lines`))
    : `${midHidden} unmodified lines`;
  // `icon` gives the button a square slot: a text glyph like ⌃ carries its own
  // line-box metrics and sits off-centre in a padded button.
  const btn = (label, mode, aria, disabled, icon) => jsx("button", { type: "button",
    className: icon ? "fold-inline fold-icon" : "fold-inline",
    "aria-label": aria, disabled, onClick: (e) => { e.stopPropagation(); expand(mode); }, children: label });
  const renderLine = (l, key) => renderContextRow({ before: gapOldNumber(l.n, gap.delta), after: l.n, text: l.text }, key);
  const loadedRows = isGap && gapState ? gapState.numbered.map((l) => renderLine(l, `${path}:${row.key}:gap${l.n}`)) : [];
  return jsxs(Fragment, { children: [
    upRows.map((r, i) => renderContextRow(r, `${path}:${row.key}:up${i}`)),
    ...(!isTop ? loadedRows : []),
    jsxs("span", { className: "fold", "data-fold-key": `${path}:${row.key}`, "data-gap": isGap ? "1" : undefined, children: [
      jsx("span", { className: "fold-strip", "aria-hidden": "true" }),
      barVisible ? jsxs("span", { className: "fold-inner", children: [
        jsx("span", { style: { fontVariantNumeric: "tabular-nums" }, children: barLabel }),
        // In-patch folds reveal their own hidden rows in both directions
        // (disabled in split layout — partial reveal breaks row pairing).
        // Gap bars fetch lines outside the patch, growing toward the file end.
        // Chevrons only: the bar already names the run, so a number on the button
        // said the same thing twice. The count stays in the tooltip and the label.
        !isGap && !compact ? btn(jsx(Codicon, { name: "chevron-up", size: "0.85rem" }), "up", `Expand ${Math.min(EXPAND_STEP, midHidden)} unchanged lines above for ${path}`, false, true) : null,
        !isGap && !compact ? btn(jsx(Codicon, { name: "chevron-down", size: "0.85rem" }), "down", `Expand ${Math.min(EXPAND_STEP, midHidden)} unchanged lines below for ${path}`, false, true) : null,
        isGap ? (gapState?.failed
          ? btn("Retry", "all", `Retry expanding lines (${gap.key}) for ${path}`, gapState?.loading)
          : gapState?.loading
            ? btn("…", "all", `Loading lines (${gap.key}) for ${path}`, true)
            : btn(jsx(Codicon, { name: isTop ? "chevron-up" : "chevron-down", size: "0.85rem" }), "all", remaining != null ? `Expand all ${remaining} unchanged lines (${gap.key}) for ${path}` : `Expand the remaining unchanged lines (${gap.key}) for ${path}`, false, true)) : null,
        // In-patch folds keep the progressive arrows (their rows are already
        // here); a gap bar reveals its whole run in one click.
        !isGap && remaining > 0 ? btn("all", "all", `Expand all ${remaining} remaining unchanged lines for ${path}`, gapState?.loading) : null,
      ] }) : null,
    ] }, `${path}:${row.key}`),
    ...(isTop ? loadedRows : []),
    downRows.map((r, i) => renderContextRow(r, `${path}:${row.key}:down${i}`)),
  ] }, `${path}:${row.key}:bar`);
};

// Context row used by fold bars (no click handlers needed on expanded filler).
const renderContextRow = (row, key) => jsxs("span", { className: "line context", "data-line": row.after ?? "", children: [
  jsx("span", { className: "lineno", "aria-hidden": "true", children: row.before ?? "" }),
  jsx("span", { className: "lineno", "aria-hidden": "true", children: row.after ?? "" }),
  jsx("span", { className: "linecode", children: row.text || " " }),
] }, key);

// ── split (side-by-side) rendering ───────────────────────────────────────────
// Pair complete change groups, padding the shorter side. Each pair shares one
// CSS grid row: wrapping on either side grows BOTH cells before the next pair.
function splitRows(rows) {
  const pairs = [], left = [], right = [];
  const add = (l, r) => { pairs.push({ left: l, right: r }); left.push(l); right.push(r); };
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.kind === "remove" || row.kind === "add") {
      const removed = [], added = [];
      while (i < rows.length && (rows[i].kind === "remove" || rows[i].kind === "add")) {
        (rows[i].kind === "remove" ? removed : added).push(rows[i++]);
      }
      for (let n = 0; n < Math.max(removed.length, added.length); n++) {
        add(removed[n] || { kind: "empty", text: " " }, added[n] || { kind: "empty", text: " " });
      }
    } else {
      if (row.kind === "context") add(row, row);
      else pairs.push({ shared: row });
      i++;
    }
  }
  return { pairs, left, right };
}

// Full-context mode ("show all unchanged lines"): inverse affordance at the top.
const FullBar = ({ path, label, onToggle }) =>
  jsxs("span", { className: "fold", children: [
    jsx("span", { className: "fold-strip", "aria-hidden": "true" }, "strip"),
    jsx("span", { className: "fold-inner", children:
      jsx("button", { type: "button", className: "fold-inline",
        "aria-label": `${label} for ${path}`, title: label,
        onClick: (event) => { event.stopPropagation(); onToggle(); },
        children: label })
    }, "inner"),
  ] });

// With word wrap OFF the diff scrolls horizontally (rows are min-width:max-content).
// The fold strip is styled in CSS (full scroller width, unlayered so it wins).

// Cite/drag only rows that exist in the CURRENT file (a new-side number).
// Removed lines have only an old-side number: citing them would point the
// agent at the wrong line of today's file, so they are not clickable.
function renderUnifiedRow(row, key, gutterFor, selectedLines, lineDragProps) {
  const line = row.after; // current-file number
  // Removed lines don't exist in the current file: citing or dragging them
  // would point the agent at the wrong line — no selection, no drag.
  const selectable = gutterFor && line != null && row.kind !== "remove";
  const highlighted = selectedLines?.has(line);
  // A draggable element starts a native drag on press, which swallows the hover the
  // range selection needs. Drag is therefore offered only once the line is selected;
  // press-drag extends a range, drag from a selected line still cites.
  const drag = selectable && highlighted && lineDragProps ? lineDragProps(row) : {};
  return jsxs("span", {
    className: cn(`line ${row.kind}`, highlighted && "line-selected"),
    "data-line": line,
    // Clicking the code still selects the line for citation (unchanged); a drag over
    // text selects text instead, and the gutter does the same editor-style job.
    onClick: selectable ? gutterFor(row)?.onClick : undefined,
    children: [
      jsx("span", {
        className: "gutter",
        ...(selectable ? gutterFor(row) || {} : {}),
        ...(selectable ? drag : {}),
        children: jsxs(Fragment, { children: [
          jsx("span", { className: "lineno", "aria-hidden": "true", children: row.before ?? "" }),
          jsx("span", { className: "lineno", "aria-hidden": "true", children: row.after ?? "" }),
        ] }),
      }),
      jsx("span", { className: "linecode", children: row.text || " " }),
    ],
  }, key);
}

function renderSplitRow(row, i, side, gutterFor, selectedLines, lineDragProps) {
  const line = side === "left" ? row.before : row.after;
  // Left (old-side) numbers don't exist in the current file: not selectable and not
  // draggable (lineDragProps rejects them via row.after).
  const selectable = gutterFor && line != null && side === "right";
  const highlighted = selectedLines?.has(line);
  const drag = selectable && lineDragProps ? lineDragProps(row) : {};
  return jsxs("span", {
    className: cn(`line ${row.kind}`, highlighted && "line-selected"),
    "data-side": side,
    "data-line": line,
    children: [
      jsx("span", {
        className: "gutter",
        ...(selectable ? gutterFor(row) || {} : {}),
        ...(selectable ? drag : {}),
        children: jsx("span", { className: "lineno", "aria-hidden": "true", children: line ?? "" }),
      }),
      jsx("span", { className: "linecode", children: row.text || " " }),
    ],
  }, `${side}:${i}`);
}

const plugin_default = {
  id: "git-review",
  name: "git-review",
  defaultEnabled: true,
  register(ctx) {
    ctx.register({ id: "pane", area: "panes", title: "Git review", data: { placement: "right", dock: { pane: "workspace", pos: "right" }, width: "720px" }, render: () => jsx(GitReview, { ctx }) });
    ctx.register({ id: "open", area: "palette", data: { id: "git-review.open", label: "Open git review", keywords: ["git", "diff", "worktree", "review"], run: () => host.revealPane("git-review:pane") } });
  }
};

// Where to scroll so a file's sticky header sits exactly at the top of the diff
// column. Measured from live rects rather than scrollIntoView: the target may be a
// section the browser skipped (content-visibility), and scroll margins left the
// header under the previous file's sticky header instead of at the top.
const scrollTopFor = ({ elementTop, scrollerTop, scrollTop, sticky = 0 }) =>
  Math.max(0, elementTop - scrollerTop + scrollTop - sticky);

export { CommitsSubmenu, GitReview, recordTurnBase, diffRows, collapseRows, settingsKeyFor, resolveIdentity, shouldFollowWorkspace, filesToOpen, scrollTopFor, plugin_default as default };
