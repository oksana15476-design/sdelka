import { type JournalEntry } from './entry';
import { LedgerError, LedgerErrorCode } from './errors';

/**
 * Журнал только дополняется. Изменяющих операций нет ни одной — ни в типе, ни в
 * модуле: `appendEntry` возвращает новый журнал (красная линия №11).
 */
export interface Journal {
  readonly entries: readonly JournalEntry[];
}

export const emptyJournal: Journal = Object.freeze({ entries: Object.freeze([]) });

export function appendEntry(journal: Journal, entry: JournalEntry): Journal {
  if (journal.entries.some((existing) => existing.id === entry.id)) {
    throw new LedgerError(LedgerErrorCode.journalDuplicateEntryId, { id: entry.id });
  }
  // Красная линия №11: исправление — новая запись **со ссылкой на предыдущую**.
  // Ссылка на запись, которой в журнале нет, ссылкой не является: она снимает
  // с исправления все ограничения обычной записи, не давая взамен ни следа, ни
  // возможности сверить одно с другим. Конструктор записи журнала не видит —
  // проверка стоит здесь, где журнал есть.
  if (entry.correctsEntryId !== null) {
    if (!journal.entries.some((existing) => existing.id === entry.correctsEntryId)) {
      throw new LedgerError(LedgerErrorCode.journalCorrectionTargetMissing, {
        id: entry.id,
        correctsEntryId: entry.correctsEntryId,
      });
    }
  }
  return Object.freeze({ entries: Object.freeze([...journal.entries, entry]) });
}

export function appendEntries(journal: Journal, entries: readonly JournalEntry[]): Journal {
  return entries.reduce(appendEntry, journal);
}
