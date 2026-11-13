import { describe, expect, it } from 'vitest';
import { createRepo, mergeRepo } from '../../../test/fixtures/repos';
import { getLog } from './log';
import { emptyLaneState, layoutLanes, resetLanes, rowWidth, type LaneRow } from './lanes';

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

/** Every bottom edge must be picked up by a top edge of the next row, and the reverse. */
function expectConnected(rows: LaneRow[]) {
  for (let i = 0; i + 1 < rows.length; i++) {
    const leaving = rows[i].bottom.map((e) => e.to).sort();
    const entering = rows[i + 1].top.map((e) => e.from).sort();
    expect([...new Set(leaving)], `row ${i}`).toEqual([...new Set(entering)]);
  }
}

describe('resetLanes', () => {
  it('clears the lanes that were waiting and keeps the colour counter', () => {
    const state = { waiting: ['abc', 'def'], colors: [0, 1], nextColor: 3 };
    expect(resetLanes(state)).toEqual({ waiting: [], colors: [], nextColor: 3 });
    expect(emptyLaneState()).toEqual({ waiting: [], colors: [], nextColor: 0 });
  });

  it('lays out the rows as a first page after a filter reset the graph', () => {
    const commits = [c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')];
    const lost = layoutLanes(commits.slice(0, 2)).state;
    const after = layoutLanes(commits, resetLanes(lost)).rows;
    const shape = (rows: LaneRow[]) => rows.map((r) => [
      r.lane, r.top.map((e) => [e.from, e.to]), r.bottom.map((e) => [e.from, e.to]),
    ]);
    // The colour counter is not reset, so the lines of the new page keep their palette position.
    expect(shape(after)).toEqual(shape(layoutLanes(commits).rows));
    expect(resetLanes(lost).nextColor).toBe(lost.nextColor);
  });
});

describe('layoutLanes', () => {
  it('keeps a linear history in lane 0', () => {
    const { rows, state } = layoutLanes([c('c', 'b'), c('b', 'a'), c('a')]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0].top).toEqual([]);
    expect(rows[0].bottom).toEqual([{ from: 0, to: 0, color: 0 }]);
    expect(rows[2].bottom).toEqual([]);
    expect(state.waiting).toEqual([]);
  });

  it('opens a lane for a merged branch and closes it at the fork point', () => {
    const { rows } = layoutLanes([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    expect(rows[0].bottom).toEqual([{ from: 0, to: 0, color: 0 }, { from: 0, to: 1, color: 1 }]);
    // Both lines arrive at the fork point; lane 1 bends into lane 0.
    expect(rows[3].top).toEqual([{ from: 0, to: 0, color: 0 }, { from: 1, to: 0, color: 1 }]);
    expect(rows.map(rowWidth)).toEqual([2, 2, 2, 2]);
    expectConnected(rows);
  });

  it('reuses a freed lane and gives the new line a new colour', () => {
    const { rows } = layoutLanes([
      c('m2', 'm1', 'y'), c('y', 'm1'), c('m1', 'a', 'x'), c('x', 'a'), c('a'),
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 1, 0]);
    expect(rows[1].color).not.toBe(rows[3].color);
    expectConnected(rows);
  });

  it('starts unrelated tips in their own lanes', () => {
    const { rows } = layoutLanes([c('t1', 'a'), c('t2', 'a'), c('a')]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    expectConnected(rows);
  });

  it('gives the same rows when the history is laid out page by page', () => {
    const commits = [c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a', 'z'), c('z')];
    const whole = layoutLanes(commits).rows;
    let state = emptyLaneState();
    const paged: LaneRow[] = [];
    for (let i = 0; i < commits.length; i += 2) {
      const r = layoutLanes(commits.slice(i, i + 2), JSON.parse(JSON.stringify(state)));
      paged.push(...r.rows);
      state = r.state;
    }
    expect(paged).toEqual(whole);
  });
});

/** Column of each commit's star in `git log --graph`, by hash. */
async function gitGraphLanes(git: (...a: string[]) => Promise<string>, ...revs: string[]) {
  const out = await git('log', '--graph', '--topo-order', '--format=%H', ...revs);
  const lanes = new Map<string, number>();
  for (const line of out.split('\n')) {
    const m = line.match(/^([|\\/ ]*)\*[|\\/ ]*([0-9a-f]{40})/);
    if (m) lanes.set(m[2], m[1].length / 2);
  }
  return lanes;
}

describe('layoutLanes against git log --graph', () => {
  it('matches on the merge fixture', async () => {
    const f = await mergeRepo();
    try {
      const commits = await getLog(f.dir);
      const { rows } = layoutLanes(commits);
      const expected = await gitGraphLanes(f.git);
      expect(commits.map((x, i) => [x.subject, rows[i].lane])).toEqual(commits.map((x) => [x.subject, expected.get(x.hash)]));
      expect(Math.max(...rows.map(rowWidth))).toBe(2);
      expectConnected(rows);
    } finally { f.dispose(); }
  });

  it('matches with two branches merged one after the other', async () => {
    const f = await createRepo('two merges');
    try {
      await f.commit('Base', { 'a.txt': 'a\n' });
      for (const name of ['one', 'two']) {
        await f.git('switch', '-c', name);
        await f.commit(`Work ${name}`, { [`${name}.txt`]: 'x\n' });
        await f.git('switch', 'main');
        await f.commit(`Main beside ${name}`, { [`m-${name}.txt`]: 'x\n' });
        await f.git('merge', '--no-ff', '-m', `Merge ${name}`, name);
      }
      const commits = await getLog(f.dir);
      const { rows } = layoutLanes(commits);
      const expected = await gitGraphLanes(f.git);
      expect(commits.map((x, i) => [x.subject, rows[i].lane])).toEqual(commits.map((x) => [x.subject, expected.get(x.hash)]));
      expectConnected(rows);
    } finally { f.dispose(); }
  });
});
