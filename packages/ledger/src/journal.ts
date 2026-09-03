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
  return Object.freeze({ entries: Object.freeze([...journal.entries, entry]) });
}

export function appendEntries(journal: Journal, entries: readonly JournalEntry[]): Journal {
  return entries.reduce(appendEntry, journal);
}
