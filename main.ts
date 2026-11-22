// mend: one CLI that applies AI-written edits in four formats to a tree of
// text files, exactly as SPEC.md (version 1) says.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// Formats: unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool
// calls. Lines an edit names are found at the first of three matching
// tiers (exact; trailing whitespace ignored; leading and trailing
// whitespace ignored), unless --strict asks for exact only. Every file
// is changed or none is: a failed edit is reported, the edits after it
// still run, and when any edit failed nothing is written.
//
// Node 22, standard library alone. In a trial the grader runs
// `node /bot/main.ts` with MAKEFUN_ENV_URL set, and this file hands over
// to runner.ts (the last lines below); keep that hand-over and runner.ts.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse/usage error that exits 2 with one line on stdout. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed per line, and no
 * empty piece after a final \n. (SPEC section 3.) */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \,
 * and none of its /-separated segments is empty, . or ... (SPEC section 3.) */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own line break and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

/** Split a file's text at its own line break (CRLF when its first line
 * feed follows a carriage return, LF otherwise). An empty file has no
 * lines and does not end with a line break. (SPEC section 3.) */
function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

/** Render a file state back to text, with its own line break between its
 * lines and a final one exactly when it ends with one. */
function renderFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 * the rest read from disk. Moves are recorded so the output can print one
 * `R old -> new` line for a moved file instead of a D and an A line. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
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
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
  /** The file state of a file that exists in the tree. */
  state(p: string): FileState {
    return parseFile(this.get(p)!);
  }
  recordMove(old: string, nw: string): void {
    this.moves.push({ old, new: nw });
  }
}

type Edit = (tree: Tree) => void;

/** Detect the patch format. (SPEC section 4.) */
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

// ---------------------------------------------------------------------------
// Matching lines (SPEC section 5)
// ---------------------------------------------------------------------------

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimBothWS(a) === trimBothWS(b);
}

/** Positions i where O's lines match the file's lines i, i+1, ... at the
 * given tier, at or after `from`. When `eofOnly` is set, only occurrences
 * ending at the file's last line count. Occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (tier 0 only with
 * --strict), and its positions; null when O occurs at no tier. */
function findTier(lines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(lines, o, tier, from, eofOnly);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched
 * line; any other line is written as it is, except at tier 2 where it is
 * re-indented from O's first line's leading whitespace to the file's
 * first matched line's. `oIdx` is the line's index in O (context only). */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

function transformN(o: string[], n: NewLine[], fileLines: string[], pos: number, tier: number): string[] {
  if (o.length === 0) return n.map((x) => x.text);
  const p = leadWS(o[0]!);
  const f = leadWS(fileLines[pos]!);
  const out: string[] = [];
  for (const x of n) {
    if (x.ctx) {
      out.push(fileLines[pos + x.oIdx]!);
    } else if (tier === 2 && x.text !== '' && x.text.trim() !== '' && x.text.startsWith(p)) {
      out.push(f + x.text.slice(p.length));
    } else {
      out.push(x.text);
    }
  }
  return out;
}

/** Replace the k lines at `pos` with `replacement`, keeping the file's own
 * line break; the caller decides the final break. */
function spliceLines(s: FileState, pos: number, k: number, replacement: string[]): FileState {
  return { lines: [...s.lines.slice(0, pos), ...replacement, ...s.lines.slice(pos + k)], br: s.br, final: s.final };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

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
      tree.set(p, text);
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
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const s = parseFile(before);
      if (line < 0 || line > s.lines.length) throw new Fail('no-match', p);
      s.lines.splice(line, 0, ...add);
      tree.set(p, renderFile(s));
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

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6), SEARCH/REPLACE blocks (section 7) and
// V4A patches (section 8) are added by the edits below.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** Old start line number A (the -A in the header). */
  a: number;
  /** Old lines: context and - lines, in body order. */
  o: string[];
  /** New lines: context and + lines, in body order. */
  n: NewLine[];
  /** A \ line follows the hunk's last context or + line. */
  noEol: boolean;
  /** A \ line follows the hunk's last + line. */
  plusNoEol: boolean;
}

/** A hunk's body, read from the lines after its header. The body ends at
 * the first line that is not a body line, at a diff --git line, at a ---
 * line followed by a +++ line, or at the end of the patch; empty lines at
 * the end of a body are not part of it. */
function parseHunk(lines: string[], start: number): { hunk: Hunk; next: number } {
  const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(lines[start]!);
  if (head === null) throw new Exit2(`error: parse ${start + 1}`);
  const a = Number(head[1]);
  let j = start + 1;
  const body: string[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: NewLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k += 1) {
    const b = body[k]!;
    if (b.startsWith(' ')) {
      o.push(b.slice(1));
      n.push({ text: b.slice(1), ctx: true, oIdx: o.length - 1 });
      lastCtxPlus = k;
    } else if (b.startsWith('-')) {
      o.push(b.slice(1));
    } else if (b.startsWith('+')) {
      n.push({ text: b.slice(1), ctx: false, oIdx: -1 });
      lastCtxPlus = k;
      lastPlus = k;
    } else if (b === '') {
      o.push('');
      n.push({ text: '', ctx: true, oIdx: o.length - 1 });
      lastCtxPlus = k;
    }
  }
  const follows = (k: number): boolean => body[k + 1] !== undefined && body[k + 1]![0] === '\\';
  return { hunk: { a, o, n, noEol: lastCtxPlus >= 0 && follows(lastCtxPlus), plusNoEol: lastPlus >= 0 && follows(lastPlus) }, next: j };
}

/** The path after a --- or +++ line: the text after the four characters,
 * up to the first tab, with surrounding spaces removed; /dev/null means
 * no file, and a leading a/ or b/ is removed. */
function headerPath(line: string): string | null {
  const p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

interface RawSection {
  diffOld?: string;
  diffNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  isNew: boolean;
  isDel: boolean;
  hasPair: boolean;
  headerDone: boolean;
  hunks: Hunk[];
}

function newRawSection(): RawSection {
  return { isNew: false, isDel: false, hasPair: false, headerDone: false, hunks: [] };
}

/** Apply a section's hunks in order, each to the result of the ones
 * before it, and return the resulting file state. */
function applyHunks(state: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let s = state;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(s.lines, h.o, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const replacement = transformN(h.o, h.n, s.lines, best, found.tier);
      const runsToEnd = best + h.o.length === s.lines.length;
      let final = s.final;
      if (runsToEnd) final = replacement.length === 0 ? best > 0 : !h.noEol;
      s = spliceLines(s, best, h.o.length, replacement);
      s = { ...s, final };
      d += h.n.length - h.o.length;
    } else {
      const insertPos = Math.min(Math.max(h.a + d, 0), s.lines.length);
      const replacement = h.n.map((x) => x.text);
      const runsToEnd = insertPos === s.lines.length;
      let final = s.final;
      if (runsToEnd && replacement.length > 0) final = !h.noEol;
      s = spliceLines(s, insertPos, 0, replacement);
      s = { ...s, final };
      d += h.n.length;
    }
  }
  return s;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newRawSection();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      sections.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      cur.hunks.push(hunk);
      cur.headerDone = true;
      i = next;
      continue;
    }
    if (cur !== null && !cur.headerDone) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur.hasPair) {
            cur = newRawSection();
            cur.pairOld = headerPath(l);
            cur.pairNew = headerPath(lines[i + 1]!);
            cur.hasPair = true;
            sections.push(cur);
          } else {
            cur.pairOld = headerPath(l);
            cur.pairNew = headerPath(lines[i + 1]!);
            cur.hasPair = true;
          }
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) cur.isNew = true;
      else if (l.startsWith('deleted file mode')) cur.isDel = true;
      i += 1;
      continue;
    }
    if (cur !== null && cur.headerDone) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newRawSection();
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
        cur.hasPair = true;
        sections.push(cur);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newRawSection();
      cur.pairOld = headerPath(l);
      cur.pairNew = headerPath(lines[i + 1]!);
      cur.hasPair = true;
      sections.push(cur);
      i += 2;
      continue;
    }
    i += 1;
  }
  return sections.map((sec) => {
    const old = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
    const nw = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
    const hunks = sec.hunks;
    const isCreation = old === null || sec.isNew;
    const isDeletion = !isCreation && (nw === null || sec.isDel);
    const isMove = !isCreation && !isDeletion && old !== undefined && nw !== undefined && old !== null && nw !== null && old !== nw;
    return (tree: Tree): void => {
      if (old !== undefined && old !== null && !safe(old)) throw new Fail('unsafe', old);
      if (nw !== undefined && nw !== null && nw !== old && !safe(nw)) throw new Fail('unsafe', nw);
      if (isCreation) {
        if (tree.get(nw!) !== null) throw new Fail('exists', nw!);
        const plus: string[] = [];
        let noEol = false;
        for (const h of hunks) {
          for (const x of h.n) {
            if (!x.ctx) plus.push(x.text);
          }
          if (h.n.some((x) => !x.ctx) && h.plusNoEol) noEol = true;
          else if (h.n.some((x) => !x.ctx)) noEol = false;
        }
        tree.set(nw!, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
        return;
      }
      if (isDeletion) {
        if (tree.get(old!) === null) throw new Fail('missing', old!);
        tree.set(old!, null);
        return;
      }
      if (isMove) {
        if (tree.get(old!) === null) throw new Fail('missing', old!);
        if (tree.get(nw!) !== null) throw new Fail('exists', nw!);
        const s = applyHunks(tree.state(old!), hunks, strict, old!);
        tree.set(old!, null);
        tree.set(nw!, renderFile(s));
        tree.recordMove(old!, nw!);
        return;
      }
      if (tree.get(old!) === null) throw new Fail('missing', old!);
      const s = applyHunks(tree.state(old!), hunks, strict, old!);
      tree.set(old!, renderFile(s));
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    // The path is the nearest line before the SEARCH line, and after the
    // previous block's >>>>>>> REPLACE line, that is not blank and does
    // not start with three backticks.
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    // Find ======= and then >>>>>>> REPLACE after the SEARCH line. Either
    // missing, or another SEARCH line first, is a parse fault at the
    // SEARCH line.
    let eq = -1;
    let j = i + 1;
    while (j < lines.length) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      j += 1;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    j = eq + 1;
    while (j < lines.length) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      j += 1;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const s = parseFile(cur);
      const found = findTier(s.lines, oldLines, strict, 0, false);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
      const replacement = transformN(oldLines, n, s.lines, pos, found.tier);
      tree.set(p, renderFile(spliceLines(s, pos, oldLines.length, replacement)));
    });
    prevPath = p;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  /** The chunk's anchor, or null when it has none (an empty text is none). */
  anchor: string | null;
  /** The chunk is anchored to the end of the file. */
  eof: boolean;
  body: string[];
}

function v4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

/** The first line at or after `from` equal to a single line at the first
 * tier where one is, or -1. */
function findSingle(lines: string[], anchor: string, strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let k = Math.max(0, from); k < lines.length; k += 1) {
      if (lineEq(lines[k]!, anchor, tier)) return k;
    }
  }
  return -1;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice(14).trim();
      const raw: { line: string; num: number }[] = [];
      let j = i + 1;
      while (j < last && !v4aSectionStart(lines[j]!)) {
        raw.push({ line: lines[j]!, num: j + 1 });
        j += 1;
      }
      // Blank lines at the end of a section are not part of it.
      while (raw.length > 0 && raw[raw.length - 1]!.line.trim() === '') raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.line === '') fileLines.push('');
        else if (r.line.startsWith('+')) fileLines.push(r.line.slice(1));
        else throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice(17).trim();
      let j = i + 1;
      while (j < last && blank(lines[j]!)) j += 1;
      if (j < last && !v4aSectionStart(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.set(p, null);
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice(17).trim();
      const updateLine = i + 1;
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice(13).trim();
        j += 1;
      }
      let sectionEnd = j;
      while (sectionEnd < last && !v4aSectionStart(lines[sectionEnd]!)) sectionEnd += 1;
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let eofEnded = false;
      for (let k = j; k < sectionEnd; k += 1) {
        const l2 = lines[k]!;
        if (l2.startsWith('@@')) {
          curChunk = { anchor: l2.slice(2).trim(), eof: false, body: [] };
          chunks.push(curChunk);
          eofEnded = false;
          continue;
        }
        if (l2.trim() === '*** End of File' && !l2.startsWith(' ')) {
          if (curChunk === null) {
            curChunk = { anchor: null, eof: true, body: [] };
            chunks.push(curChunk);
          } else {
            curChunk.eof = true;
          }
          curChunk = null;
          eofEnded = true;
          continue;
        }
        if (l2 === '' || l2.startsWith(' ') || l2.startsWith('-') || l2.startsWith('+')) {
          if (curChunk === null) {
            if (chunks.length === 0 && !eofEnded) {
              curChunk = { anchor: null, eof: false, body: [] };
              chunks.push(curChunk);
            } else if (eofEnded && l2.trim() === '') {
              continue;
            } else {
              throw new Exit2(`error: parse ${k + 1}`);
            }
          }
          curChunk.body.push(l2);
          continue;
        }
        throw new Exit2(`error: parse ${k + 1}`);
      }
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        while (lc.body.length > 0 && lc.body[lc.body.length - 1]!.trim() === '') lc.body.pop();
      }
      const live = chunks.filter((c) => c.body.length > 0 || c.anchor !== null || c.eof);
      if (live.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      const useChunks = live;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        if (tree.get(p) === null) throw new Fail('missing', p);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        let s = tree.state(p);
        let cursor = 0;
        for (const chunk of useChunks) {
          if (chunk.anchor !== null && chunk.anchor !== '') {
            const at = findSingle(s.lines, chunk.anchor, strict, cursor);
            if (at < 0) throw new Fail('no-match', p);
            cursor = at + 1;
          }
          const o: string[] = [];
          const n: NewLine[] = [];
          for (const b of chunk.body) {
            if (b.startsWith(' ')) {
              o.push(b.slice(1));
              n.push({ text: b.slice(1), ctx: true, oIdx: o.length - 1 });
            } else if (b.startsWith('-')) {
              o.push(b.slice(1));
            } else if (b.startsWith('+')) {
              n.push({ text: b.slice(1), ctx: false, oIdx: -1 });
            } else if (b === '') {
              o.push('');
              n.push({ text: '', ctx: true, oIdx: o.length - 1 });
            }
          }
          if (o.length === 0) {
            const insertPos = chunk.eof ? s.lines.length : cursor;
            const replacement = n.map((x) => x.text);
            s = spliceLines(s, insertPos, 0, replacement);
            cursor = insertPos + replacement.length;
          } else {
            const found = findTier(s.lines, o, strict, cursor, chunk.eof);
            if (found === null) throw new Fail('no-match', p);
            const pos = found.positions[0]!;
            const replacement = transformN(o, n, s.lines, pos, found.tier);
            s = spliceLines(s, pos, o.length, replacement);
            cursor = pos + replacement.length;
          }
        }
        if (moveTo !== null) {
          tree.set(p, null);
          tree.set(moveTo, renderFile(s));
          tree.recordMove(p, moveTo);
        } else {
          tree.set(p, renderFile(s));
        }
      });
      i = sectionEnd;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC sections 1, 2 and 10)
// ---------------------------------------------------------------------------

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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One row per changed path, in byte order of the paths (UTF-8). A move
  // prints as one `R old -> new` row, sorted by the new path, instead of
  // the pair's D and A rows.
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const used = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.now.get(m.old) === null && tree.original(m.new) === null && tree.now.get(m.new) !== null && changed.includes(m.old) && changed.includes(m.new)) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      used.add(m.old);
      used.add(m.new);
    }
  }
  for (const p of changed) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
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
