import type { JournalEntry, JournalEntryInput } from '../../src/index';

/**
 * Запись в обход `createJournalEntry`.
 *
 * После запрета красной линии №1 на построении записи (FUNCTIONAL.md §3.1)
 * проводку «дебет обязательства одной сделки, кредит номинального счёта,
 * отнесённого к другой» через конструктор собрать нельзя. Второй контур —
 * отчёт о покрытии и проверка инвариантов — обязан видеть такое состояние всё
 * равно: журнал приходит из базы, в том числе с записями, сделанными до
 * появления проверки, и в том числе испорченный.
 *
 * Поэтому помощник живёт в тестах и используется только там, где проверяется
 * именно обнаружение уже существующего расхождения.
 */
export function uncheckedEntry(input: JournalEntryInput): JournalEntry {
  return Object.freeze({
    id: input.id,
    occurredAt: input.occurredAt,
    kind: input.kind,
    postings: Object.freeze([...input.postings]),
    memoKey: input.memoKey,
    correctsEntryId: input.correctsEntryId ?? null,
    settles: input.settles ?? null,
    converts: input.converts ?? null,
    accrues: input.accrues ?? null,
    funds: input.funds ?? null,
  });
}
