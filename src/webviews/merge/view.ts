import type { Chunk } from '../../core/merge/diff3';
import { buildResult, chunkLines, isAutomatic } from '../../core/merge/result';
import {
  accept, choiceOf, ignore, isResolved, pendingSides, startSessions, unresolvedConflicts, type ChunkSession, type Side,
} from '../../core/merge/session';
import type { MergeMethods, MergePerform, MergeState } from '../../shared/protocol';
import { followVsCodeTheme, installMonacoEnvironment, monaco } from '../ui/monacoSetup';
import { createClient, onHostEvent, pageErrors, vscodeApi } from '../ui/rpc';

type Editor = monaco.editor.IStandaloneCodeEditor;
type Pane = 'mine' | 'result' | 'theirs';

/** A changed chunk: what the user did with it and where it currently sits in the result. */
interface Region {
  chunk: Chunk;
  session: ChunkSession;
  /** Decoration in the result model whose range follows the user's edits. */
  tracker: string;
}

const request = createClient<MergeMethods>();
/** Typing next to a region must not pull the new text into it. */
const TRACKER = { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * The three-pane merge: mine on the left, the editable result in the middle, theirs on the right.
 * Arrows in the gutters between the panes accept a chunk, ✕ leaves it out; the panes scroll
 * together, aligned chunk by chunk, with a connector drawn between matching chunks.
 */
export async function startMergeView(workerUrl: string): Promise<void> {
  installMonacoEnvironment(workerUrl);
  const init = await request('init', null);
  const sides = { base: init.base, mine: init.mine, theirs: init.theirs };
  const start = buildResult(init.chunks, sides, init.applyNonConflicting);

  // ---- Layout ---------------------------------------------------------------------------------
  const root = document.getElementById('root')!;
  root.className = 'merge';
  const toolbar = root.appendChild(el('div', 'toolbar'));
  toolbar.appendChild(el('span', 'file', init.path)).title = init.path;
  const counter = toolbar.appendChild(el('span', 'counter'));
  counter.setAttribute('role', 'status');
  const button = (label: string, title: string, run: () => void, primary = false) => {
    const b = toolbar.appendChild(el('button', primary ? 'primary' : undefined, label));
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', run);
    return b;
  };
  const previousButton = button('↑ Previous', 'Go to the previous unresolved conflict', () => goToConflict(-1));
  const nextButton = button('↓ Next', 'Go to the next unresolved conflict', () => goToConflict(1));
  const applyButton = button('Apply Non-Conflicting', 'Put every change that does not conflict into the result', applyNonConflicting);
  button('Save', 'Write the result to the file and mark it resolved', () => void save(), true);

  const grid = root.appendChild(el('div', 'panes'));
  const header = (text: string) => grid.appendChild(el('header', undefined, text));
  header(init.labels.mine);
  grid.appendChild(el('span'));
  header('Result');
  grid.appendChild(el('span'));
  header(init.labels.theirs);
  const hosts = {} as Record<Pane, HTMLElement>;
  const gutters = {} as Record<Side, { box: HTMLElement; svg: SVGSVGElement; buttons: HTMLElement }>;
  for (const part of ['mine', 'gutter-mine', 'result', 'gutter-theirs', 'theirs'] as const) {
    if (part === 'gutter-mine' || part === 'gutter-theirs') {
      const box = grid.appendChild(el('div', 'gutter'));
      const svg = box.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
      svg.setAttribute('aria-hidden', 'true');
      gutters[part === 'gutter-mine' ? 'mine' : 'theirs'] = { box, svg, buttons: box.appendChild(el('div')) };
    } else hosts[part] = grid.appendChild(el('div', 'editor'));
  }

  // ---- Editors --------------------------------------------------------------------------------
  // Equal line heights everywhere keep the panes comparable: no wrapping, no folding.
  const options: monaco.editor.IStandaloneEditorConstructionOptions = {
    automaticLayout: true, minimap: { enabled: false }, wordWrap: 'off', folding: false, glyphMargin: false,
    scrollBeyondLastLine: true, renderLineHighlight: 'none', lineNumbersMinChars: 3, stickyScroll: { enabled: false },
  };
  const text = (lines: readonly string[]) => lines.map((l) => l + '\n').join('');
  const create = (pane: Pane, lines: readonly string[], readOnly: boolean) =>
    monaco.editor.create(hosts[pane], { ...options, value: text(lines), readOnly, ariaLabel: pane === 'result' ? 'Result' : init.labels[pane] });
  const editors: Record<Pane, Editor> = {
    mine: create('mine', init.mine, true),
    // The result always ends with a line break in the editor; Save drops it again.
    result: create('result', start.lines, false),
    theirs: create('theirs', init.theirs, true),
  };
  let theme = '';
  const model = editors.result.getModel()!;
  const lineHeight = editors.result.getOption(monaco.editor.EditorOption.lineHeight);

  // ---- Regions --------------------------------------------------------------------------------
  const sessions = startSessions(init.chunks, init.applyNonConflicting);
  const trackRange = (startLine: number, length: number) => new monaco.Range(startLine + 1, 1, startLine + length + 1, 1);
  const regions: Region[] = start.regions.map((r, i) => ({
    chunk: init.chunks[r.chunk],
    session: sessions[i],
    tracker: model.deltaDecorations([], [{ range: trackRange(r.start, r.length), options: TRACKER }])[0],
  }));
  /** Current place of a region in the result: first line (0-based) and number of lines. */
  const place = (r: Region) => {
    const range = model.getDecorationRange(r.tracker)!;
    return { start: range.startLineNumber - 1, length: range.endLineNumber - range.startLineNumber };
  };
  const setPlace = (r: Region, startLine: number, length: number) => {
    r.tracker = model.deltaDecorations([r.tracker], [{ range: trackRange(startLine, length), options: TRACKER }])[0];
  };
  const stateOf = (r: Region) => (isResolved(r.session) ? 'resolved' : r.chunk.kind === 'conflict' ? 'conflict' : 'change');

  /** Puts what the session now says into the region's place in the result. */
  function write(r: Region): void {
    const at = place(r);
    const lines = chunkLines(r.chunk, sides, choiceOf(r.session));
    editors.result.pushUndoStop();
    editors.result.executeEdits('merge', [{ range: trackRange(at.start, at.length), text: text(lines), forceMoveMarkers: true }]);
    editors.result.pushUndoStop();
    setPlace(r, at.start, lines.length);
  }

  function act(r: Region, side: Side, what: 'accept' | 'ignore'): void {
    const next = what === 'accept' ? accept(r.session, side) : ignore(r.session, side);
    if (next === r.session) return;
    r.session = next;
    if (what === 'accept') write(r);
    refresh();
  }

  function applyNonConflicting(): void {
    for (const r of regions) {
      if (!isAutomatic(r.chunk)) continue;
      for (const side of pendingSides(r.session)) {
        r.session = accept(r.session, side);
        write(r);
      }
    }
    refresh();
  }

  // ---- Highlights -----------------------------------------------------------------------------
  const lineDecorations = (ranges: { start: number; length: number; state: string }[]) => ranges.filter((x) => x.length > 0).map((x) => ({
    range: new monaco.Range(x.start + 1, 1, x.start + x.length, 1),
    options: { isWholeLine: true, className: `chunk-${x.state}` },
  }));
  const highlights: Record<Pane, monaco.editor.IEditorDecorationsCollection> = {
    mine: editors.mine.createDecorationsCollection(),
    result: editors.result.createDecorationsCollection(),
    theirs: editors.theirs.createDecorationsCollection(),
  };
  function highlight(): void {
    highlights.result.set(lineDecorations(regions.map((r) => ({ ...place(r), state: stateOf(r) }))));
    for (const side of ['mine', 'theirs'] as const) {
      // A side lights up only where it differs from base.
      const shown = regions.filter((r) => r.chunk.kind === 'conflict' || r.chunk.kind === 'same' || r.chunk.kind === side);
      highlights[side].set(lineDecorations(shown.map((r) => ({ ...r.chunk[side], state: stateOf(r) }))));
    }
  }

  // ---- Gutters: connectors and buttons --------------------------------------------------------
  /** Pixel position of the top of a line (0-based, may be one past the end) in an editor's viewport. */
  const yOf = (editor: Editor, line: number) => {
    const count = editor.getModel()!.getLineCount();
    const top = line < count ? editor.getTopForLineNumber(line + 1) : editor.getTopForLineNumber(count) + (line - count + 1) * lineHeight;
    return top - editor.getScrollTop();
  };

  function drawGutter(side: Side): void {
    const { box, svg, buttons } = gutters[side];
    const width = box.clientWidth;
    const height = box.clientHeight;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const paths: string[] = [];
    buttons.replaceChildren();
    for (const r of regions) {
      if (r.chunk.kind !== 'conflict' && r.chunk.kind !== 'same' && r.chunk.kind !== side) continue;
      const source = r.chunk[side];
      const target = place(r);
      // Left gutter: mine on its left edge, result on its right. Right gutter: the mirror image.
      const outer = [yOf(editors[side], source.start), yOf(editors[side], source.start + source.length)];
      const inner = [yOf(editors.result, target.start), yOf(editors.result, target.start + target.length)];
      if (Math.max(outer[1], inner[1]) < 0 || Math.min(outer[0], inner[0]) > height) continue;
      const [x0, x1] = side === 'mine' ? [0, width] : [width, 0];
      const mid = width / 2;
      paths.push(
        `<path class="link ${stateOf(r)}" d="M${x0} ${outer[0]}C${mid} ${outer[0]} ${mid} ${inner[0]} ${x1} ${inner[0]}` +
        `L${x1} ${Math.max(inner[1], inner[0] + 1)}C${mid} ${inner[1]} ${mid} ${outer[1]} ${x0} ${Math.max(outer[1], outer[0] + 1)}Z"/>`,
      );
      if (!pendingSides(r.session).includes(side) || outer[0] < -lineHeight || outer[0] > height) continue;
      const row = buttons.appendChild(el('div', `actions ${side}`));
      row.style.top = `${Math.max(0, outer[0])}px`;
      const add = r.session.taken.length > 0;
      const arrow = side === 'mine' ? '»' : '«';
      const name = side === 'mine' ? init.labels.mine : init.labels.theirs;
      const acceptButton = row.appendChild(el('button', 'accept', arrow));
      acceptButton.title = add ? `Also add this chunk from ${name} below` : `Accept this chunk from ${name}`;
      acceptButton.setAttribute('aria-label', acceptButton.title);
      acceptButton.addEventListener('click', () => act(r, side, 'accept'));
      const ignoreButton = row.appendChild(el('button', 'ignore', '✕'));
      ignoreButton.title = `Ignore this chunk from ${name}`;
      ignoreButton.setAttribute('aria-label', ignoreButton.title);
      ignoreButton.addEventListener('click', () => act(r, side, 'ignore'));
      if (side === 'mine') row.append(acceptButton); // the arrow sits next to the result on both sides
    }
    svg.innerHTML = paths.join('');
  }

  let frame = 0;
  let withHighlights = false;
  /**
   * Highlights and connectors are drawn once per frame: typing in the result schedules one pass,
   * however many edits arrive in that frame, instead of a full redraw per keystroke.
   */
  function scheduleDraw(highlights: boolean): void {
    withHighlights = withHighlights || highlights;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const all = withHighlights;
      withHighlights = false;
      if (all) highlight();
      drawGutter('mine');
      drawGutter('theirs');
    });
  }
  /** Scrolling and layout move the gutters alone; the highlights stay where they are. */
  const draw = (): void => scheduleDraw(false);

  // ---- Scrolling together ---------------------------------------------------------------------
  /** Line ranges of every chunk in each pane, the result's taken from where its regions are now. */
  function segments(): Record<Pane, { start: number; end: number }>[] {
    const places = new Map(regions.map((r) => [r.chunk, place(r)]));
    const resultEnd = model.getLineCount() - 1;
    let cursor = 0;
    return init.chunks.map((chunk, i) => {
      let result = places.get(chunk);
      if (!result) {
        // An unchanged chunk runs from the previous region to the next one, whatever was typed in it.
        const next = init.chunks.slice(i + 1).map((c) => places.get(c)).find((p) => p);
        result = { start: cursor, length: (next ? next.start : resultEnd) - cursor };
      }
      cursor = result.start + result.length;
      return {
        mine: { start: chunk.mine.start, end: chunk.mine.start + chunk.mine.length },
        result: { start: result.start, end: cursor },
        theirs: { start: chunk.theirs.start, end: chunk.theirs.start + chunk.theirs.length },
      };
    });
  }

  /** The line in `to` that sits at the same place within its chunk as `line` does in `from`. */
  function mapLine(all: ReturnType<typeof segments>, from: Pane, to: Pane, line: number): number {
    const seg = all.find((s) => line < s[from].end) ?? all[all.length - 1];
    if (!seg) return line;
    const length = seg[from].end - seg[from].start;
    const ratio = length > 0 ? Math.min(1, Math.max(0, (line - seg[from].start) / length)) : 0;
    const beyond = Math.max(0, line - seg[from].end); // scrolled past the last line
    return seg[to].start + ratio * (seg[to].end - seg[to].start) + beyond;
  }

  let syncing = false;
  function follow(source: Pane): void {
    if (syncing) return;
    syncing = true;
    const all = segments();
    const editor = editors[source];
    const half = editor.getLayoutInfo().height / 2;
    const middle = (editor.getScrollTop() + half) / lineHeight;
    for (const pane of ['mine', 'result', 'theirs'] as const) {
      if (pane !== source) editors[pane].setScrollTop(Math.max(0, mapLine(all, source, pane, middle) * lineHeight - half));
    }
    syncing = false;
    draw();
  }
  for (const pane of ['mine', 'result', 'theirs'] as const) {
    editors[pane].onDidScrollChange((e) => { if (e.scrollTopChanged) follow(pane); });
    editors[pane].onDidLayoutChange(draw);
  }
  model.onDidChangeContent(() => scheduleDraw(true));

  // ---- Navigation, save, state ----------------------------------------------------------------
  function goToConflict(direction: 1 | -1): void {
    const open = regions.filter((r) => r.chunk.kind === 'conflict' && !isResolved(r.session));
    if (!open.length) return;
    const line = (editors.result.getPosition()?.lineNumber ?? 1) - 1;
    const target = direction === 1
      ? open.find((r) => place(r).start > line) ?? open[0]
      : [...open].reverse().find((r) => place(r).start < line) ?? open[open.length - 1];
    const at = place(target).start + 1;
    editors.result.setPosition({ lineNumber: at, column: 1 });
    editors.result.revealLineInCenter(at);
    editors.result.focus();
  }

  async function save(): Promise<void> {
    const lines = model.getValue().split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    await request('save', { lines, unresolved: unresolvedConflicts(regions.map((r) => r.session)) }).catch(() => false);
  }

  function report(): void {
    const all = regions.map((r) => r.session);
    vscodeApi.postMessage({
      kind: 'event', event: 'state', editors: Object.keys(editors).length,
      unresolved: unresolvedConflicts(all),
      pendingAutomatic: regions.filter((r) => isAutomatic(r.chunk) && !isResolved(r.session)).length,
      conflicts: regions.filter((r) => r.chunk.kind === 'conflict').length,
      theme, errors: pageErrors.filter((e) => !/ResizeObserver loop/.test(e)),
    } satisfies MergeState);
  }

  function refresh(): void {
    const all = regions.map((r) => r.session);
    const left = unresolvedConflicts(all);
    const total = regions.filter((r) => r.chunk.kind === 'conflict').length;
    counter.textContent = left ? `${left} of ${total} ${total === 1 ? 'conflict' : 'conflicts'} left` : 'All conflicts resolved';
    counter.classList.toggle('done', left === 0);
    previousButton.disabled = nextButton.disabled = left === 0;
    applyButton.disabled = !regions.some((r) => isAutomatic(r.chunk) && !isResolved(r.session));
    scheduleDraw(true);
    report();
  }

  // The host can press the same buttons: the integration tests do, and so can commands later.
  onHostEvent((e) => {
    const p = e as MergePerform;
    if (p.event !== 'perform') return;
    if (p.action === 'save') return void save();
    if (p.action === 'applyNonConflicting') return applyNonConflicting();
    const target = regions.filter((r) => r.chunk.kind === 'conflict')[p.conflict ?? 0];
    if (target && p.side) act(target, p.side, p.action);
  });

  // Last, because every theme change reports the view's state.
  followVsCodeTheme((applied) => { theme = applied.base; report(); });
  refresh();
  goToConflict(1);
}
