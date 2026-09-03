import type { Rejection, Result } from './result';
import { ok } from './result';

/**
 * Журнал команд: ключ команды → состояние, к которому она уже привела.
 *
 * Повтор вебхука и повтор нажатия — норма, а не авария. Поэтому применение
 * команды с уже виденным ключом возвращает записанный результат и **не
 * порождает намерений повторно**: иначе повтор ответа банка выпустит второе
 * поручение (FUNCTIONAL.md инвариант 13, BACKLOG E1-11).
 */
export interface CommandJournal<S> {
  readonly applied: ReadonlyMap<string, S>;
}

export function emptyCommandJournal<S>(): CommandJournal<S> {
  return Object.freeze({ applied: new Map<string, S>() });
}

export interface CommandOutcome<S, I> {
  readonly state: S;
  readonly journal: CommandJournal<S>;
  readonly intents: readonly I[];
  readonly replayed: boolean;
}

export type Reducer<S, E, C, I> = (
  state: S,
  event: E,
  context: C,
) => Result<{ readonly state: S; readonly intents: readonly I[] }, Rejection>;

export function applyCommand<S, E, C, I>(
  reduce: Reducer<S, E, C, I>,
  journal: CommandJournal<S>,
  state: S,
  commandKey: string,
  event: E,
  context: C,
): Result<CommandOutcome<S, I>, Rejection> {
  const recorded = journal.applied.get(commandKey);
  if (recorded !== undefined) {
    return ok({ state: recorded, journal, intents: Object.freeze([]), replayed: true });
  }
  const result = reduce(state, event, context);
  if (!result.ok) {
    return result;
  }
  const applied = new Map(journal.applied);
  applied.set(commandKey, result.value.state);
  return ok({
    state: result.value.state,
    journal: Object.freeze({ applied }),
    intents: result.value.intents,
    replayed: false,
  });
}
