import { LedgerError, LedgerErrorCode, accountBalance, clientFreeAccount } from '@sdelka/ledger';
import { feeCeilingPolicy } from '@sdelka/domain';
import {
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  applyTrancheEvent,
} from './support/acting';
import { rational } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import { BANK_RESPONSE_SOURCE, GEL, POLICY_VERSION } from './support/fixtures';
import { toPayingOut } from './support/paths';

/**
 * Политика транша доезжает до записи расчёта (эпик E16, `CORE.md` Ф11).
 *
 * **Что здесь проверяется прогоном, а не чтением.** Жёсткий предел учёта (два
 * процента) стоит на записи расчёта с прошлого батча и обойти его нечем. Но
 * предел **конкретного транша** — величина домена: она лежит в фактах
 * (`TrancheFacts.feeCeilingPolicy`), считается в момент решения и обязана
 * доехать до записи. Пока она не доезжала, тариф в 1,5 % проходил по траншу,
 * которому владелец назначил один процент: запись собиралась, сходилась
 * повалютно и не поднимала ни одного инварианта — потому что мерилась чужим,
 * более широким пределом.
 *
 * Сценарий идёт настоящим путём: сделка, транш, деньги, условие, две подписи,
 * выплата. Удержание считает проекция расчёта из удержаний транша
 * (`PLATFORM_FEE`, 1,5 % — 300 000 из 20 000 000 тетри).
 */
const SETTLED = trancheOptions(POLICY_VERSION, { payoutResponse: BANK_RESPONSE_SOURCE });

/** Один процент: строже жёсткого предела учёта и строже тарифа фикстуры. */
const ONE_PERCENT = feeCeilingPolicy(rational(1n, 100n));
/** Потолок в единицу: «удержать можно всё». Запись обязана его не послушать. */
const EVERYTHING = feeCeilingPolicy(rational(1n, 1n));

function expectLedgerCode(run: () => unknown, code: string): void {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
  }
}

describe('потолок удержания транша доезжает до записи расчёта', () => {
  it('роняет расчёт, укладывающийся в жёсткие два процента, но не в политику транша', async () => {
    const path = await toPayingOut({
      dealId: 'deal-ceiling-strict',
      trancheId: 'tranche-ceiling-strict',
      feeCeilingPolicy: ONE_PERCENT,
    });
    // 300 000 из 20 000 000 — это 1,5 %: жёсткий предел учёта такую запись
    // пропускает, политика транша — нет. Без проводки политики от фактов до
    // `trancheSettlement` этот вызов проходит молча.
    expectLedgerCode(
      () =>
        applyTrancheEvent(
          path.world,
          'tranche-ceiling-strict',
          { type: 'payout_result', outcome: 'settled' },
          SETTLED,
        ),
      LedgerErrorCode.entryFeeExceedsCeiling,
    );
  });

  it('тот же тариф по траншу без своей политики проходит', async () => {
    // Контроль: правило обязано ловить именно расхождение с политикой транша, а
    // не останавливать живой продукт. Умолчание — жёсткие два процента.
    const path = await toPayingOut({
      dealId: 'deal-ceiling-default',
      trancheId: 'tranche-ceiling-default',
    });
    const world = applyTrancheEvent(
      path.world,
      'tranche-ceiling-default',
      { type: 'payout_result', outcome: 'settled' },
      SETTLED,
    ).world;
    expect(trancheStatusOf(world, 'tranche-ceiling-default')).toBe('paid_out');
    expect(accountBalance(world.journal, clientFreeAccount(path.sellerKey), GEL).minor).toBe(
      19_700_000n,
    );
  });

  it('политика транша только сужает: объявленный потолок в единицу ничего не разрешает', async () => {
    const path = await toPayingOut({
      dealId: 'deal-ceiling-wide',
      trancheId: 'tranche-ceiling-wide',
      feeCeilingPolicy: EVERYTHING,
      // 5 % — сверх жёсткого предела учёта. Транш объявил, что удержать можно
      // всё; запись обязана считать по строжайшему из двух.
      deductions: [{ key: 'platform_fee', rate: rational(500n, 10_000n) }],
    });
    expectLedgerCode(
      () =>
        applyTrancheEvent(
          path.world,
          'tranche-ceiling-wide',
          { type: 'payout_result', outcome: 'settled' },
          SETTLED,
        ),
      LedgerErrorCode.entryFeeExceedsCeiling,
    );
  });
});
