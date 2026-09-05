import {
  accountBalance,
  appendEntry,
  bankNominal,
  checkLedgerInvariants,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  coverage,
  createJournalEntry,
  credit,
  debit,
  shouldStopAcceptingDeals,
  transitWriteoff,
  unclaimedLiability,
} from '@sdelka/ledger';
import { trancheOptions, trancheStatusOf } from '@sdelka/app';
import { describe, expect, it } from 'vitest';
import { applyTrancheEvent } from './support/acting';
import { DEAL_AMOUNT, GEL, POLICY_VERSION } from './support/fixtures';
import { toReserved } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION, { taskKind: 'source_of_funds' });
const DEAL = 'deal-correction-mirror';
const TRANCHE = 'tranche-correction-mirror';
/** Постороннее лицо: к сделке отношения не имеет ни в какой роли. */
const STRANGER = clientKey('c-stranger');

/**
 * Сценарий 17-бис — та же выдача содержимого терминального пула, но **под
 * видом исправления**.
 *
 * `write-off.test.ts` закрепляет обе формы этой атаки записью типа
 * `settlement`: их отвергает `assertNoPayoutFromTerminalPool`. Форма с
 * `kind: 'correction'` не была покрыта нигде — а именно её проверка и
 * пропускала целиком, потому что у исправления «есть ссылка, то есть след».
 * Ссылка при этом сверялась только на существование цели: ни владельца, ни
 * сумм, ни отношения цели к делу.
 *
 * Прогон до правки (реальные пакеты, без моков): после законных
 * `top_up → reserve → write_off` запись ниже принималась, и `client:{Z}:free`
 * получал все 200 000 ₾ транша при покрытии 1/1, пустом
 * `checkLedgerInvariants()` и молчащем стоп-кране.
 */
describe('исправление не выносит невостребованные средства из пула', () => {
  it('отвергает выдачу постороннему лицу и оставляет журнал нетронутым', async () => {
    const reserved = await toReserved({ dealId: DEAL, trancheId: TRANCHE });
    let world = applyTrancheEvent(
      reserved.world,
      TRANCHE,
      { type: 'mismatch_detected', field: 'payer.unreachable' },
      OPTIONS,
    ).world;
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'write_off_approved', userIds: ['operator-2', 'operator-3'] },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('written_off');
    expect(accountBalance(world.journal, unclaimedLiability, GEL).minor).toBe(DEAL_AMOUNT.minor);

    // Запись, которую нечем отличить от отмены списания по одной себе: она
    // сбалансирована, кастодиан едет вместе с обязательством, пофайловый
    // прирост ровно нулевой. Отличает её только цель, которой она себя
    // объявляет: ни этого счёта, ни этого файла цель не трогала.
    const payout = (id: string, correctsEntryId: string) =>
      createJournalEntry({
        id,
        occurredAt: new Date(world.now).toISOString(),
        kind: 'correction',
        correctsEntryId,
        memoKey: 'ledger.entry.illegal',
        postings: [
          debit(unclaimedLiability, DEAL_AMOUNT),
          credit(clientFreeAccount(STRANGER), DEAL_AMOUNT, { clientKey: STRANGER }),
          credit(transitWriteoff, DEAL_AMOUNT),
          debit(bankNominal(GEL), DEAL_AMOUNT, { clientKey: STRANGER }),
        ],
      });

    const writeOff = world.journal.entries.find(
      (entry) => entry.memoKey === 'ledger.entry.unclaimed',
    );
    expect(writeOff, 'списание обязано лежать в журнале').toBeDefined();
    const first = world.journal.entries[0];
    expect(first).toBeDefined();

    // Цель — само списание: форма отвергнута, хотя два счёта из четырёх с целью
    // и сходятся.
    expect(() => appendEntry(world.journal, payout('unclaimed-undo', writeOff?.id ?? ''))).toThrow(
      'ledger.journal.correction_not_mirror',
    );
    // Цель — посторонняя запись журнала: та же ошибка, а не «цели нет».
    expect(() => appendEntry(world.journal, payout('unclaimed-alibi', first?.id ?? ''))).toThrow(
      'ledger.journal.correction_not_mirror',
    );
    // Цели не существует вовсе — это другое нарушение и другой ключ.
    expect(() => appendEntry(world.journal, payout('unclaimed-void', 'no-such-entry'))).toThrow(
      'ledger.journal.correction_target_missing',
    );

    // Журнал не тронут: деньги остались в пуле, у постороннего лица ничего не
    // появилось, стоп-кран молчит по праву.
    expect(accountBalance(world.journal, clientFreeAccount(STRANGER), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, unclaimedLiability, GEL).minor).toBe(DEAL_AMOUNT.minor);
    expect(
      accountBalance(world.journal, clientLockedAccount(reserved.buyerKey, DEAL, TRANCHE), GEL)
        .minor,
    ).toBe(0n);
    expect(coverage(world.journal).find((item) => item.currency === GEL)?.covered).toBe(true);
    expect(checkLedgerInvariants(world.journal)).toEqual([]);
    expect(shouldStopAcceptingDeals(world.journal)).toBe(false);
  });
});
