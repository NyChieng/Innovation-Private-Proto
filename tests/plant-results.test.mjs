import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlantResultsLoader } from '../FloraScan-Web-App/src/lib/plant-results.js';

const page = (id, has_more = false) => ({ results: [{ id }], total: 2, has_more });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('failed initial search exposes error and retry can populate results', async () => {
  let state;
  let fails = true;
  const loader = createPlantResultsLoader(async () => { if (fails) throw new Error('offline'); return page('first'); }, s => { state = s; });
  await loader.load({ q: 'fern' });
  assert.equal(state.error, true);
  assert.equal(state.loading, false);
  assert.equal(state.data, null);
  fails = false;
  await loader.load({ q: 'fern' });
  assert.equal(state.error, false);
  assert.equal(state.data.results[0].id, 'first');
});

test('a slower previous search cannot replace the latest results', async () => {
  let state;
  const old = deferred();
  const loader = createPlantResultsLoader(q => q.q === 'old' ? old.promise : Promise.resolve(page('new')), s => { state = s; });
  const first = loader.load({ q: 'old' });
  await loader.load({ q: 'new' });
  old.resolve(page('old'));
  await first;
  assert.equal(state.data.results[0].id, 'new');
});

test('load-more failure preserves results and retries the same offset', async () => {
  let state;
  let fails = true;
  const offsets = [];
  const loader = createPlantResultsLoader(async q => {
    offsets.push(q.offset);
    if (!q.offset) return page('first', true);
    if (fails) throw new Error('offline');
    return page('second');
  }, s => { state = s; });
  await loader.load({ q: 'fern' });
  await loader.loadMore();
  assert.equal(state.moreError, true);
  assert.equal(state.more, false);
  assert.deepEqual(state.data.results, [{ id: 'first' }]);
  fails = false;
  await loader.loadMore();
  assert.deepEqual(offsets, [0, 1, 1]);
  assert.deepEqual(state.data.results, [{ id: 'first' }, { id: 'second' }]);
  assert.equal(state.moreError, false);
});

test('changing filters during pagination cannot append old results', async () => {
  let state;
  const next = deferred();
  const loader = createPlantResultsLoader(q => q.offset ? next.promise : Promise.resolve(page(q.q, true)), s => { state = s; });
  await loader.load({ q: 'old' });
  const pending = loader.loadMore();
  await loader.load({ q: 'new' });
  next.resolve(page('old second'));
  await pending;
  assert.deepEqual(state.data.results, [{ id: 'new' }]);
  assert.equal(state.more, false);
});

test('cancel prevents unmounted or debounced search updates', async () => {
  const next = deferred();
  const states = [];
  const loader = createPlantResultsLoader(() => next.promise, s => states.push(s));
  const pending = loader.load({});
  loader.cancel();
  const before = states.length;
  next.resolve(page('late'));
  await pending;
  assert.equal(states.length, before);
});
