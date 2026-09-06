import {
  DEFAULT_FEE_CEILING,
  LedgerError,
  LedgerErrorCode,
  accountBalance,
  clientFreeAccount,
} from '@sdelka/ledger';
import { PricingError, PricingErrorCode, tariffPlan } from '@sdelka/pricing';
import { feeCeilingPolicy } from '@sdelka/domain';
import {
  trancheOf,
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
 * выплата. Удержание считает проекция расчёта из тарифа транша — версии плана,
 * действовавшей в момент его создания (`TARIFF_SERIES`, 1,5 % — 300 000 из
 * 20 000 000 тетри).
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

  /**
   * ⚠ **Эта проба изменилась вместе с подключением журнала версий тарифа, и
   * изменение названо вслух.** Прежде она заводила транш с удержанием 5 % и
   * объявленным потолком в единицу и проверяла, что запись расчёта не
   * послушалась объявления. Сегодня ставка приходит **версией тарифного плана**
   * (`@sdelka/pricing`), а план с пятипроцентной ставкой не собирается вовсе:
   * потолок плана сам сужен до жёстких двух процентов учёта, и ставка выше него
   * отвергается на записи настройки, а не на живом транше. То есть проба «5 %
   * дошли до записи» стала невыразимой — не потому, что правило ослабили, а
   * потому, что запрет переехал на рубеж раньше.
   *
   * Свойство при этом проверяется двумя половинами, и обе здесь:
   *
   *  1. пятипроцентный план не существует как величина — отказ конструктора;
   *  2. объявленный траншем потолок в единицу не расширяет предел версии:
   *     на транше остаётся потолок плана, а не объявленный.
   *
   * Третья половина — та же дисциплина на самой записи учёта, куда величина
   * может прийти из хранилища мимо конструктора, — стоит в
   * `packages/ledger/test/fee-ceiling.test.ts` («объявленный потолок только
   * сужает предел, но не расширяет его»).
   */
  it('объявленный потолок в единицу ничего не разрешает: ни плану, ни траншу', async () => {
    // (1) Величины не существует: ставка выше потолка того же плана.
    let raised: unknown = null;
    try {
      tariffPlan({ rateBp: 500, currency: GEL, ceiling: EVERYTHING });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(PricingError);
    expect((raised as PricingError).code).toBe(PricingErrorCode.rateAboveCeiling);

    // (2) Объявление траншем ничего не расширяет: на транше остаётся потолок
    // версии плана — жёсткие два процента, а не объявленная единица.
    const path = await toPayingOut({
      dealId: 'deal-ceiling-wide',
      trancheId: 'tranche-ceiling-wide',
      feeCeilingPolicy: EVERYTHING,
    });
    expect(trancheOf(path.world, 'tranche-ceiling-wide').facts.feeCeilingPolicy).toEqual(
      DEFAULT_FEE_CEILING,
    );
    // И расчёт идёт по тарифу версии — 1,5 %, а не «удержать можно всё».
    const world = applyTrancheEvent(
      path.world,
      'tranche-ceiling-wide',
      { type: 'payout_result', outcome: 'settled' },
      SETTLED,
    ).world;
    expect(accountBalance(world.journal, clientFreeAccount(path.sellerKey), GEL).minor).toBe(
      19_700_000n,
    );
  });
});
