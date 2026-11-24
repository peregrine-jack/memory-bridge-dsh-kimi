#!/usr/bin/env node
// memory-keeper-mcp.mjs — stdio MCP server exposing the DSH local memory library.
// v1.3.0: Tier A auto-write + any-base approve/reject. No network. Single file, no third-party deps.
// Tools: memory_search / memory_read / memory_propose / memory_write / memory_approve / memory_reject / memory_list_pending
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, statSync, readdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve, sep, relative, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DSH_HOME = process.env.DSH_HOME || (HOME ? join(HOME, '.dsh') : '');
if (!DSH_HOME) throw new Error('DSH_HOME not set and USERPROFILE/HOME unavailable');
const MEMORY_DIR = join(DSH_HOME, 'memory');
const SEARCH_SCRIPT = join(DSH_HOME, 'skills', 'memory-keeper', 'scripts', 'memory-search.mjs');
const LINT_SCRIPT = join(DSH_HOME, 'skills', 'memory-keeper', 'scripts', 'lint.mjs');
const PROPOSAL_DIR = join(MEMORY_DIR, '_proposals');
const STATE_DIR = join(DSH_HOME, 'kimi-bridge');
const LOG_FILE = join(STATE_DIR, 'mcp.log');
const LOCK_FILE = join(STATE_DIR, '.autowrite.lock');
const LOCK_STALE_MS = 60 * 1000;
const VERSION = '1.3.0';
const SERVER_NAME = 'dsh-memory';
const MAX_READ_BYTES = 64 * 1024;
const SOURCE_NAMES = ['memory', 'sessions', 'archive', 'kb', 'obsidian'];

// Same 4 sensitive patterns as lint.mjs — pre-write gate; hit => reject, never touch disk.
const SENSITIVE = [
  { label: 'API key (sk-)', re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{2,}/ },
  { label: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { label: 'wxid', re: /wxid_[A-Za-z0-9_-]{3,}/ },
  { label: 'Bearer token', re: /Bearer\s+[A-Za-z0-9._~+/-]+=*/i },
];
const META_RE = /\|\s*source:\s*([^|]+?)\s*\|\s*as_of:\s*([^|]+?)\s*\|\s*machine:\s*(new|old)\s*$/;
const ID_RE = /^[A-Za-z][A-Za-z0-9_]*-\d{3}$/;

function log(line) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, { flag: 'a' });
  } catch { /* logging must never break MCP */ }
}

function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '1**********')
    .replace(/wxid_[A-Za-z0-9_-]{3,}/g, 'wxid_***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***');
}

function ok(result) { return { content: [{ type: 'text', text: redact(typeof result === 'string' ? result : JSON.stringify(result, null, 2)) }] }; }
function fail(message) { return { isError: true, content: [{ type: 'text', text: redact(String(message)) }] }; }

function ensureMemory() {
  if (!existsSync(MEMORY_DIR)) throw new Error(`memory dir not found: ${MEMORY_DIR}`);
  return realpathSync(MEMORY_DIR);
}

function safeMemoryPath(p) {
  const memReal = ensureMemory();
  const target = resolve(memReal, String(p || ''));
  let real;
  try { real = realpathSync(target); } catch { throw new Error(`file not found: ${p}`); }
  const rel = relative(memReal, real);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) throw new Error('path outside memory dir is not allowed');
  if (!statSync(real).isFile()) throw new Error(`not a file: ${p}`);
  return { real, rel: rel.split(sep).join('/') };
}

const READONLY_ANNOTATION = { readOnlyHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: 'memory_search',
    description: 'Search the DSH local memory library (and optionally other local sources: dsh sessions, old chat archive, knowledge base, Obsidian notes). Returns JSON with hits. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query; spaces = AND, | = OR.' },
        sources: { type: 'array', items: { type: 'string', enum: SOURCE_NAMES }, description: 'Default ["memory"].' },
        limit: { type: 'number', description: 'Max hits, default 5.', minimum: 1, maximum: 50 },
        max_chars: { type: 'number', description: 'Optional. Cap on the serialized result hits; whole hits are dropped (never cut mid-hit).' },
      },
      required: ['query'],
    },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: 'memory_read',
    description: 'Read one file inside the DSH memory library by relative path (e.g. index.md, profile.md, projects/obsidian-v3.md). Paths outside the memory dir are rejected.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path inside ~/.dsh/memory.' } },
      required: ['path'],
    },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: 'memory_propose',
    description: 'Submit a memory-change PROPOSAL for user approval. Only appends to ~/.dsh/memory/_proposals/YYYY-MM.md; never writes or deletes memory files directly. Types: add | update | merge | archive | delete | question. For type=delete, targetId is required and must already exist in the target file; the entry is deleted only after the user approves it in DSH.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['add', 'update', 'merge', 'archive', 'delete', 'question'] },
        target: { type: 'string', description: 'Target memory file, e.g. profile.md / facts.md / projects/obsidian-v3.md / questions.md' },
        targetId: { type: 'string', description: 'Required for type=delete (and recommended for update/archive): existing entry id, e.g. f-029 / u-003 / p-021.' },
        content: { type: 'string', description: 'Fact(s) or proposed text. Required unless type=delete.' },
        reason: { type: 'string', description: 'Why this should be remembered.' },
        source: { type: 'string', description: 'Where it came from (file/session/URL).' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Optional.' },
      },
      required: ['type', 'target', 'reason', 'source'],
    },
  },
  {
    name: 'memory_write',
    description: 'Tier A 自动直写记忆库（无人工审批）。target 白名单: facts.md / projects/<name>.md / journal/YYYY-MM.md，其余 target 一律拒绝（请改用 memory_propose）。content 先过敏感预检（sk- / 手机号 / wxid_ / Bearer），命中直接拒绝且不落盘。fact 条目自动分配递增 id（f-NNN / p-NNN），journal 追加时间戳行。写入后跑 lint，FAIL 自动 git 回滚；PASS 自动 git 提交并记审计日志。响应可能带 warnings 字段提示相似既有条目（不拦截写入）。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'facts.md / projects/<name>.md / journal/YYYY-MM.md' },
        content: { type: 'string', description: '单行事实内容（自动压单行，限 4000 字符）。' },
        reason: { type: 'string', description: 'Why this should be remembered.' },
        source: { type: 'string', description: 'Where it came from (file/session/URL).' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Optional.' },
      },
      required: ['target', 'content', 'reason', 'source'],
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'memory_approve',
    description: '审批记忆提案（任意基座可用）。把 _proposals/YYYY-MM.md 待审批区的指定提案应用到记忆库：add/update/delete/question 自动应用（add 幂等，merge/archive 返回 needs_manual），写后统一 lint，FAIL 全部 git 回滚，PASS 后把条目移入「## 已处理」区、记 journal 和审计日志并 git 提交。纪律：只在用户当会话明确说「批准/同意」时才调用本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', enum: ['all'] }], description: '提案 id 列表（如 ["P-01"]）或 "all"。' },
        month: { type: 'string', description: '提案月份 YYYY-MM，默认当前月。' },
      },
      required: ['ids'],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'memory_reject',
    description: '拒绝记忆提案（任意基座可用）。把 _proposals/YYYY-MM.md 待审批区的指定提案标记为已拒绝（不落任何记忆内容），移入「## 已处理」区、记 journal 和审计日志并 git 提交。纪律：只在用户当会话明确说「拒绝/不要」时才调用本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', enum: ['all'] }], description: '提案 id 列表（如 ["P-07"]）或 "all"。' },
        reason: { type: 'string', description: '拒绝原因（可选，写入处理标记）。' },
        month: { type: 'string', description: '提案月份 YYYY-MM，默认当前月。' },
      },
      required: ['ids'],
    },
    annotations: { destructiveHint: false },
  },
  {
    name: 'memory_list_pending',
    description: 'List pending memory proposals for the current month from ~/.dsh/memory/_proposals/. Read-only.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READONLY_ANNOTATION,
  },
];

function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function localDate(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function localStamp(d = new Date()) { return `${localDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

function nextProposalId(file) {
  let max = 0;
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^- \[P-(\d+)\]/gm)) max = Math.max(max, Number(m[1]));
  }
  return `P-${String(max + 1).padStart(2, '0')}`;
}

function findSensitive(text) {
  for (const s of SENSITIVE) if (s.re.test(String(text || ''))) return s.label;
  return null;
}

function ensureTrailingNewline(text) { return text.endsWith('\n') ? text : text + '\n'; }

// --- write lock (.autowrite.lock); stale (>60s) locks are removed and retried once.
function withAutoWriteLock(fn) {
  mkdirSync(STATE_DIR, { recursive: true });
  let fd;
  try {
    fd = openSync(LOCK_FILE, 'wx');
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e;
    let stale = true;
    try { stale = Date.now() - statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS; } catch { stale = true; }
    if (!stale) throw new Error('autowrite lock is held by another process; retry later');
    try { unlinkSync(LOCK_FILE); } catch { throw new Error('autowrite lock is stale but cannot be removed'); }
    fd = openSync(LOCK_FILE, 'wx'); // single retry
  }
  try { return fn(); } finally { try { closeSync(fd); unlinkSync(LOCK_FILE); } catch { /* best effort */ } }
}

// Run lint against the memory dir; returns the tail of lint output on FAIL, null on PASS.
function runLint() {
  if (!existsSync(LINT_SCRIPT)) throw new Error(`lint script missing: ${LINT_SCRIPT}`);
  try {
    execFileSync(process.execPath, [LINT_SCRIPT], { cwd: MEMORY_DIR, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return null;
  } catch (e) {
    const out = String((e && e.stdout) || '') + String((e && e.stderr) || '') || String((e && e.message) || e);
    return out.split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
  }
}

function gitCommit(message) {
  try {
    execFileSync('git', ['add', '-A'], { cwd: MEMORY_DIR, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    execFileSync('git', ['commit', '-m', message], { cwd: MEMORY_DIR, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    return true;
  } catch { return false; }
}

function gitRollback() {
  try { execFileSync('git', ['checkout', '--', '.'], { cwd: MEMORY_DIR, windowsHide: true, stdio: 'ignore', timeout: 60000 }); return true; } catch { return false; }
}

function auditLog(op, id, target, result, note) {
  try {
    mkdirSync(PROPOSAL_DIR, { recursive: true });
    const month = monthKey();
    const file = join(PROPOSAL_DIR, `auto-log-${month}.md`);
    if (!existsSync(file)) writeFileSync(file, `# 自动写入审计 ${month}\n\n`);
    const line = `- [AUTO] ${new Date().toISOString()} | op: ${op} | id: ${id} | target: ${target} | by: mcp | result: ${result} | note: ${String(note || '').replace(/\s+/g, ' ').slice(0, 120)}\n`;
    writeFileSync(file, line, { flag: 'a' });
  } catch (e) { log(`audit log failed: ${e && e.message}`); }
}

// id allocation: scan every .md in the memory dir (skip _proposals / .cache / .git) for <prefix>-NNN.
function walkMarkdown(dir, out, depth = 0) {
  if (depth > 16) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === '.cache' || e.name === '_cache' || e.name === '_proposals') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(p, out, depth + 1);
    else if (/\.md$/i.test(e.name)) out.push(p);
  }
}

function nextFactId(prefix) {
  const files = [];
  walkMarkdown(MEMORY_DIR, files);
  let max = 0;
  const re = new RegExp(`^- \\[${prefix}-(\\d{3})\\]`, 'gm');
  for (const f of files) {
    try {
      for (const m of readFileSync(f, 'utf8').matchAll(re)) max = Math.max(max, Number(m[1]));
    } catch { /* unreadable file: skip */ }
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

function prefixFor(target) {
  if (target === 'facts.md') return 'f';
  if (target.startsWith('projects/')) return 'p';
  return 'q';
}

function findFactLineIndex(lines, id) {
  const re = new RegExp(`^\\s*-\\s*\\[${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`);
  return lines.findIndex((l) => re.test(l));
}

function fileHasId(file, id) {
  if (!existsSync(file)) return false;
  return findFactLineIndex(readFileSync(file, 'utf8').split(/\r?\n/), id) >= 0;
}

// Whole-library fact id lookup (skips _proposals / .cache / .git via walkMarkdown).
function libraryHasId(id) {
  const files = [];
  walkMarkdown(MEMORY_DIR, files);
  const re = new RegExp(`^- \\[${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm');
  for (const f of files) {
    try { if (re.test(readFileSync(f, 'utf8'))) return true; } catch { /* skip */ }
  }
  return false;
}

function appendLine(file, line) {
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, ensureTrailingNewline(text) + line + '\n');
}

// Build a canonical fact line from proposal/write content. Existing id and trailing
// metadata are kept; missing id is allocated, missing metadata filled from proposal fields.
function normalizeFactLine(content, target, proposal, forceId) {
  const collapsed = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  const idM = collapsed.match(/\[([A-Za-z][A-Za-z0-9_]*-\d{3})\]/);
  let id = forceId || (idM ? idM[1] : null);
  let body = collapsed.replace(/^\s*-\s*/, '');
  if (idM && body.startsWith(`[${idM[1]}]`)) body = body.slice(idM[1].length + 2).trim();
  if (!META_RE.test(body)) {
    if (!id) id = nextFactId(prefixFor(target));
    const source = String((proposal && proposal.source) || 'mcp').slice(0, 500);
    body = `${body} | source: ${source} | as_of: ${localDate()} | machine: new`;
  }
  if (!id) id = nextFactId(prefixFor(target));
  return { id, line: `- [${id}] ${body}` };
}

function journalRecord(text) {
  const dir = join(MEMORY_DIR, 'journal');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${monthKey()}.md`);
  if (!existsSync(file)) writeFileSync(file, `# journal/${monthKey()}.md — 记忆日志\n\n`);
  const cur = readFileSync(file, 'utf8');
  writeFileSync(file, ensureTrailingNewline(cur) + `- **${localStamp()}** ${text}\n`);
}

function doSearch(args) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('query is required');
  const sources = Array.isArray(args.sources) && args.sources.length ? args.sources.filter((s) => SOURCE_NAMES.includes(s)) : ['memory'];
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 5));
  if (!existsSync(SEARCH_SCRIPT)) throw new Error(`search script missing: ${SEARCH_SCRIPT}`);
  const cmdArgs = [SEARCH_SCRIPT, query, '--json', '--limit', String(limit), '--source', sources.join(',')];
  const started = Date.now();
  const out = execFileSync(process.execPath, cmdArgs, { encoding: 'utf8', timeout: 90000, windowsHide: true });
  let parsed;
  try { parsed = JSON.parse(out); } catch { parsed = { raw: out, results: [] }; }
  // max_chars: drop whole hits (never cut mid-hit) in MCP layer; subscript untouched.
  let dropped = 0;
  const maxChars = Number(args.max_chars);
  if (Number.isFinite(maxChars) && maxChars > 0 && Array.isArray(parsed.results)) {
    const kept = [];
    let used = 0;
    for (const hit of parsed.results) {
      const len = JSON.stringify(hit).length;
      if (kept.length && used + len > maxChars) break;
      kept.push(hit);
      used += len;
    }
    dropped = parsed.results.length - kept.length;
    parsed.results = kept;
  }
  return { query, sources, limit, elapsedMs: Date.now() - started, truncated: { dropped }, result: parsed };
}

function doRead(args) {
  const { real, rel } = safeMemoryPath(args.path);
  let text = readFileSync(real, 'utf8');
  let truncated = false;
  if (Buffer.byteLength(text, 'utf8') > MAX_READ_BYTES) { text = text.slice(0, MAX_READ_BYTES); truncated = true; }
  return { path: rel, bytes: Buffer.byteLength(text, 'utf8'), truncated, content: text };
}

function findEntry(file, id) {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const re = new RegExp(`^- \\[${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^\\r\\n]*`, 'm');
  const m = text.match(re);
  return m ? m[0] : null;
}

function doPropose(args) {
  const type = String(args.type || '');
  if (!['add', 'update', 'merge', 'archive', 'delete', 'question'].includes(type)) throw new Error('invalid type');
  const target = String(args.target || '').replace(/\\/g, '/').trim();
  if (!target || target.startsWith('/') || target.includes('..') || /^[a-zA-Z]:/.test(target)) throw new Error('target must be a relative memory path');
  const allowed = target === 'questions.md' || ['profile.md', 'rules.md', 'facts.md'].includes(target) || /^(projects|history)\/[^/]+\.md$/.test(target);
  if (!allowed) throw new Error('target is not a writable memory file');
  ensureMemory();
  mkdirSync(PROPOSAL_DIR, { recursive: true });
  const file = join(PROPOSAL_DIR, `${monthKey()}.md`);
  const id = nextProposalId(file);
  const stamp = new Date().toISOString();
  let entry;
  if (type === 'delete') {
    const targetId = String(args.targetId || '').trim();
    if (!/^[a-z]{1,2}-\d+$/i.test(targetId)) throw new Error('type=delete requires targetId like f-029 / u-003 / p-021');
    if (!existsSync(join(MEMORY_DIR, target))) throw new Error(`target not found: ${target}`);
    const current = findEntry(join(MEMORY_DIR, target), targetId);
    if (!current) throw new Error(`entry ${targetId} not found in ${target}`);
    const excerpt = current.replace(/\s+/g, ' ').slice(0, 300);
    entry = [
      '',
      `- [${id}] delete | target: \`${target}\` | 原 id: \`${targetId}\` | 现内容: ${excerpt} | reason: ${String(args.reason).slice(0, 2000)} | source: ${String(args.source).slice(0, 500)} | as_of: ${stamp.slice(0, 10)} | confidence: ${String(args.confidence || 'medium')} | from: mcp`,
      '',
    ].join('\n');
  } else {
    const content = String(args.content || '').trim();
    if (!content) throw new Error('content is required for this type');
    entry = [
      '',
      `- [${id}] ${type} | target: \`${target}\` | content: ${content.replace(/\s+/g, ' ').slice(0, 4000)} | reason: ${String(args.reason).slice(0, 2000)} | source: ${String(args.source).slice(0, 500)} | as_of: ${stamp.slice(0, 10)} | confidence: ${String(args.confidence || 'medium')} | from: mcp`,
      '',
    ].join('\n');
  }
  let header = '';
  if (!existsSync(file)) {
    header = `# 记忆提案 ${monthKey()}\n\n> 由 MCP 客户端（Kimi Code / Kimi Work / 其他 agent）提交；需 DSH 侧用户审批后写回。\n\n## 待审批\n`;
    writeFileSync(file, header + entry);
    return { proposalId: id, file: relative(MEMORY_DIR, file).split(sep).join('/'), status: 'pending_user_approval' };
  }
  const text = readFileSync(file, 'utf8');
  const doneHeading = text.match(/^##\s*已处理.*$/m);
  if (doneHeading) {
    // keep new proposals in the pending section: insert before the 已处理 heading
    const before = text.slice(0, doneHeading.index).replace(/\s+$/, '');
    writeFileSync(file, `${before}\n\n${entry.trim()}\n\n${text.slice(doneHeading.index)}`);
  } else {
    writeFileSync(file, entry, { flag: 'a' });
  }
  return { proposalId: id, file: relative(MEMORY_DIR, file).split(sep).join('/'), status: 'pending_user_approval' };
}

function doListPending() {
  ensureMemory();
  const file = join(PROPOSAL_DIR, `${monthKey()}.md`);
  if (!existsSync(file)) return { month: monthKey(), count: 0, content: '' };
  const text = readFileSync(file, 'utf8');
  const count = [...text.matchAll(/^- \[P-\d+\]/gm)].length;
  return { month: monthKey(), count, content: text.slice(0, 32000) };
}

// memory_write content normalization: callers may pass a fully formatted fact line
// ("[p-029] … | source: … | as_of: … | machine: new"); strip the leading entry marker
// once and the full metadata tail up to twice (double-wrap defense) so the entry is
// rebuilt solely from request params (source param, server date, machine: new).
function stripWrappedFact(content) {
  let body = String(content || '');
  body = body.replace(/^\s*\[\s*[A-Za-z]{1,2}-\d{3}\s*\]\s*/, '');
  body = body.replace(/\s*\|\s*source:\s*[^|]+\|\s*as_of:\s*\d{4}-\d{2}-\d{2}\s*\|\s*machine:\s*(new|old)\s*$/, '');
  body = body.replace(/\s*\|\s*source:\s*[^|]+\|\s*as_of:\s*\d{4}-\d{2}-\d{2}\s*\|\s*machine:\s*(new|old)\s*$/, '');
  return body.trim();
}

// Similar-entry warning (mcp-memory-server style): char 2-gram containment
// |S∩E|/|S| of normalized new content against each existing fact body in the target
// file; >= 0.5 warns, never blocks. Chinese-friendly, no segmentation, in-process.
function bigrams(text) {
  const clean = String(text || '').replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}

function factBodyFromLine(line) {
  let body = String(line || '').replace(/^\s*-\s*\[\s*[A-Za-z]{1,2}-\d{3}\s*\]\s*/, '');
  body = body.replace(/\s*\|\s*source:\s*[^|]+\|\s*as_of:\s*[^|]+\|\s*machine:\s*(new|old)\s*$/, '');
  return body.trim();
}

function similarFactWarnings(content, targetFile, limit = 3) {
  const s = bigrams(content);
  if (!s.size || !existsSync(targetFile)) return [];
  const scored = [];
  for (const line of readFileSync(targetFile, 'utf8').split(/\r?\n/)) {
    const idM = line.match(/^\s*-\s*\[([A-Za-z][A-Za-z0-9_]*-\d{3})\]/);
    if (!idM) continue;
    const body = factBodyFromLine(line);
    const e = bigrams(body);
    if (!e.size) continue;
    let inter = 0;
    for (const g of s) if (e.has(g)) inter++;
    const containment = inter / s.size;
    if (containment >= 0.5) scored.push({ containment, text: `可能相似: [${idM[1]}] ${body.slice(0, 60)}` });
  }
  scored.sort((a, b) => b.containment - a.containment);
  return scored.slice(0, limit).map((x) => x.text);
}

function doWrite(args) {
  const target = String(args.target || '').replace(/\\/g, '/').trim();
  let content = String(args.content || '').trim();
  const source = String(args.source || '').trim();
  const reason = String(args.reason || '').trim();
  if (!content) throw new Error('content is required');
  if (!source) throw new Error('source is required');
  if (!reason) throw new Error('reason is required');
  content = stripWrappedFact(content);
  if (!content) return { status: 'rejected', reason: 'content 在剥离条目标记与元数据尾后为空，无可写入的事实内容' };
  let kind = null;
  if (target === 'facts.md') kind = 'fact';
  else if (/^projects\/[^/]+\.md$/.test(target) && !target.slice(9).includes('..')) kind = 'fact';
  else if (/^journal\/\d{4}-\d{2}\.md$/.test(target)) kind = 'journal';
  if (!kind) return { status: 'rejected', reason: `target 不在 memory_write 白名单: ${target}（请改用 memory_propose 提交提案）` };
  const sensitive = findSensitive(content) || findSensitive(source);
  if (sensitive) return { status: 'rejected', reason: `content 命中敏感预检（${sensitive}），已拒绝且未落盘` };
  if (kind === 'fact' && /(^|[^A-Za-z0-9])E:\\/i.test(content)) return { status: 'rejected', reason: '非 history 目标不允许包含旧机路径 E:\\' };
  ensureMemory();
  return withAutoWriteLock(() => {
    const file = join(MEMORY_DIR, ...target.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    let id = null;
    let line;
    let warnings = [];
    if (kind === 'journal') {
      if (!existsSync(file)) writeFileSync(file, `# ${target} — 记忆日志\n\n`);
      line = `- **${localStamp()}** ${content.replace(/\s+/g, ' ').slice(0, 4000)}（source: ${source.slice(0, 500)}）`;
      appendLine(file, line);
    } else {
      id = nextFactId(prefixFor(target));
      const body = content.replace(/\s+/g, ' ').slice(0, 4000);
      line = `- [${id}] ${body} | source: ${source.slice(0, 500)} | as_of: ${localDate()} | machine: new`;
      warnings = similarFactWarnings(body, file); // before append: the new line must not self-match
      appendLine(file, line);
    }
    const lintTail = runLint();
    if (lintTail) {
      gitRollback();
      auditLog('write', id || 'journal', target, 'rolled-back', `lint FAIL: ${lintTail}`);
      throw new Error(`lint FAIL after memory_write to ${target}; rolled back via git.\nlint tail:\n${lintTail}`);
    }
    auditLog('write', id || 'journal', target, 'written', content);
    const committed = gitCommit(`memory_write: ${id || 'journal'} -> ${target}`);
    return { status: 'written', id, target, ...(warnings.length ? { warnings } : {}), ...(committed ? {} : { git: 'failed' }) };
  });
}

// --- proposal parsing for approve/reject.
// Pending section = everything before the first "## 已处理" heading; entries there only.
function parseProposalFile(month) {
  const file = join(PROPOSAL_DIR, `${month}.md`);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const splitAt = text.search(/^##\s*已处理/m);
  const pendingText = splitAt < 0 ? text : text.slice(0, splitAt);
  const entries = [];
  for (const line of pendingText.split(/\r?\n/)) {
    const m = line.match(/^- \[(P-\d+)\]\s+([A-Za-z]+)\s*(.*)$/);
    if (!m) continue;
    const [, id, type, rest] = m;
    const tickField = (name) => {
      const tm = rest.match(new RegExp(`\\|\\s*${name}:\\s*\`([^\`]+)\``));
      return tm ? tm[1] : '';
    };
    const plainField = (name) => {
      const fm = rest.match(new RegExp(`\\|\\s*${name}:\\s*([^|]*)`));
      return fm ? fm[1].trim() : '';
    };
    const contentM = rest.match(/\|\s*content:\s*(.*?)\s*\|\s*reason:/);
    entries.push({
      id,
      type: type.toLowerCase(),
      target: tickField('target'),
      targetId: tickField('原 id'),
      content: contentM ? contentM[1].trim() : '',
      reason: plainField('reason'),
      source: plainField('source'),
      line,
    });
  }
  return { file, text, entries };
}

function applyQuestion(entry) {
  const file = join(MEMORY_DIR, 'questions.md');
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '# questions\n';
  const hasFactFormat = /^\s*-\s*\[[A-Za-z][A-Za-z0-9_]*-\d{3}\]/m.test(text);
  if (hasFactFormat) {
    appendLine(file, normalizeFactLine(entry.content, 'questions.md', entry).line);
  } else {
    appendLine(file, `- **${localDate()}** ${String(entry.content || '').replace(/\s+/g, ' ').trim().slice(0, 4000)}（source: ${entry.source || 'mcp'}）`);
  }
}

// Returns { result, detail? }: applied | already_applied | needs_manual | rejected_sensitive
function applyProposal(entry) {
  const type = entry.type;
  const target = entry.target;
  if (type === 'merge' || type === 'archive') return { result: 'needs_manual', detail: `type=${type} 第一版不自动应用，请在 DSH 中手动处理` };
  if (!target || target.includes('..')) return { result: 'needs_manual', detail: '提案缺少合法 target，无法解析' };
  const targetFile = join(MEMORY_DIR, ...target.split('/'));
  if (!existsSync(targetFile)) return { result: 'needs_manual', detail: `target 文件不存在: ${target}` };
  if ((type === 'add' || type === 'update' || type === 'question') && findSensitive(entry.content)) {
    return { result: 'rejected_sensitive', detail: `content 命中敏感预检（${findSensitive(entry.content)}），未落盘` };
  }
  if (type === 'add') {
    let norm = normalizeFactLine(entry.content, target, entry);
    if (norm.id && fileHasId(targetFile, norm.id)) return { result: 'already_applied', detail: `${norm.id} 已存在于 ${target}，跳过（幂等）` };
    let conflictNote = null;
    if (norm.id && libraryHasId(norm.id)) {
      // embedded id collides with an entry elsewhere in the library: reassign
      // instead of letting lint fail the whole batch with a duplicate-id rollback.
      const oldId = norm.id;
      const prefix = (oldId.match(/^[A-Za-z]{1,2}/) || ['x'])[0];
      const stripped = String(entry.content || '')
        .replace(/^\s*-\s*\[\s*[A-Za-z]{1,2}-\d{3}\s*\]\s*/, '')
        .replace(/^\s*\[\s*[A-Za-z]{1,2}-\d{3}\s*\]\s*/, '');
      norm = normalizeFactLine(stripped, target, entry, nextFactId(prefix));
      conflictNote = `原提案 id ${oldId} 与现有条目冲突，已改分配 ${norm.id}`;
    }
    const warnings = similarFactWarnings(factBodyFromLine(norm.line), targetFile); // before append: no self-match
    appendLine(targetFile, norm.line);
    return { result: 'applied', detail: `${norm.id} 已追加到 ${target}${conflictNote ? `；${conflictNote}` : ''}`, ...(warnings.length ? { warnings } : {}) };
  }
  if (type === 'update') {
    const idM = String(entry.content || '').match(/\[([A-Za-z][A-Za-z0-9_]*-\d{3})\]/);
    const id = idM ? idM[1] : entry.targetId;
    if (!id || !ID_RE.test(id)) return { result: 'needs_manual', detail: 'update 缺少可用 id（content 或「原 id」中均没有 [x-000]）' };
    const lines = readFileSync(targetFile, 'utf8').split(/\r?\n/);
    const idx = findFactLineIndex(lines, id);
    if (idx < 0) return { result: 'needs_manual', detail: `${id} 在 ${target} 中未找到` };
    lines[idx] = normalizeFactLine(entry.content, target, entry, id).line;
    writeFileSync(targetFile, lines.join('\n'));
    return { result: 'applied', detail: `${id} 已在 ${target} 更新` };
  }
  if (type === 'delete') {
    const id = entry.targetId;
    if (!id || !ID_RE.test(id)) return { result: 'needs_manual', detail: 'delete 缺少合法「原 id」' };
    const lines = readFileSync(targetFile, 'utf8').split(/\r?\n/);
    const idx = findFactLineIndex(lines, id);
    if (idx < 0) return { result: 'needs_manual', detail: `${id} 在 ${target} 中未找到` };
    lines.splice(idx, 1);
    writeFileSync(targetFile, lines.join('\n'));
    return { result: 'applied', detail: `${id} 已从 ${target} 删除` };
  }
  if (type === 'question') {
    applyQuestion(entry);
    return { result: 'applied', detail: `question 已追加到 questions.md` };
  }
  return { result: 'needs_manual', detail: `未知 type: ${type}` };
}

function finalizeProposals(text, moved) {
  const lines = text.split(/\r?\n/);
  for (const m of moved) {
    const idx = lines.indexOf(m.line);
    if (idx >= 0) lines.splice(idx, 1);
  }
  const movedLines = moved.map((m) => `${m.line} ${m.mark}`);
  if (lines.some((l) => /^##\s*已处理/.test(l))) {
    lines.push(...movedLines);
  } else {
    lines.push('', '## 已处理', '', ...movedLines);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function doProcessProposals(args, action) {
  ensureMemory();
  const month = /^\d{4}-\d{2}$/.test(String(args.month || '')) ? args.month : monthKey();
  const parsed = parseProposalFile(month);
  if (!parsed) return { month, action, results: [], detail: `no proposal file for ${month}` };
  let ids = args.ids;
  if (ids === 'all') ids = parsed.entries.map((e) => e.id);
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(String).filter(Boolean);
  return withAutoWriteLock(() => {
    const results = [];
    const moved = [];
    let wroteMemory = false;
    for (const id of ids) {
      const entry = parsed.entries.find((e) => e.id === id);
      if (!entry) { results.push({ id, result: 'needs_manual', detail: '提案不在待审批区（不存在或已处理）' }); continue; }
      let outcome;
      if (action === 'reject') {
        outcome = { result: 'rejected', detail: String(args.reason || entry.reason || 'no reason').replace(/\s+/g, ' ').slice(0, 200) };
      } else {
        outcome = applyProposal(entry);
      }
      results.push({ id, result: outcome.result, ...(outcome.detail ? { detail: outcome.detail } : {}), ...(outcome.warnings ? { warnings: outcome.warnings } : {}) });
      if (['applied', 'already_applied', 'rejected', 'rejected_sensitive'].includes(outcome.result)) {
        if (outcome.result === 'applied') wroteMemory = true;
        const mark = outcome.result === 'applied' || outcome.result === 'already_applied'
          ? `✅ applied: ${localDate()}`
          : `❌ rejected: ${localDate()} ${outcome.detail || ''}`.trim();
        moved.push({ line: entry.line, mark });
        auditLog(action, id, entry.target || '', outcome.result, outcome.detail || entry.content);
      }
    }
    if (wroteMemory) {
      const lintTail = runLint();
      if (lintTail) {
        gitRollback();
        for (const m of moved) {
          const idM = m.line.match(/^- \[(P-\d+)\]/);
          auditLog(action, idM ? idM[1] : '?', '', 'rolled-back', 'lint FAIL, rolled back via git');
        }
        throw new Error(`lint FAIL after ${action}; all changes rolled back via git.\nresults: ${JSON.stringify(results)}\nlint tail:\n${lintTail}`);
      }
    }
    if (moved.length) {
      writeFileSync(parsed.file, finalizeProposals(parsed.text, moved));
      const movedIds = moved.map((m) => (m.line.match(/^- \[(P-\d+)\]/) || [])[1]).filter(Boolean);
      journalRecord(`${action === 'approve' ? '批准' : '拒绝'}提案: ${movedIds.join(',')}（source: mcp）`);
      gitCommit(`${action}: ${movedIds.join(',')}`);
    }
    return { month, action, results };
  });
}

function callTool(name, args) {
  try {
    switch (name) {
      case 'memory_search': return ok(doSearch(args || {}));
      case 'memory_read': return ok(doRead(args || {}));
      case 'memory_propose': return ok(doPropose(args || {}));
      case 'memory_write': return ok(doWrite(args || {}));
      case 'memory_approve': return ok(doProcessProposals(args || {}, 'approve'));
      case 'memory_reject': return ok(doProcessProposals(args || {}, 'reject'));
      case 'memory_list_pending': return ok(doListPending());
      default: return fail(`unknown tool: ${name}`);
    }
  } catch (e) {
    log(`tool ${name} failed: ${e && e.message}`);
    return fail(e && e.message ? e.message : String(e));
  }
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handleRequest(msg) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) {
    // notification: initialized / cancelled / others — no response
    return;
  }
  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      const version = requested || '2024-11-05';
      reply(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
      });
      return;
    }
    case 'ping': reply(id, {}); return;
    case 'tools/list': reply(id, { tools: TOOLS }); return;
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      reply(id, callTool(name, args));
      return;
    }
    case 'resources/list': reply(id, { resources: [] }); return;
    case 'prompts/list': reply(id, { prompts: [] }); return;
    default: replyError(id, -32601, `method not found: ${method}`); return;
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  try { handleRequest(msg); } catch (e) { log(`handler failed: ${e && e.message}`); }
});
rl.on('close', () => process.exit(0));
log(`server started (pid=${process.pid}, memory=${MEMORY_DIR})`);
