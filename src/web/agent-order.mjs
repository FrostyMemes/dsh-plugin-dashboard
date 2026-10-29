/** @typedef {{ status: string, runningOrder: number | null }} OrderedAgent */

/** @template {OrderedAgent} T @param {readonly T[]} agents @returns {T[]} */
export function orderAgents(agents) {
  const statusRank = status => status === 'running' ? 0 : status === 'idle' ? 1 : status === 'unknown' ? 3 : 2;
  return [...agents].sort((left, right) => {
    const groupOrder = statusRank(left.status) - statusRank(right.status);
    if (groupOrder !== 0) return groupOrder;
    if (
      (left.status === 'running' && right.status === 'running')
      || (left.status === 'idle' && right.status === 'idle')
    ) {
      const leftOrder = left.runningOrder ?? Number.NEGATIVE_INFINITY;
      const rightOrder = right.runningOrder ?? Number.NEGATIVE_INFINITY;
      return rightOrder - leftOrder;
    }
    if (statusRank(left.status) === 2 && left.status !== right.status) {
      return left.status < right.status ? -1 : 1;
    }
    return 0;
  });
}
