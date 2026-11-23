// mend: a patch tool that applies AI-written edits in four formats to a tree of text files.
// Written for Node 22 with the standard library only, following SPEC.md section by section:
// the command line and its usage errors, the exact output lines and exit codes, safe paths,
// format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edit objects, and all-or-nothing application in patch order.
// When MAKEFUN_ENV_URL is set this file hands the trial over to runner.ts, as the kit asks.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const KNOWN_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class ParseFault {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const stripTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripLeadWs = (s: string): string => s.replace(/^[ \t]+/, '');
const trimWs = (s: string): string => stripLeadWs(stripTrailWs(s));
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function pathIsSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// ---------- file text as lines ----------

interface FileLines {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function readLines(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { br, lines, finalBreak };
}

function writeLines(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

// ---------- the tree ----------

class Tree {
  private cache = new Map<string, string | null>();
  readonly changed = new Map<string, string | null>();
  moves: Array<[string, string]> = [];
  before(p: string): string | null {
    if (!this.cache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.cache.set(p, v);
    }
    return this.cache.get(p)!;
  }
  now(p: string): string | null {
    return this.changed.has(p) ? this.changed.get(p)! : this.before(p);
  }
  put(p: string, v: string | null): void {
    this.changed.set(p, v);
  }
}

type EditFn = (tree: Tree) => void;

// ---------- three-tier matching (section 5) ----------

function lineMatchesAt(fileLine: string, patchLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === patchLine;
  if (tier === 1) return stripTrailWs(fileLine) === stripTrailWs(patchLine);
  return trimWs(fileLine) === trimWs(patchLine);
}

function occurrencesAt(fileLines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = Math.max(0, from); i + old.length <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < old.length; k++) {
      if (!lineMatchesAt(fileLines[i + k]!, old[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  positions: number[];
}

function firstTier(fileLines: string[], old: string[], strict: boolean, from: number): TierHit | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier++) {
    const positions = occurrencesAt(fileLines, old, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function singleLineTier(fileLines: string[], anchor: string, strict: boolean, from: number): TierHit | null {
  return firstTier(fileLines, [anchor], strict, from);
}

// A replacement entry: a context line (copies the file's own line at oIdx) or a fresh line.
type NEntry = { kind: 'ctx'; oIdx: number } | { kind: 'new'; text: string };

function buildReplacement(fileLines: string[], pos: number, old: string[], entries: NEntry[], tier: number): string[] {
  const out: string[] = [];
  const fLead = fileLines.length > 0 && pos < fileLines.length ? leadWs(fileLines[pos]!) : '';
  const pLead = old.length > 0 ? leadWs(old[0]!) : '';
  for (const e of entries) {
    if (e.kind === 'ctx') {
      out.push(fileLines[pos + e.oIdx]!);
    } else if (tier === 2) {
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(pLead)) out.push(fLead + t.slice(pLead.length));
      else out.push(t);
    } else {
      out.push(e.text);
    }
  }
  return out;
}

function spliceMatch(f: FileLines, pos: number, oldLen: number, replacement: string[]): void {
  f.lines.splice(pos, oldLen, ...replacement);
}

// ---------- format detection (section 4) ----------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const ch = lines[first]!.trimStart()[0];
  if (ch === '[' || ch === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('diff --git ')) return 'unified';
    if (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------- JSON edits (section 9) ----------

function oneJsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const needFile = (tree: Tree): string => {
    if (!pathIsSafe(p)) throw new EditFault('unsafe', p);
    const t = tree.now(p);
    if (t === null) throw new EditFault('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!pathIsSafe(p)) throw new EditFault('unsafe', p);
      if (tree.now(p) !== null) throw new EditFault('exists', p);
      tree.put(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = typeof o.new_str === 'string' ? o.new_str : '';
    return (tree) => {
      const before = needFile(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const t = toLf(before);
      const needle = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(needle); k >= 0; k = t.indexOf(needle, k + 1)) count++;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = t.indexOf(needle);
      const merged = t.slice(0, at) + toLf(newStr) + t.slice(at + needle.length);
      tree.put(p, crlf ? merged.split('\n').join('\r\n') : merged);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const at = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = needFile(tree);
      const f = readLines(before);
      if (at < 0 || at > f.lines.length) throw new EditFault('no-match', p);
      f.lines.splice(at, 0, ...add);
      tree.put(p, writeLines(f));
    };
  }
  return null;
}

function parseJsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseFault(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new ParseFault(`error: parse ${first + 1}`);
    for (const item of parsed) {
      const e = oneJsonEdit(item);
      if (e === null) throw new ParseFault(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i]!)) continue;
    let e: EditFn | null = null;
    try {
      e = oneJsonEdit(JSON.parse(lines[i]!));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(`error: parse ${i + 1}`);
    edits.push(e);
  }
  return edits;
}

// ---------- unified diffs (section 6) ----------

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'slash';
  text: string;
  rawEmpty: boolean;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  hasPair: boolean;
  modeCreate: boolean;
  modeDelete: boolean;
  inHeader: boolean;
  hunks: Hunk[];
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
function headerPath(raw: string): string {
  const tab = raw.indexOf('\t');
  const cut = tab >= 0 ? raw.slice(0, tab) : raw;
  return stripPrefix(cut.trim());
}

function hunkOldLines(h: Hunk): string[] {
  const out: string[] = [];
  for (const b of h.body) if (b.kind === 'ctx' || b.kind === 'old') out.push(b.text);
  return out;
}
function hunkNewEntries(h: Hunk): NEntry[] {
  const out: NEntry[] = [];
  let oIdx = 0;
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      out.push({ kind: 'ctx', oIdx });
      oIdx++;
    } else if (b.kind === 'old') {
      oIdx++;
    } else if (b.kind === 'new') {
      out.push({ kind: 'new', text: b.text });
    }
  }
  return out;
}
function markerAfterLastWritten(h: Hunk): boolean {
  let last = -1;
  for (let i = 0; i < h.body.length; i++) {
    if (h.body[i]!.kind === 'ctx' || h.body[i]!.kind === 'new') last = i;
  }
  return last >= 0 && h.body[last + 1]?.kind === 'slash';
}

function applyUnifiedHunks(content: string, hunks: Hunk[], failPath: string, strict: boolean): string {
  const f = readLines(content);
  let d = 0;
  for (const h of hunks) {
    const old = hunkOldLines(h);
    const entries = hunkNewEntries(h);
    if (old.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const atEnd = pos === f.lines.length;
      const replacement = entries.map((e) => (e.kind === 'new' ? e.text : ''));
      f.lines.splice(pos, 0, ...replacement);
      if (atEnd && f.lines.length > 0) f.finalBreak = !markerAfterLastWritten(h);
      d += entries.length;
    } else {
      const hit = firstTier(f.lines, old, strict, 0);
      if (hit === null) throw new EditFault('no-match', failPath);
      const target = h.a - 1 + d;
      let best = hit.positions[0]!;
      for (const pos of hit.positions) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const runsToEnd = best + old.length === f.lines.length;
      const replacement = buildReplacement(f.lines, best, old, entries, hit.tier);
      spliceMatch(f, best, old.length, replacement);
      if (runsToEnd) f.finalBreak = !markerAfterLastWritten(h);
      d += entries.length - old.length;
    }
  }
  return writeLines(f);
}

function sectionPaths(s: Section): { oldP: string | null; newP: string | null } {
  return {
    oldP: s.headOld ?? s.renameOld ?? s.diffOld,
    newP: s.headNew ?? s.renameNew ?? s.diffNew,
  };
}

function makeUnifiedEdit(s: Section, strict: boolean): EditFn {
  const { oldP, newP } = sectionPaths(s);
  const isCreate = s.modeCreate || oldP === '/dev/null';
  const isDelete = s.modeDelete || newP === '/dev/null';
  return (tree) => {
    // Safety first, for every real path this section names, in old-then-new order.
    const named: string[] = [];
    if (!isCreate && oldP !== null && oldP !== '/dev/null') named.push(oldP);
    if (isCreate && oldP !== null && oldP !== '/dev/null') named.push(oldP);
    if (!isDelete && newP !== null && newP !== '/dev/null' && newP !== oldP) named.push(newP);
    if (isDelete && newP !== null && newP !== '/dev/null' && newP !== oldP) named.push(newP);
    if (isCreate && newP !== null && newP !== '/dev/null' && !named.includes(newP)) named.push(newP);
    if (isDelete && oldP !== null && oldP !== '/dev/null' && !named.includes(oldP)) named.push(oldP);
    for (const p of named) if (!pathIsSafe(p)) throw new EditFault('unsafe', p);

    if (isCreate) {
      const target = newP!;
      if (!pathIsSafe(target)) throw new EditFault('unsafe', target);
      if (tree.now(target) !== null) throw new EditFault('exists', target);
      const flat: BodyLine[] = [];
      for (const h of s.hunks) flat.push(...h.body);
      const outLines: string[] = [];
      let lastNew = -1;
      flat.forEach((b, idx) => {
        if (b.kind === 'new') {
          outLines.push(b.text);
          lastNew = idx;
        }
      });
      const noBreak = lastNew >= 0 && flat[lastNew + 1]?.kind === 'slash';
      const text = outLines.length === 0 ? '' : outLines.join('\n') + (noBreak ? '' : '\n');
      tree.put(target, text);
      return;
    }
    if (isDelete) {
      const source = oldP!;
      if (tree.now(source) === null) throw new EditFault('missing', source);
      tree.put(source, null);
      return;
    }
    const source = oldP!;
    const target = newP!;
    if (tree.now(source) === null) throw new EditFault('missing', source);
    if (target !== source && tree.now(target) !== null) throw new EditFault('exists', target);
    const content = tree.now(source)!;
    const result = s.hunks.length === 0 ? content : applyUnifiedHunks(content, s.hunks, source, strict);
    if (target !== source) {
      tree.put(source, null);
      tree.put(target, result);
      tree.moves.push([source, target]);
    } else {
      tree.put(source, result);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let curHunk: Hunk | null = null;

  const newSection = (diffOld: string | null, diffNew: string | null): Section => {
    const s: Section = {
      diffOld, diffNew, headOld: null, headNew: null, renameOld: null, renameNew: null,
      hasPair: false, modeCreate: false, modeDelete: false, inHeader: true, hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  const closeHunk = (): void => {
    if (curHunk !== null && cur !== null) {
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.rawEmpty) curHunk.body.pop();
        else break;
      }
      cur.hunks.push(curHunk);
    }
    curHunk = null;
  };

  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? '';

    if (curHunk !== null) {
      const endsHere = line.startsWith('diff --git ') || (line.startsWith('--- ') && next.startsWith('+++ '));
      const isBody = !endsHere && (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '');
      if (isBody) {
        if (line === '') curHunk.body.push({ kind: 'ctx', text: '', rawEmpty: true });
        else if (line[0] === ' ') curHunk.body.push({ kind: 'ctx', text: line.slice(1), rawEmpty: false });
        else if (line[0] === '-') curHunk.body.push({ kind: 'old', text: line.slice(1), rawEmpty: false });
        else if (line[0] === '+') curHunk.body.push({ kind: 'new', text: line.slice(1), rawEmpty: false });
        else curHunk.body.push({ kind: 'slash', text: line, rawEmpty: false });
        i++;
        continue;
      }
      closeHunk();
      // fall through and handle this line outside a body
    }

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkHeader.exec(line);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      if (cur === null) throw new ParseFault(`error: parse ${i + 1}`);
      cur.inHeader = false;
      curHunk = { a: Number(m[1]), body: [] };
      i++;
      continue;
    }
    if (cur !== null && cur.inHeader && line.startsWith('--- ')) {
      if (!next.startsWith('+++ ')) throw new ParseFault(`error: parse ${i + 2}`);
      if (cur.hasPair) {
        // A second pair in a header that already has one starts a fresh section.
        const s = newSection(null, null);
        s.headOld = headerPath(line.slice(4));
        s.headNew = headerPath(next.slice(4));
        s.hasPair = true;
      } else {
        cur.headOld = headerPath(line.slice(4));
        cur.headNew = headerPath(next.slice(4));
        cur.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && next.startsWith('+++ ')) {
      const s = newSection(null, null);
      s.headOld = headerPath(line.slice(4));
      s.headNew = headerPath(next.slice(4));
      s.hasPair = true;
      i += 2;
      continue;
    }
    if (cur !== null && cur.inHeader) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.modeCreate = true;
      else if (line.startsWith('deleted file mode')) cur.modeDelete = true;
      else if (line.startsWith('+++ ') && !cur.hasPair) {
        cur.headNew = headerPath(line.slice(4));
      }
      i++;
      continue;
    }
    // Outside bodies and headers, everything else is ignored prose.
    i++;
  }
  closeHunk();
  return sections.map((s) => makeUnifiedEdit(s, strict));
}

// ---------- SEARCH/REPLACE blocks (section 7) ----------

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  interface Block { path: string; oldLines: string[]; newLines: string[] }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new ParseFault(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const cand = lines[j]!;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(`error: parse ${searchLine + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchLine + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b): EditFn => {
    return (tree) => {
      if (!pathIsSafe(b.path)) throw new EditFault('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.now(b.path) !== null) throw new EditFault('exists', b.path);
        const text = b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n';
        tree.put(b.path, text);
        return;
      }
      const content = tree.now(b.path);
      if (content === null) throw new EditFault('missing', b.path);
      const f = readLines(content);
      const hit = firstTier(f.lines, b.oldLines, strict, 0);
      if (hit === null) throw new EditFault('no-match', b.path);
      if (hit.positions.length > 1) throw new EditFault('ambiguous', b.path);
      const pos = hit.positions[0]!;
      const entries: NEntry[] = b.newLines.map((t) => ({ kind: 'new' as const, text: t }));
      const replacement = buildReplacement(f.lines, pos, b.oldLines, entries, hit.tier);
      spliceMatch(f, pos, b.oldLines.length, replacement);
      tree.put(b.path, writeLines(f));
    };
  });
}

// ---------- V4A patches (section 8) ----------

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new ParseFault(`error: parse ${lines.length + 1}`);

  const edits: EditFn[] = [];
  const isHeader = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (!isHeader(line)) throw new ParseFault(`error: parse ${i + 1}`);
    const headerLineNo = i + 1;
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = line.slice('*** Delete File: '.length).trim();
    } else {
      kind = 'upd';
      path = line.slice('*** Update File: '.length).trim();
    }
    // Collect this section's lines, with their patch line numbers.
    const raw: Array<{ text: string; no: number }> = [];
    let j = i + 1;
    while (j < last && !isHeader(lines[j]!)) {
      raw.push({ text: lines[j]!, no: j + 1 });
      j++;
    }
    while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new ParseFault(`error: parse ${r.no}`);
      }
      edits.push((tree) => {
        if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
        if (tree.now(path) !== null) throw new EditFault('exists', path);
        tree.put(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      for (const r of raw) {
        if (r.text.trim() !== '') throw new ParseFault(`error: parse ${r.no}`);
      }
      edits.push((tree) => {
        if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
        if (tree.now(path) === null) throw new EditFault('missing', path);
        tree.put(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let start = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        start = 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      const openChunk = (anchor: string | null): VChunk => {
        const c: VChunk = { anchor, body: [], eof: false };
        chunks.push(c);
        curChunk = c;
        return c;
      };
      for (let k = start; k < raw.length; k++) {
        const r = raw[k]!;
        const t = r.text;
        if (t.trimEnd() === '*** End of File') {
          if (curChunk === null) openChunk(null);
          curChunk!.eof = true;
          curChunk = null;
        } else if (t.startsWith('@@')) {
          const anchorText = t.slice(2).trim();
          openChunk(anchorText === '' ? null : anchorText);
        } else if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (curChunk === null) openChunk(null);
          if (t === '') curChunk!.body.push({ kind: 'ctx', text: '', rawEmpty: true });
          else if (t[0] === ' ') curChunk!.body.push({ kind: 'ctx', text: t.slice(1), rawEmpty: false });
          else if (t[0] === '-') curChunk!.body.push({ kind: 'old', text: t.slice(1), rawEmpty: false });
          else curChunk!.body.push({ kind: 'new', text: t.slice(1), rawEmpty: false });
        } else {
          throw new ParseFault(`error: parse ${r.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(`error: parse ${headerLineNo}`);
      const theMove = moveTo;
      const theChunks = chunks;
      edits.push((tree) => {
        if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
        if (theMove !== null && !pathIsSafe(theMove)) throw new EditFault('unsafe', theMove);
        const content = tree.now(path);
        if (content === null) throw new EditFault('missing', path);
        if (theMove !== null && tree.now(theMove) !== null) throw new EditFault('exists', theMove);
        const f = readLines(content);
        let cursor = 0;
        for (const chunk of theChunks) {
          if (chunk.anchor !== null) {
            const ah = singleLineTier(f.lines, chunk.anchor, strict, cursor);
            if (ah === null) throw new EditFault('no-match', path);
            cursor = ah.positions[0]! + 1;
          }
          const old: string[] = [];
          for (const b of chunk.body) if (b.kind === 'ctx' || b.kind === 'old') old.push(b.text);
          const entries: NEntry[] = [];
          {
            let oIdx = 0;
            for (const b of chunk.body) {
              if (b.kind === 'ctx') {
                entries.push({ kind: 'ctx', oIdx });
                oIdx++;
              } else if (b.kind === 'old') oIdx++;
              else if (b.kind === 'new') entries.push({ kind: 'new', text: b.text });
            }
          }
          if (old.length === 0) {
            const pos = chunk.eof ? f.lines.length : Math.min(cursor, f.lines.length);
            const replacement = entries.map((e) => (e.kind === 'new' ? e.text : ''));
            f.lines.splice(pos, 0, ...replacement);
            cursor = pos + replacement.length;
          } else {
            const hit = firstTier(f.lines, old, strict, cursor);
            if (hit === null) throw new EditFault('no-match', path);
            let chosen: number | null = null;
            for (const pos of hit.positions) {
              if (chunk.eof && pos + old.length !== f.lines.length) continue;
              chosen = pos;
              break;
            }
            if (chosen === null) throw new EditFault('no-match', path);
            const replacement = buildReplacement(f.lines, chosen, old, entries, hit.tier);
            spliceMatch(f, chosen, old.length, replacement);
            cursor = chosen + replacement.length;
          }
        }
        const result = writeLines(f);
        if (theMove !== null) {
          tree.put(path, null);
          tree.put(theMove, result);
          tree.moves.push([path, theMove]);
        } else {
          tree.put(path, result);
        }
      });
    }
    i = j;
  }
  return edits;
}

// ---------- the run (sections 1, 2 and 10) ----------

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let afterDashDash = false;
  for (const a of args) {
    if (!afterDashDash && a === '--') {
      afterDashDash = true;
    } else if (!afterDashDash && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && KNOWN_FORMATS.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = parseJsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseFault('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.message] };
    throw e;
  }

  const tree = new Tree();
  const failures: EditFault[] = [];
  for (const edit of edits) {
    const savedChanged = new Map(tree.changed);
    const savedMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.changed.clear();
      for (const [k, v] of savedChanged) tree.changed.set(k, v);
      tree.moves = savedMoves;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }

  interface Row { key: string; text: string }
  const rows: Row[] = [];
  const consumedOld = new Set<string>();
  const consumedNew = new Set<string>();
  const finalOf = (p: string): string | null => tree.now(p);
  for (const [oldP, newP] of tree.moves) {
    if (tree.before(oldP) === null || finalOf(oldP) !== null) continue;
    if (tree.before(newP) !== null || finalOf(newP) === null) continue;
    if (consumedOld.has(oldP) || consumedNew.has(newP)) continue;
    consumedOld.add(oldP);
    consumedNew.add(newP);
    rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
  }
  for (const p of tree.changed.keys()) {
    if (consumedOld.has(p) || consumedNew.has(p)) continue;
    const was = tree.before(p);
    const is = tree.changed.get(p)!;
    if (was === is) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : is === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));

  if (!checkOnly) {
    for (const p of [...tree.changed.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.before(p);
      const is = tree.changed.get(p)!;
      if (was === is) continue;
      if (is === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, is);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
