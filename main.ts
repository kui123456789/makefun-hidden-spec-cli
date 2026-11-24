// mend: apply an AI-written edit to a tree of text files, as SPEC.md says.
// One command-line tool for four formats: unified diffs (often with wrong line
// numbers), SEARCH/REPLACE blocks, V4A patches and JSON tool calls. Every edit
// is found at the first of three matching tiers, and the tree is changed in
// full or not at all. Node 22, the standard library alone.
// Run it as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines with its own line break and whether it ends with one. */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function serializeFile(fm: FileModel): string {
  if (fm.lines.length === 0) return '';
  return fm.lines.join(fm.br) + (fm.final ? fm.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** How a line is compared at one matching tier. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at this tier; occurrences may overlap. */
function occurrencesAt(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > lines.length) return out;
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions. */
function findTier(lines: string[], old: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    let occ = occurrencesAt(lines, old, tier).filter((p) => p >= from);
    if (eofOnly) occ = occ.filter((p) => p + old.length === lines.length);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

/** Tier 2 re-indentation of one new line: P (old first line's indent) becomes F (file's). */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/**
 * The lines that replace a matched block. Context lines of N are the file's own
 * matched lines; every other line of N is written as it is, re-indented at tier 2.
 * nCtx maps each N line to its offset inside O when it is a context line, else null.
 */
function replacementLines(fileLines: string[], pos: number, oldLines: string[], newLines: string[], nCtx: Array<number | null>, tier: number): string[] {
  const p = oldLines.length > 0 ? leadingWs(oldLines[0]!) : '';
  const f = oldLines.length > 0 ? leadingWs(fileLines[pos]!) : '';
  return newLines.map((nl, j) => {
    const off = nCtx[j]!;
    if (off !== null) return fileLines[pos + off]!;
    return tier === 2 ? reindent(nl, p, f) : nl;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
  /** A `\` line follows this hunk's last context or `+` line. */
  noEol: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  hasPair: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** The path of a `--- ` / `+++ ` line: text after four characters, to the first tab, trimmed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

function parseHunkHeader(line: string, no: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${no}`);
  return Number(m[1]);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const fresh = (): Section => ({
    oldPath: null,
    newPath: null,
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    hasPair: false,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  const startSection = (): void => {
    cur = fresh();
    sections.push(cur);
    inHeader = true;
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection();
      cur!.diffOld = m[1]!;
      cur!.diffNew = m[2]!;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(l, i + 1);
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') j++;
        else break;
      }
      const rawBody = lines.slice(i + 1, j);
      while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') rawBody.pop();
      const body: BodyLine[] = rawBody.map((bl) =>
        bl === '' ? { kind: ' ' as const, text: '' } : bl[0] === '\\' ? { kind: '\\' as const, text: bl } : { kind: bl[0] as ' ' | '-' | '+', text: bl.slice(1) },
      );
      let noEol = false;
      let lastContent = -1;
      for (let k = 0; k < body.length; k++) {
        if (body[k]!.kind === ' ' || body[k]!.kind === '+') lastContent = k;
      }
      if (lastContent >= 0) {
        noEol = body[lastContent + 1] !== undefined && body[lastContent + 1]!.kind === '\\';
      } else if (body.length > 0) {
        noEol = body[body.length - 1]!.kind === '\\';
      }
      cur.hunks.push({ a, body, noEol });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur === null) {
      // Outside any section: a `--- `/`+++ ` pair starts one, anything else is prose.
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection();
        continue;
      }
      i++;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur.hasPair) {
            // A second pair is not part of this header: it starts a new section.
            startSection();
            continue;
          }
          cur.pairOld = stripAB(headerPath(l));
          cur.pairNew = stripAB(headerPath(lines[i + 1]!));
          cur.hasPair = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.isCreate = true;
      else if (l.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    // After the first hunk: a `--- `/`+++ ` pair starts a new section, the rest is ignored.
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection();
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** Apply a section's hunks in order to a file's text; throws Fail on the first bad hunk. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const fm = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const oLines: string[] = [];
    const nLines: string[] = [];
    const nCtx: Array<number | null> = [];
    for (const bl of h.body) {
      if (bl.kind === ' ') {
        oLines.push(bl.text);
        nLines.push(bl.text);
        nCtx.push(oLines.length - 1);
      } else if (bl.kind === '-') {
        oLines.push(bl.text);
      } else if (bl.kind === '+') {
        nLines.push(bl.text);
        nCtx.push(null);
      }
    }
    if (oLines.length === 0) {
      const oldLen = fm.lines.length;
      const pos = Math.min(Math.max(h.a + d, 0), oldLen);
      fm.lines.splice(pos, 0, ...nLines);
      if (pos === oldLen) fm.final = !h.noEol;
      d += nLines.length;
      continue;
    }
    const found = findTier(fm.lines, oLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        pos = p;
        best = dist;
      }
    }
    const endsAtEnd = pos + oLines.length === fm.lines.length;
    const rep = replacementLines(fm.lines, pos, oLines, nLines, nCtx, found.tier);
    fm.lines.splice(pos, oLines.length, ...rep);
    if (endsAtEnd) fm.final = !h.noEol;
    d += nLines.length - oLines.length;
  }
  return serializeFile(fm);
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
  const newPath = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
  const isCreate = sec.pairOld === '/dev/null' || sec.isCreate;
  const isDelete = sec.pairNew === '/dev/null' || sec.isDelete;
  return (tree) => {
    if (oldPath !== null && oldPath !== '/dev/null' && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && newPath !== '/dev/null' && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (oldPath === null || newPath === null) throw new Fail('missing', oldPath ?? newPath ?? '');
    if (isCreate) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const bl of h.body) if (bl.kind === '+') plus.push(bl.text);
      let noEol = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const body = sec.hunks[hi]!.body;
        for (let k = body.length - 1; k >= 0; k--) {
          if (body[k]!.kind === '+') {
            noEol = body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
            break outer;
          }
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      const cur = tree.get(oldPath);
      if (cur === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out = applyHunks(cur, sec.hunks, strict, oldPath);
      tree.now.set(newPath, out);
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    const cur = tree.get(oldPath);
    if (cur === null) throw new Fail('missing', oldPath);
    tree.now.set(oldPath, applyHunks(cur, sec.hunks, strict, oldPath));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (lastPath === null) throw new Exit2(`error: parse ${searchNo}`);
      path = lastPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
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
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchNo}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    const edit = (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const fm = parseFile(cur);
      const found = findTier(fm.lines, oldLines, strict, 0, false);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const nCtx: Array<number | null> = newLines.map(() => null);
      const repLines = replacementLines(fm.lines, pos, oldLines, newLines, nCtx, found.tier);
      fm.lines.splice(pos, oldLines.length, ...repLines);
      tree.now.set(p, serializeFile(fm));
    };
    edits.push(edit);
    lastPath = p;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  raw: Array<{ text: string; no: number }>;
}

function v4aSectionStart(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  for (const [prefix, kind] of [
    ['*** Add File:', 'add'],
    ['*** Delete File:', 'delete'],
    ['*** Update File:', 'update'],
  ] as const) {
    if (line.startsWith(prefix)) return { kind, path: line.slice(prefix.length).trim() };
  }
  return null;
}

function isV4aBodyLine(text: string): boolean {
  return text === '' || blank(text) || text[0] === ' ' || text[0] === '-' || text[0] === '+';
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let cur: V4aSection | null = null;
  for (let j = first + 1; j < last; j++) {
    const l = lines[j]!;
    const start = v4aSectionStart(l);
    if (start !== null) {
      if (cur !== null) sections.push(cur);
      cur = { kind: start.kind, path: start.path, lineNo: j + 1, raw: [] };
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${j + 1}`);
    }
    cur.raw.push({ text: l, no: j + 1 });
  }
  if (cur !== null) sections.push(cur);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => v4aEdit(sec, strict));
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  while (sec.raw.length > 0 && blank(sec.raw[sec.raw.length - 1]!.text)) sec.raw.pop();
  if (sec.kind === 'add') {
    const fileLines: string[] = [];
    for (const r of sec.raw) {
      if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else if (blank(r.text)) fileLines.push('');
      else throw new Exit2(`error: parse ${r.no}`);
    }
    const p = sec.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    if (sec.raw.length > 0) throw new Exit2(`error: parse ${sec.raw[0]!.no}`);
    const p = sec.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  // Update: optional `*** Move to:` first, then chunks.
  let moveTo: string | null = null;
  let idx = 0;
  if (sec.raw.length > 0 && sec.raw[0]!.text.startsWith('*** Move to:')) {
    moveTo = sec.raw[0]!.text.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  while (idx < sec.raw.length) {
    const r = sec.raw[idx]!;
    let anchor: string | null = null;
    if (r.text.startsWith('@@')) {
      anchor = r.text.slice(2).trim();
      idx++;
    } else if (r.text.startsWith('*** End of File') || r.text.startsWith('*** Move to:')) {
      throw new Exit2(`error: parse ${r.no}`);
    } else if (!isV4aBodyLine(r.text)) {
      throw new Exit2(`error: parse ${r.no}`);
    }
    const body: BodyLine[] = [];
    while (idx < sec.raw.length) {
      const b = sec.raw[idx]!;
      if (b.text.startsWith('@@') || b.text.trimEnd() === '*** End of File' || b.text.startsWith('*** Move to:')) break;
      if (!isV4aBodyLine(b.text)) throw new Exit2(`error: parse ${b.no}`);
      body.push(b.text === '' ? { kind: ' ' as const, text: '' } : { kind: b.text[0] as ' ' | '-' | '+', text: b.text.slice(1) });
      idx++;
    }
    let eof = false;
    if (idx < sec.raw.length && sec.raw[idx]!.text.trimEnd() === '*** End of File') {
      eof = true;
      idx++;
    }
    chunks.push({ anchor, eof, body });
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
  const p = sec.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const fm = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let foundAt = -1;
        for (let tier = 0; tier <= 2 && foundAt < 0; tier++) {
          if (strict && tier > 0) break;
          for (let k = cursor; k < fm.lines.length; k++) {
            if (normLine(fm.lines[k]!, tier) === normLine(ch.anchor, tier)) {
              foundAt = k;
              break;
            }
          }
        }
        if (foundAt < 0) throw new Fail('no-match', p);
        cursor = foundAt + 1;
      }
      const oLines: string[] = [];
      const nLines: string[] = [];
      const nCtx: Array<number | null> = [];
      for (const bl of ch.body) {
        if (bl.kind === ' ') {
          oLines.push(bl.text);
          nLines.push(bl.text);
          nCtx.push(oLines.length - 1);
        } else if (bl.kind === '-') {
          oLines.push(bl.text);
        } else if (bl.kind === '+') {
          nLines.push(bl.text);
          nCtx.push(null);
        }
      }
      if (oLines.length === 0) {
        const pos = ch.eof ? fm.lines.length : cursor;
        fm.lines.splice(pos, 0, ...nLines);
        cursor = pos + nLines.length;
        continue;
      }
      const found = findTier(fm.lines, oLines, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', p);
      const pos = found.occ[0]!;
      const rep = replacementLines(fm.lines, pos, oLines, nLines, nCtx, found.tier);
      fm.lines.splice(pos, oLines.length, ...rep);
      cursor = pos + nLines.length;
    }
    const out = serializeFile(fm);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(p, null);
      tree.moves.push([p, moveTo]);
      return;
    }
    tree.now.set(p, out);
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const fm = parseFile(before);
      if (line < 0 || line > fm.lines.length) throw new Fail('no-match', p);
      fm.lines.splice(line, 0, ...add);
      tree.now.set(p, serializeFile(fm));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the patch (SPEC.md sections 1, 2 and 10)                    */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: one per changed path, byte order of the paths; a successful
  // move prints `R <old> -> <new>` (sorted by <new>) instead of its D/A pair.
  const rows: Array<{ key: string; line: string }> = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    if (suppressed.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
