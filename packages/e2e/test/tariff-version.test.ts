import { describe, expect, it } from 'vitest';
import { instant } from '@sdelka/domain';
import { settingsVersionId } from '@sdelka/settings';
import type { SettlementProjectionContext, TrancheSpec } from '@sdelka/app';
import { advance, trancheOf, trancheOptions } from '@sdelka/app';
import { rational } from '@sdelka/money';
import {
  type FeeBearing,
  bornByPayer,
  bornByRecipient,
  bornBySplit,
  tariffPlan,
  tariffSeries,
} from '@sdelka/pricing';
import {
  accountBalance,
  bankOperating,
  checkLedgerInvariants,
  clientFreeAccount,
  feePositions,
} from '@sdelka/ledger';
import { applyTrancheEvent } from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  BUYER,
  DAY_MS,
  GEL,
  POLICY_VERSION,
  SELLER,
  TARIFF_PLAN,
  TARIFF_VERSION_ID,
  tariffJournal,
  tariffVersionFor,
} from './support/fixtures';
import { openDeal } from './support/open';
import { toPayingOut } from './support/paths';

/**
 * Тариф на боевом пути: сумма и версия, по которой она посчитана, — одно
 * значение.
 *
 * **Что здесь проверяется прогоном, а не чтением.** `packages/pricing` был
 * построен и не звался ниоткуда: приложение клало `tariffVersionId` строкой
 * (`'tariff-2026-09-01'`), проверяемой только на отсутствие `:` и `|`, а
 * удержание брало из отдельного поля `deductions`. Две величины, обязанные
 * приходить из одной версии, приходили из разных мест — то есть «посчитать по
 * одной версии, а записать другую» было не ошибкой, а обычным вызовом, и ни
 * один тест этого не видел, потому что обе величины писал сам тест.
 *
 * Сегодня обе приходят из журнала версий, разрешённого **на момент создания
 * транша**, и проверить это можно только настоящим прогоном: сделка, транш,
 * деньги, условие, две подписи, выплата.
 *
 * ⚠ Числа тарифа здесь — фикстура, а не норма (`DECISIONS-REVIEW.md` §J1
 * **[открыто]**). Проверяется не «полтора процента», а то, что записанное
 * равно посчитанному.
 */

const SETTLED = trancheOptions(POLICY_VERSION, { payoutResponse: BANK_RESPONSE_SOURCE });

/** 1,5 % от 20 000 000 тетри — тариф версии `tariff/2026-09-01.1`. */
const FEE_AT_V1 = 300_000n;
/** 0,5 % от той же суммы — тариф второй версии. */
const FEE_AT_V2 = 100_000n;

const CHEAPER_PLAN = tariffPlan({ rateBp: 50, currency: GEL });

/**
 * Идентификатор второй версии. Строго больше первой: журнал сортируется
 * собственным ключом, и «более поздняя версия с меньшим идентификатором» —
 * отказ, а не порядок записи (`@sdelka/settings`, `versionIdOutOfOrder`).
 */
const SECOND_VERSION_ID = settingsVersionId('tariff/2026-09-05.1');

/** Момент записи отложенной версии: раньше, чем она вступает в силу. */
const RECORDED_BEFORE_NOW = instant(Date.UTC(2026, 8, 2, 9, 0, 0));

/**
 * Вторая версия, объявленная **вперёд**: записана 2 сентября, действует с 10-го.
 * Сценарий идёт 3 сентября, то есть между записью и вступлением в силу.
 */
const DEFERRED = tariffJournal(
  tariffVersionFor(TARIFF_PLAN),
  tariffVersionFor(
    CHEAPER_PLAN,
    SECOND_VERSION_ID,
    instant(Date.UTC(2026, 8, 10, 9, 0, 0)),
    TARIFF_VERSION_ID,
    RECORDED_BEFORE_NOW,
  ),
);

/** Та же вторая версия, но уже действующая к моменту сценария. */
const ALREADY_CHEAPER = tariffJournal(
  tariffVersionFor(TARIFF_PLAN),
  tariffVersionFor(CHEAPER_PLAN, SECOND_VERSION_ID, RECORDED_BEFORE_NOW, TARIFF_VERSION_ID),
);

describe('версия тарифа прилипает к созданию транша', () => {
  it('изменение тарифа, объявленное позже, не двигает уже заведённый транш', async () => {
    const TRANCHE = 'tranche-tariff-deferred';
    const opened = await openDeal({
      dealId: 'deal-tariff-deferred',
      trancheId: TRANCHE,
      buyer: BUYER,
      seller: SELLER,
      tariffs: DEFERRED,
    });

    const atCreation = trancheOf(opened.world, TRANCHE).tariff;
    expect(atCreation?.versionId).toBe(TARIFF_VERSION_ID);
    expect(atCreation?.fee.minor).toBe(FEE_AT_V1);

    // Время идёт, вторая версия наступает — и не трогает ничего: пересчитывать
    // не по чему, момент создания транша в прошлом.
    const later = advance(opened.world, 8 * DAY_MS);
    const afterChange = trancheOf(later, TRANCHE).tariff;
    expect(afterChange?.versionId).toBe(TARIFF_VERSION_ID);
    expect(afterChange?.fee.minor).toBe(FEE_AT_V1);
    // Тождество, на котором держится красная линия №2: брутто минус нетто —
    // это ровно комиссия, при любом плательщике.
    expect((afterChange?.required.minor ?? 0n) - (afterChange?.net.minor ?? 0n)).toBe(FEE_AT_V1);
  });

  it('транш, заведённый после изменения, считается по новой версии', async () => {
    const TRANCHE = 'tranche-tariff-new';
    const opened = await openDeal({
      dealId: 'deal-tariff-new',
      trancheId: TRANCHE,
      buyer: BUYER,
      seller: SELLER,
      tariffs: ALREADY_CHEAPER,
    });
    const tariff = trancheOf(opened.world, TRANCHE).tariff;
    expect(tariff?.fee.minor).toBe(FEE_AT_V2);
    expect(tariff?.versionId).toBe(SECOND_VERSION_ID);
  });

  it('запись начисления несёт ту же версию и ту же сумму, по которым посчитано', async () => {
    const TRANCHE = 'tranche-tariff-accrual';
    const path = await toPayingOut({
      dealId: 'deal-tariff-accrual',
      trancheId: TRANCHE,
      tariffs: DEFERRED,
    });
    const quoted = trancheOf(path.world, TRANCHE).tariff;

    const world = applyTrancheEvent(
      path.world,
      TRANCHE,
      { type: 'payout_result', outcome: 'settled' },
      SETTLED,
    ).world;
    const accrual = world.journal.entries.find(
      (entry) => entry.memoKey === 'ledger.entry.fee_accrued',
    );

    // Не «совпало с ожидаемым числом», а **равно посчитанному**: сравнивается
    // запись журнала с котировкой транша, а не обе с константой теста.
    expect(accrual?.accrues?.tariffVersionId).toBe(quoted?.versionId);
    expect(accrual?.accrues?.fee.minor).toBe(quoted?.fee.minor);
    expect(accrual?.accrues?.fee.minor).toBe(FEE_AT_V1);
  });
});

/**
 * Красная линия №2 на **боевом пути**, а не на конструкторе записи.
 *
 * `packages/pricing/test/postings.test.ts` уже проверяет тождество «брутто минус
 * нетто равно комиссии» на собранных вручную проводках. Здесь то же самое
 * проходит через весь контур: приложение выводит брутто транша из тарифа,
 * покупатель переводит именно его, автомат порождает намерение расчёта, и
 * комиссия покидает номинальный счёт **той же записью**. Плательщик комиссии до
 * этого батча не доезжал до боевого пути ни разу: удержание всегда несла сторона
 * получателя, потому что величины «кто платит» в приложении не существовало.
 */
describe('красная линия №2: комиссия уходит с номинального при любом плательщике', () => {
  const CASES: readonly (readonly [string, string, FeeBearing, bigint, bigint])[] = [
    ['несёт получатель', 'recipient', bornByRecipient(), 20_000_000n, 19_700_000n],
    ['несёт покупатель', 'payer', bornByPayer(), 20_300_000n, 20_000_000n],
    ['пополам', 'split', bornBySplit(5_000, 5_000), 20_150_000n, 19_850_000n],
  ];

  for (const [name, slug, bearing, gross, net] of CASES) {
    it(`${name}: брутто минус нетто равно комиссии, и комиссия в транзите`, async () => {
      const trancheId = `tranche-bearing-${slug}`;
      const path = await toPayingOut({
        dealId: `deal-bearing-${slug}`,
        trancheId,
        tariffs: tariffJournal(
          tariffVersionFor(tariffPlan({ rateBp: 150, currency: GEL, bearing })),
        ),
      });
      expect(trancheOf(path.world, trancheId).facts.requiredAmount.minor).toBe(gross);

      const world = applyTrancheEvent(
        path.world,
        trancheId,
        { type: 'payout_result', outcome: 'settled' },
        SETTLED,
      ).world;

      // Получатель получил нетто, разница ушла комиссией — ни тетри не осталось
      // «на потом» на номинальном счёте.
      expect(accountBalance(world.journal, clientFreeAccount(path.sellerKey), GEL).minor).toBe(net);
      expect(gross - net).toBe(FEE_AT_V1);
      const positions = feePositions(world.journal).find(
        (item) => item.deal.trancheId === trancheId,
      );
      expect(positions?.accrued.minor).toBe(FEE_AT_V1);
      expect(positions?.withheld.minor).toBe(FEE_AT_V1);
      // Комиссия в транзите, а не на номинальном и не на операционном:
      // межбанк идёт день-два, и утверждать обратное было бы враньём в проводке.
      expect(positions?.inTransit.minor).toBe(FEE_AT_V1);
      expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(0n);
      expect(checkLedgerInvariants(world.journal)).toEqual([]);
    });
  }
});

describe('«посчитал по одной версии, записал другую» перестало компилироваться', () => {
  /**
   * Проба типом, а не прогоном: подставить версию рядом с суммой больше некуда.
   * `@ts-expect-error` здесь и есть утверждение — если поле когда-нибудь
   * вернётся, директива станет лишней и `tsc` уронит типизацию пакета.
   */
  it('в спецификации транша нет ни ставки удержания, ни строки версии', () => {
    const spec: Partial<TrancheSpec> = {
      // @ts-expect-error версия тарифа больше не поле спецификации: её выдаёт
      // журнал версий на момент создания транша, и назвать её вызывающий не может
      tariffVersionId: 'tariff/2026-09-01.1',
    };
    const withRate: Partial<TrancheSpec> = {
      // @ts-expect-error ставка удержания тоже: она приходит версией плана,
      // а не рядом с ней
      deductions: [{ key: 'platform_fee', rate: rational(150n, 10_000n) }],
    };
    expect(Object.keys(spec)).toEqual(['tariffVersionId']);
    expect(Object.keys(withRate)).toEqual(['deductions']);
  });

  it('в контексте проекции расчёта версия и удержание — одно поле, а не два', () => {
    const context: Partial<SettlementProjectionContext> = {
      // @ts-expect-error версия отдельно от суммы в проекцию не передаётся
      tariffVersionId: 'tariff/2026-09-01.1',
    };
    expect(Object.keys(context)).toEqual(['tariffVersionId']);
  });
});

describe('умолчания нет: тариф, которого владелец не объявил, останавливает заведение транша', () => {
  it('пустой журнал версий — закрытый отказ, а не нулевая комиссия', async () => {
    await expect(
      openDeal({
        dealId: 'deal-tariff-absent',
        trancheId: 'tranche-tariff-absent',
        buyer: BUYER,
        seller: SELLER,
        tariffs: tariffSeries(),
      }),
    ).rejects.toThrow(/app\.tranche\.tariff_unresolved:.*no_version_in_effect/u);
  });

  it('версия, объявленная вперёд, к прошлому не применяется: транша нет', async () => {
    const onlyDeferred = tariffJournal(
      tariffVersionFor(TARIFF_PLAN, TARIFF_VERSION_ID, instant(Date.UTC(2026, 8, 20, 9, 0, 0))),
    );
    await expect(
      openDeal({
        dealId: 'deal-tariff-future',
        trancheId: 'tranche-tariff-future',
        buyer: BUYER,
        seller: SELLER,
        tariffs: onlyDeferred,
      }),
    ).rejects.toThrow(/app\.tranche\.tariff_unresolved:.*no_version_in_effect/u);
  });
});
