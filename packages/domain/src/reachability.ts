/**
 * Обход графа переходов. Нужен, чтобы «отсутствие тупиков» (STATE-MACHINES.md §5)
 * проверялось обходом, а не перечислением состояний руками: перечисление
 * устаревает в тот же день, когда добавляется состояние.
 */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
}

export function reachableFrom(edges: readonly GraphEdge[], start: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const edge of edges) {
      if (edge.from !== current) continue;
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      queue.push(edge.to);
    }
  }
  return visited;
}

/** Состояния, из которых недостижимо ни одно терминальное. */
export function statusesWithoutTerminalPath(
  edges: readonly GraphEdge[],
  statuses: readonly string[],
  isTerminal: (status: string) => boolean,
): readonly string[] {
  return statuses
    .filter((status) => !isTerminal(status))
    .filter((status) => {
      const reachable = reachableFrom(edges, status);
      return ![...reachable].some(isTerminal);
    });
}

/** Состояния, в которые нет ни одного входа и которые не являются стартовым. */
export function unreachableStatuses(
  edges: readonly GraphEdge[],
  statuses: readonly string[],
  start: string,
): readonly string[] {
  const reachable = reachableFrom(edges, start);
  return statuses.filter((status) => status !== start && !reachable.has(status));
}
