import {
  type CompliancePolicy,
  type QueuePolicy,
  type ReviewTask,
  POLICY_2026_09_03,
  escalatedTasks,
  escalationLevel,
} from '@sdelka/compliance';
import { type Instant, HOUR } from '@sdelka/domain';
import {
  type IntakePolicy,
  type ToleranceDisclosure,
  type TolerancePolicy,
  INTAKE_REASON_KEYS,
  IntakeError,
  PROPOSED_INTAKE_POLICY,
  effectiveTolerance,
  toleranceFor,
} from '@sdelka/intake';
import { type CurrencyCode, type Money, money } from '@sdelka/money';
import { SETTINGS_REFUSAL_KEYS } from '@sdelka/settings';
import { describe, expect, it } from 'vitest';
import {
  type AmountTolerance,
  type AmountToleranceSeries,
  type DealCurrenciesSeries,
  type QueueAgeSeries,
  LIMITS_REFUSAL_KEYS,
  LimitsError,
  PROVISIONAL_AMOUNT_TOLERANCE,
  PROVISIONAL_QUEUE_AGE_BANDS,
  amountTolerance,
  amountToleranceSeries,
  amountToleranceSeriesFromStore,
  compliancePolicyAt,
  dealCurrenciesSeriesFromStore,
  dealCurrencyAdmittedAt,
  dealCurrencyList,
  intakePolicyAtDisclosure,
  queueAgeBands,
  queueAgeSeries,
  queueAgeSeriesFromStore,
  queuePolicyAt,
  tolerancePolicyAtDisclosure,
} from '../src/index';
import { at, version } from './support/fixtures';

/**
 * Подключение величин периметра к боевому пути: допуск считает приём, уровень
 * эскалации — комплаенс, а величина приходит к ним **версией из журнала**, а не
 * константой.
 *
 * Проба этого файла одна: подстановка ничего не считает и ничего не проверяет
 * заново. Всё, что здесь утверждается о деньгах, посчитано настоящими
 * `toleranceFor`/`effectiveTolerance` и настоящими `escalationLevel`/
 * `escalatedTasks` — вторых их редакций у подключения нет, и сети с моком
 * провайдера здесь нет ни одной.
 */

const DOC = 'docs/product/SETTINGS.md';

/* ------------------------------------------------------------------------- */
/* Формы значений совпадают поле в поле                                      */
/* ------------------------------------------------------------------------- */

/**
 * Проверка **компилятором**, а не утверждением: величина настройки годится на
 * место политики приёма, и наоборот. Заведёт приём в допуске новое поле —
 * сломается эта строка, а не расчёт на боевом пути.
 */
const TOLERANCE_AS_INTAKE: TolerancePolicy = PROVISIONAL_AMOUNT_TOLERANCE;
const TOLERANCE_AS_LIMITS: AmountTolerance = PROPOSED_INTAKE_POLICY.tolerance;
/**
 * Границы очереди годятся на место политики очереди. Обратного присваивания
 * здесь нет намеренно: `QueueAgeBands` несёт сверх `QueuePolicy` ссылку на
 * обоснование, и требовать её от комплаенса значило бы тащить в него настройку.
 */
const BANDS_AS_QUEUE: QueuePolicy = PROVISIONAL_QUEUE_AGE_BANDS;

describe('временные значения — те же числа, что лежали константами', () => {
  it('допуск: доля и абсолют совпадают с политикой приёма', () => {
    expect(TOLERANCE_AS_INTAKE.shareBp).toBe(PROPOSED_INTAKE_POLICY.tolerance.shareBp);
    const asPairs = (items: readonly Money<CurrencyCode>[]): readonly string[] =>
      [...items].map((item) => `${item.currency}:${item.minor}`).sort();
    expect(asPairs(TOLERANCE_AS_INTAKE.absolute)).toEqual(
      asPairs(TOLERANCE_AS_LIMITS.absolute),
    );
  });

  it('границы очереди совпадают с политикой комплаенса', () => {
    expect([...BANDS_AS_QUEUE.escalationAfter]).toEqual([
      ...POLICY_2026_09_03.queue.escalationAfter,
    ]);
    expect(BANDS_AS_QUEUE.rankCurrency).toBe(POLICY_2026_09_03.queue.rankCurrency);
  });
});

/* ------------------------------------------------------------------------- */
/* Журналы                                                                   */
/* ------------------------------------------------------------------------- */

const WIDE = amountTolerance({
  absolute: [money('GEL', 5_000n), money('USD', 2_000n)],
  shareBp: 50,
  rationaleDocRef: DOC,
});

/** Доллар из допуска убран вместе с валютой: после десятого часа объявлен только лари. */
const GEL_ONLY = amountTolerance({
  absolute: [money('GEL', 5_000n)],
  shareBp: 50,
  rationaleDocRef: DOC,
});

function toleranceNarrowedAtTen(): AmountToleranceSeries {
  const built = amountToleranceSeriesFromStore([
    version({
      id: 'amount_tolerance/2026-09-04.1',
      value: WIDE,
      recordedAt: at(0),
      effectiveFrom: at(0),
      supersedes: null,
    }),
    version({
      id: 'amount_tolerance/2026-09-04.2',
      value: GEL_ONLY,
      recordedAt: at(10),
      effectiveFrom: at(10),
      supersedes: 'amount_tolerance/2026-09-04.1',
    }),
  ]);
  if (!built.ok) throw new Error(built.error);
  return built.value;
}

function currenciesWithdrawnAtTen(): DealCurrenciesSeries {
  const built = dealCurrenciesSeriesFromStore([
    version({
      id: 'deal_currencies/2026-09-04.1',
      value: dealCurrencyList(['GEL', 'USD']),
      recordedAt: at(0),
      effectiveFrom: at(0),
      supersedes: null,
    }),
    version({
      id: 'deal_currencies/2026-09-04.2',
      value: dealCurrencyList(['GEL']),
      recordedAt: at(10),
      effectiveFrom: at(10),
      supersedes: 'deal_currencies/2026-09-04.1',
    }),
  ]);
  if (!built.ok) throw new Error(built.error);
  return built.value;
}

function queueTightenedAtTen(): QueueAgeSeries {
  const built = queueAgeSeriesFromStore([
    version({
      id: 'queue_age/2026-09-04.1',
      value: queueAgeBands({
        escalationAfterMs: [4 * HOUR, 24 * HOUR, 72 * HOUR],
        rankCurrency: 'GEL',
        rationaleDocRef: DOC,
      }),
      recordedAt: at(0),
      effectiveFrom: at(0),
      supersedes: null,
    }),
    version({
      id: 'queue_age/2026-09-04.2',
      value: queueAgeBands({
        escalationAfterMs: [1 * HOUR, 4 * HOUR],
        rankCurrency: 'GEL',
        rationaleDocRef: DOC,
      }),
      recordedAt: at(10),
      effectiveFrom: at(10),
      supersedes: 'queue_age/2026-09-04.1',
    }),
  ]);
  if (!built.ok) throw new Error(built.error);
  return built.value;
}

/* ------------------------------------------------------------------------- */
/* Допуск: версия момента раскрытия — та, что применится к платежу            */
/* ------------------------------------------------------------------------- */

const USD_REQUIRED: Money<CurrencyCode> = money('USD', 1_000_000n);

function policyAt(disclosedAt: Instant): IntakePolicy {
  const resolved = intakePolicyAtDisclosure(
    PROPOSED_INTAKE_POLICY,
    toleranceNarrowedAtTen(),
    disclosedAt,
  );
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
}

/** Факт раскрытия: величина и версия — те, что показаны стороне до платежа. */
function disclosureUnder(policy: IntakePolicy, disclosedAt: Instant): ToleranceDisclosure {
  const byPolicy = toleranceFor(USD_REQUIRED, policy);
  if (byPolicy.kind !== 'declared') throw new Error(byPolicy.kind);
  return Object.freeze({
    dealId: 'deal-1',
    trancheId: 'tranche-1',
    requiredAmount: USD_REQUIRED,
    tolerance: byPolicy.amount,
    policyVersionId: policy.version,
    disclosedAt,
  });
}

describe('допуск: версия, действовавшая в момент раскрытия, применяется к этому платежу', () => {
  it('раскрыто под первой версией — платёж после сужения считается ею же', () => {
    const policy = policyAt(at(2));
    const disclosure = disclosureUnder(policy, at(2));

    // 50 б.п. от 10 000,00 = 50,00; абсолют 20,00 — берётся меньшее.
    expect(disclosure.tolerance.minor).toBe(2_000n);

    const effective = effectiveTolerance(USD_REQUIRED, policy, disclosure, at(11));
    expect(effective.amount.minor).toBe(2_000n);
    expect(effective.reasons).toEqual([INTAKE_REASON_KEYS.toleranceApplied]);
  });

  it('версия допуска и идентификатор политики подставляются вместе, а не порознь', () => {
    const early = policyAt(at(2));
    const late = policyAt(at(11));
    expect(early.version).toBe('intake/2026-09-04.1');
    expect(late.version).toBe('intake/2026-09-04.2');

    // ⚠ Пространство имён приёма общее: выведенный из версии настройки
    // идентификатор совпал здесь с рукописным идентификатором
    // `PROPOSED_INTAKE_POLICY`. Совпадение не подстроено — оно и есть развилка
    // `DECISIONS-REVIEW.md` §K6 **[открыто]**, и эта строка о ней напоминает.
    expect(early.version).toBe(PROPOSED_INTAKE_POLICY.version);

    // Раскрытие сделано под первой версией, а политика взята позднейшая:
    // расхождение обязано **называться** оператору, а не пропасть. Если бы
    // идентификатор остался константным, здесь стояло бы «версия та же» — сумма
    // сошлась бы, а объяснение соврало.
    const disclosure = disclosureUnder(early, at(2));
    const effective = effectiveTolerance(USD_REQUIRED, late, disclosure, at(11));
    expect(effective.reasons).toContain(INTAKE_REASON_KEYS.toleranceDisclosureOlderPolicy);
  });

  it('третья версия, легшая сверху, не переписывает уже разрешённый момент', () => {
    const before = policyAt(at(2));
    const grown = amountToleranceSeriesFromStore([
      ...toleranceNarrowedAtTen().versions,
      version({
        id: 'amount_tolerance/2026-09-04.3',
        value: WIDE,
        recordedAt: at(20),
        effectiveFrom: at(20),
        supersedes: 'amount_tolerance/2026-09-04.2',
      }),
    ]);
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;

    const after = intakePolicyAtDisclosure(PROPOSED_INTAKE_POLICY, grown.value, at(2));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.version).toBe(before.version);
    expect(after.value.tolerance).toEqual(before.tolerance);
  });
});

describe('умолчания нет: без версии политика приёма не собирается вовсе', () => {
  it('пустой журнал допуска — отказ, а не константа из кода', () => {
    const resolved = intakePolicyAtDisclosure(
      PROPOSED_INTAKE_POLICY,
      amountToleranceSeries(),
      at(2),
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toBe(SETTINGS_REFUSAL_KEYS.noVersionInEffect);
  });

  it('момент раньше первой версии не берёт ни первую, ни сегодняшнюю', () => {
    const resolved = tolerancePolicyAtDisclosure(toleranceNarrowedAtTen(), at(-1));
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toBe(SETTINGS_REFUSAL_KEYS.noVersionInEffect);
  });

  it('пустой журнал границ очереди — отказ, а не «эскалации нет»', () => {
    const resolved = compliancePolicyAt(POLICY_2026_09_03, queueAgeSeries(), at(2));
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toBe(SETTINGS_REFUSAL_KEYS.noVersionInEffect);
  });
});

/* ------------------------------------------------------------------------- */
/* Выключение валюты действует только на новые сделки                        */
/* ------------------------------------------------------------------------- */

describe('выключение валюты не трогает уже заведённые сделки — через боевой путь', () => {
  it('сделка от первого часа получает свой долларовый допуск и после выключения', () => {
    const currencies = currenciesWithdrawnAtTen();
    const dealCreatedAt = at(1);

    const admitted = dealCurrencyAdmittedAt(currencies, dealCreatedAt, 'USD');
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value.versionId).toBe('deal_currencies/2026-09-04.1');

    // Обе величины прилипли к своим моментам: перечень — к созданию сделки,
    // допуск — к раскрытию. После десятого часа доллара нет ни в перечне, ни в
    // допуске, и обе правки этой сделки не касаются.
    const policy = policyAt(at(2));
    const disclosure = disclosureUnder(policy, at(2));
    const effective = effectiveTolerance(USD_REQUIRED, policy, disclosure, at(11));
    expect(effective.amount.currency).toBe('USD');
    expect(effective.amount.minor).toBe(2_000n);
    expect(effective.reasons).toEqual([INTAKE_REASON_KEYS.toleranceApplied]);
  });

  it('новая сделка в выключенной валюте не заводится', () => {
    const fresh = dealCurrencyAdmittedAt(currenciesWithdrawnAtTen(), at(11), 'USD');
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) {
      expect(fresh.error).toBe(LIMITS_REFUSAL_KEYS.currencyNotAdmittedAtDealCreation);
    }
  });

  it('спросить допуск на момент платежа, а не раскрытия, — потерять его целиком', () => {
    // Ровно та ошибка, ради которой момент прилипания задан типом: у политики,
    // разрешённой на одиннадцатый час, доллара нет вовсе, и допуск, обещанный
    // стороне, схлопнулся бы в ноль.
    const disclosure = disclosureUnder(policyAt(at(2)), at(2));
    const wrong = effectiveTolerance(USD_REQUIRED, policyAt(at(11)), disclosure, at(11));
    expect(wrong.amount.minor).toBe(0n);
    expect(wrong.reasons).toContain(INTAKE_REASON_KEYS.toleranceCurrencyNotDeclared);
  });
});

/* ------------------------------------------------------------------------- */
/* Очередь: ужесточение действует сразу                                      */
/* ------------------------------------------------------------------------- */

function task(enteredAt: Instant): ReviewTask {
  return Object.freeze({
    taskId: 'task-1',
    kind: 'intake_unmatched',
    dealId: 'deal-1',
    trancheId: 'tranche-1',
    partyId: null,
    withdrawalId: null,
    rankAmount: money('GEL', 10_000_000n),
    enteredAt,
    deadlineAt: null,
    severity: 'hold',
    assigneeId: null,
    policyVersionId: POLICY_2026_09_03.version,
  });
}

function queuePolicyResolvedAt(observedAt: Instant): CompliancePolicy {
  const resolved = compliancePolicyAt(POLICY_2026_09_03, queueTightenedAtTen(), observedAt);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
}

describe('границы очереди не прилипают: ужесточение поднимает уже стоящие задачи', () => {
  it('задача, стоящая два часа, эскалирована по новым границам и не эскалирована по прежним', () => {
    const standing = task(at(9));
    const now = at(11);

    const tightened = queuePolicyResolvedAt(now);
    expect(escalationLevel(standing, now, tightened.queue)).toBe(1);
    expect(escalatedTasks([standing], tightened.queue, now)).toHaveLength(1);

    // Разница именно в версии, а не в возрасте: тот же возраст по границам,
    // действовавшим до ужесточения, норматива не перешагивает.
    const previous = queuePolicyAt(queueTightenedAtTen(), at(9));
    expect(previous.ok).toBe(true);
    if (!previous.ok) return;
    expect(escalationLevel(standing, now, previous.value.queue)).toBe(0);
  });

  it('уровень, назначенный вчерашнему наблюдению, вчерашней версией и остаётся', () => {
    const yesterday = queuePolicyAt(queueTightenedAtTen(), at(9));
    expect(yesterday.ok).toBe(true);
    if (!yesterday.ok) return;
    expect(yesterday.value.versionId).toBe('queue_age/2026-09-04.1');
    expect([...yesterday.value.queue.escalationAfter][0] as number).toBe(4 * HOUR);
  });

  it('версия решения не подменяется версией границ', () => {
    // `CompliancePolicy.version` называет политику, принявшую решение; границы
    // очереди ни одного решения не принимают. Их версия возвращается рядом.
    const resolved = compliancePolicyAt(POLICY_2026_09_03, queueTightenedAtTen(), at(11));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.version).toBe(POLICY_2026_09_03.version);
    const bands = queuePolicyAt(queueTightenedAtTen(), at(11));
    expect(bands.ok).toBe(true);
    if (!bands.ok) return;
    expect(bands.value.versionId).toBe('queue_age/2026-09-04.2');
  });
});

/* ------------------------------------------------------------------------- */
/* Подстановка — это подстановка                                             */
/* ------------------------------------------------------------------------- */

describe('второго места проверки подключение не завело', () => {
  it('негодная величина отвергается на записи настройки', () => {
    expect(() =>
      amountTolerance({ absolute: [money('GEL', 5_000n)], shareBp: 10_001, rationaleDocRef: DOC }),
    ).toThrow(LimitsError);
    expect(() =>
      queueAgeBands({ escalationAfterMs: [], rankCurrency: 'GEL', rationaleDocRef: DOC }),
    ).toThrow(LimitsError);
  });

  it('значение уходит в расчёт тем же объектом: подстановка ничего не пересобирает', () => {
    const series = toleranceNarrowedAtTen();
    const applied = tolerancePolicyAtDisclosure(series, at(2));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.tolerance).toBe(series.versions[0]?.value);

    const queue = queueTightenedAtTen();
    const bands = queuePolicyAt(queue, at(11));
    expect(bands.ok).toBe(true);
    if (!bands.ok) return;
    expect(bands.value.queue).toBe(queue.versions[1]?.value);
  });

  it('величина, обошедшая конструктор, не проходит молча — расчёт отказывает громко', () => {
    // Собрать такую величину законным путём нельзя: `amountTolerance` бросает.
    // Приведение типом изображает единственный оставшийся путь — испорченную
    // запись из хранилища. Подстановка её не чинит и не глотает: до денег она
    // доезжает исключением, а не посчитанной суммой.
    const smuggled = { ...WIDE, shareBp: 10_001 } as AmountTolerance;
    const built = amountToleranceSeriesFromStore([
      version({
        id: 'amount_tolerance/2026-09-04.1',
        value: smuggled,
        recordedAt: at(0),
        effectiveFrom: at(0),
        supersedes: null,
      }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const policy = intakePolicyAtDisclosure(PROPOSED_INTAKE_POLICY, built.value, at(2));
    expect(policy.ok).toBe(true);
    if (!policy.ok) return;
    expect(policy.value.tolerance.shareBp).toBe(10_001);
    expect(() => toleranceFor(USD_REQUIRED, policy.value)).toThrow(IntakeError);
  });
});
