/** Coordinates one browse query and its pages; stale requests never publish state. */
export function createPlantResultsLoader(fetchPage, onChange, pageSize = 24) {
  let generation = 0;
  let query = {};
  let state = { data: null, loading: true, more: false, error: false, moreError: false };
  const publish = (patch) => { state = { ...state, ...patch }; onChange(state); };

  return {
    cancel() { generation += 1; },
    async load(nextQuery) {
      const current = ++generation;
      query = { ...nextQuery };
      publish({ data: null, loading: true, more: false, error: false, moreError: false });
      try {
        const data = await fetchPage({ ...query, limit: pageSize, offset: 0 });
        if (current === generation) publish({ data, loading: false });
      } catch {
        if (current === generation) publish({ loading: false, error: true });
      }
    },
    async loadMore() {
      if (!state.data?.has_more || state.loading || state.more) return;
      const current = generation;
      const previous = state.data;
      publish({ more: true, moreError: false });
      try {
        const next = await fetchPage({ ...query, limit: pageSize, offset: previous.results.length });
        if (current === generation) {
          publish({ data: { ...next, results: [...previous.results, ...next.results] }, more: false });
        }
      } catch {
        if (current === generation) publish({ more: false, moreError: true });
      }
    },
  };
}
