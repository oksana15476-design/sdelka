import { describe, expect, it } from 'vitest';
import { convert, convertAtRate, money, platformSpread } from '@sdelka/money';
import {
  accountBalance,
  bankNominal,
  checkLedgerInvariants,
  clientFreeAccount,
  coverage,
  fxExecution,
  openFxPositions,
} from '@sdelka/ledger';
import {
  advance,
} from '@sdelka/app';
import {
  convertBalance,
  executeBalanceConversion,
  receiveConvertedBalance,
  receiveExternalPayment,
  sendBalanceForConversion,
} from './support/acting';
import { openDeal } from './support/open';
import { CREATED_ON, DAY_MS, DEAL_AMOUNT_USD, FX_RATES, GEL, SELLER, BUYER, USD } from './support/fixtures';

/**
 * Сценарий 15 — покрытие в целевой валюте после конвертации.
 *
 * ## Дефект, который здесь закреплён
 *
 * До E14 конвертация была двумя записями, и нога встречной валюты повторяла
 * прежнюю форму целиком: номинальный счёт в лари дебетовался, счёт клиента
 * кредитовался — актив и обязательство под него создавала **одна и та же
 * запись**. Отношение покрытия в целевой валюте после такой конвертации
 * равнялось единице по построению записи, а не по факту денег: лари ни разу не
 * поступали извне, а `coverage` показывала 1/1 и пустой список нарушений.
 *
 * Проверка «покрытие сошлось» на такой записи не проверяла ничего. Здесь она
 * проверяется **прогоном**: моментов три, лари попадают на номинальный счёт
 * единственной записью M3, и у неё нет ноги, создающей обязательство.
 */
describe('конвертация и покрытие в целевой валюте', () => {
  it('не создаёт покрытие в целевой валюте одной записью с обязательством', async () => {
    const opened = await openDeal({
      dealId: 'deal-fx-coverage',
      trancheId: 'tranche-fx-coverage',
      buyer: BUYER,
      seller: SELLER,
    });
    let world = receiveExternalPayment(opened.world, opened.buyerKey, DEAL_AMOUNT_USD);
    const converted = convert(DEAL_AMOUNT_USD, FX_RATES, CREATED_ON, 'trunc');
    const execution = fxExecution('fx-coverage-1', converted);

    // --- M1: исходная валюта ушла контрагенту ---
    world = sendBalanceForConversion(world, opened.buyerKey, execution);
    expect(accountBalance(world.journal, bankNominal(USD), USD).minor).toBe(0n);

    // --- M2: обмен исполнен, обязательство переоформлено в лари ---
    world = executeBalanceConversion(world, opened.buyerKey, execution);
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(
      20_000_000n,
    );
    // ⚠ Вот он, момент истины: клиенту должны 20 000 000 тетри, а **на
    // номинальном счёте в лари ноль**. Прежняя двухзаписная форма показала бы
    // здесь полную сумму, потому что рисовала её сама.
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(0n);
    // Покрытие в этот промежуток всё ещё сходится: позиция лежит на клиентском
    // активе `fx:settlement:{k}`. Это честно названное ограничение — состояние
    // «встречная валюта не поставлена» не выражается ни отрицательным остатком,
    // ни покрытием, и ловит его только возраст позиции.
    expect(checkLedgerInvariants(world.journal)).toEqual([]);
    const open = openFxPositions(world.journal);
    expect(open).toHaveLength(1);
    expect(open[0]?.conversionId).toBe('fx-coverage-1');

    // --- M3: контрагент поставил лари ---
    const spread = platformSpread(converted, 'trunc');
    world = receiveConvertedBalance(world, opened.buyerKey, execution, spread);
    // Только теперь покрытие в лари обеспечено настоящими деньгами.
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);
    const gel = coverage(world.journal).find((item) => item.currency === GEL);
    expect(gel?.ratio).toEqual({ numerator: 1n, denominator: 1n });
    // Позиция обмена плоская: отдали, получили, требований нет.
    expect(openFxPositions(world.journal)).toEqual([]);
  });

  it('ловит испорченную сумму встречной ноги, а не принимает её как есть', async () => {
    const opened = await openDeal({
      dealId: 'deal-fx-tampered',
      trancheId: 'tranche-fx-tampered',
      buyer: BUYER,
      seller: SELLER,
    });
    let world = receiveExternalPayment(opened.world, opened.buyerKey, DEAL_AMOUNT_USD);
    const converted = convert(DEAL_AMOUNT_USD, FX_RATES, CREATED_ON, 'trunc');
    const execution = fxExecution('fx-tampered-1', converted);
    world = sendBalanceForConversion(world, opened.buyerKey, execution);
    world = executeBalanceConversion(world, opened.buyerKey, execution);

    // --- Первый контур: испорченное объявление не собирается вовсе ---
    // Курс лежит **на записи**, а не в аргументе вызова, которого потом нет.
    // Уменьшить встречную ногу, оставив курс, — это объявление, противоречащее
    // самому себе, и оно отвергается в момент сборки.
    expect(() =>
      fxExecution('fx-tampered-1', {
        ...converted,
        target: money(GEL, converted.target.minor - 1_000_000n),
      }),
    ).toThrow('ledger.entry.conversion_declaration_mismatch');

    // --- Второй контур: непротиворечивое, но **чужое** объявление ---
    // Контрагент поставил меньше, и объявил это честно — по тому же курсу, но
    // на меньшую сумму. Запись собирается: она согласована сама с собой. А
    // требование по обмену остаётся непогашенным, и позиция не становится
    // плоской: недопоставка видна как открытая позиция, а не растворяется в
    // покрытии.
    const partialSource = money(USD, DEAL_AMOUNT_USD.minor / 2n);
    const partial = fxExecution('fx-tampered-1', convert(partialSource, FX_RATES, CREATED_ON, 'trunc'));
    world = receiveConvertedBalance(
      world,
      opened.buyerKey,
      partial,
      platformSpread(partial.converted, 'trunc'),
    );
    const open = openFxPositions(world.journal);
    expect(open).toHaveLength(1);
    expect(open[0]?.conversionId).toBe('fx-tampered-1');
    // На номинальном счёте ровно то, что поставили, а не то, что обещали.
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(
      partial.converted.target.minor,
    );
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(
      converted.target.minor,
    );
  });

  it('не даёт объявить обмен по курсу, которого не было', () => {
    const converted = convert(DEAL_AMOUNT_USD, FX_RATES, CREATED_ON, 'trunc');
    // Встречная сумма обязана быть исходной, пересчитанной по **клиентскому**
    // курсу с усечением. Восстановить курс из двух сумм задним числом нельзя —
    // усечение необратимо, — поэтому он проверяется в момент объявления.
    expect(convertAtRate(converted.source, converted.rates.client, 'trunc').minor).toBe(
      converted.target.minor,
    );
    expect(() =>
      fxExecution('fx-wrong-rate', { ...converted, target: money(GEL, 1n) }),
    ).toThrow('ledger.entry.conversion_declaration_mismatch');
  });

  it('замечает зависший обмен по возрасту позиции, а не по покрытию', async () => {
    const opened = await openDeal({
      dealId: 'deal-fx-hanging',
      trancheId: 'tranche-fx-hanging',
      buyer: BUYER,
      seller: SELLER,
    });
    let world = receiveExternalPayment(opened.world, opened.buyerKey, DEAL_AMOUNT_USD);
    const converted = convert(DEAL_AMOUNT_USD, FX_RATES, CREATED_ON, 'trunc');
    const execution = fxExecution('fx-hanging-1', converted);
    world = sendBalanceForConversion(world, opened.buyerKey, execution);
    world = executeBalanceConversion(world, opened.buyerKey, execution);

    // Контрагент не поставил встречную валюту, и прошло трое суток.
    // Возраст обмена — это возраст **обмена**, а не последнего движения по
    // нему: момент 2 гасит одну ногу и открывает другую, и если считать по
    // проводке, отсчёт начинался бы заново с каждой записью.
    world = advance(world, 3 * DAY_MS);
    let hanging: unknown = null;
    try {
      receiveExternalPayment(world, opened.buyerKey, money(USD, 1_000n));
    } catch (error) {
      hanging = error;
    }
    expect(String(hanging)).toContain('ledger.invariant.fx_position_open');
  });

  it('не нетит позиции двух обменов одного клиента', async () => {
    const opened = await openDeal({
      dealId: 'deal-fx-two',
      trancheId: 'tranche-fx-two',
      buyer: BUYER,
      seller: SELLER,
    });
    let world = receiveExternalPayment(opened.world, opened.buyerKey, money(USD, 16_000_000n));

    // Первый обмен зависает после M2, второй проходит все три момента.
    const first = fxExecution('fx-two-a', convert(DEAL_AMOUNT_USD, FX_RATES, CREATED_ON, 'trunc'));
    world = sendBalanceForConversion(world, opened.buyerKey, first);
    world = executeBalanceConversion(world, opened.buyerKey, first);

    const second = convertBalance(
      world,
      opened.buyerKey,
      'fx-two-b',
      DEAL_AMOUNT_USD,
      FX_RATES,
      CREATED_ON,
    );
    world = second.world;

    // Ключ конверсии в коде счёта — единственное, что не даёт двум обменам
    // сложиться в один пул. Без него «сколько нам не поставили по этому
    // обмену» перестаёт быть величиной.
    const open = openFxPositions(world.journal);
    expect(open.map((item) => item.conversionId)).toEqual(['fx-two-a']);
  });
});
