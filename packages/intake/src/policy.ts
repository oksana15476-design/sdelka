import type { DurationMs } from '@sdelka/domain';
import { HOUR, duration } from '@sdelka/domain';
import type { CurrencyCode, Money } from '@sdelka/money';
import { money } from '@sdelka/money';
/**
 * Порог с письменным обоснованием переиспользуется из `@sdelka/compliance`, а не
 * определяется здесь заново. Это одна и та же идея — «порог без обоснования есть
 * находка на аудите» (`BACKLOG.md` E4-4), — и двух её редакций быть не должно:
 * вторая копия это второе место, где обоснование можно потерять.
 */
import type { DualControlRequirement, JustifiedThreshold } from '@sdelka/compliance';
import { IntakeError, IntakeErrorCode } from './errors';

/**
 * Политика приёма — версионированная сущность (`ROADMAP.md` И2.1, задача
 * «правила допуска как политика с версией, а не константа»).
 *
 * Ни одного числа вне этого файла: допуск, веса признаков сопоставления, пороги
 * и срок котировки живут здесь и только здесь.
 */
export type IntakePolicyVersionId = string & { readonly __intakePolicyVersionId: unique symbol };

/** Формат: `intake/<год>-<месяц>-<день>.<порядковый>`, чтобы версии сортировались. */
const POLICY_VERSION_PATTERN = /^intake\/\d{4}-\d{2}-\d{2}\.\d+$/u;

export function intakePolicyVersionId(value: string): IntakePolicyVersionId {
  if (!POLICY_VERSION_PATTERN.test(value)) {
    throw new IntakeError(IntakeErrorCode.policyVersionInvalid, { value });
  }
  return value as IntakePolicyVersionId;
}

/**
 * Допуск по сумме (`FUNCTIONAL.md` §4.3.2): абсолютная величина **и** доля,
 * берётся меньшее.
 *
 * Абсолют задан перечнем по валютам, а не одной суммой: допуск в чужой валюте —
 * отказ закрытый, а не пересчёт по курсу. Курс это внешний факт, а объявленный
 * допуск не может ездить вместе с рынком между инструкцией и платежом
 * (`INTAKE.md` §3.2).
 */
export interface TolerancePolicy {
  readonly absolute: readonly Money<CurrencyCode>[];
  /** Доля в базисных пунктах. Ноль — законное значение: строгое равенство. */
  readonly shareBp: number;
  readonly rationaleDocRef: string;
}

/** Веса признаков сопоставления в процентах. Сумма непарных с именем — 100. */
export interface MatchingWeights {
  readonly referenceExactPercent: number;
  readonly referenceDamagedPercent: number;
  readonly amountFitsPercent: number;
  readonly sourceAccountSeenPercent: number;
  readonly currencyMatchesPercent: number;
  /**
   * Имя отправителя. **Сверх ста процентов** и намеренно: это не один из
   * признаков, а надбавка к уже набранному весу. Ноль непарных признаков даёт
   * ноль итога независимо от имени — см. `scoreCandidate`.
   */
  readonly senderNameBonusPercent: number;
}

export interface MatchingPolicy {
  readonly weights: MatchingWeights;
  /** Ниже этого веса кандидат не показывается вовсе. */
  readonly candidateThreshold: JustifiedThreshold;
  /** Выше этого веса и при единственном кандидате сопоставление автоматическое. */
  readonly autoMatchThreshold: JustifiedThreshold;
  /** Ниже этого сходства искажённый референс не считается искажённым, а считается чужим. */
  readonly damagedReferenceThreshold: JustifiedThreshold;
}

export interface ManualMatchPolicy {
  /** Выше этой суммы ручное сопоставление требует второго утверждения (И2.2). */
  readonly secondApprovalAbove: readonly Money<CurrencyCode>[];
  /**
   * Сколько утверждений требуется, **когда порог пройден**. Ноль невыразим по
   * типу: «второго утверждения не нужно» — это не значение порога, а другая
   * ветка `ManualMatchSecondApproval`, и решает её сумма, а не настройка.
   */
  readonly requiredApprovals: DualControlRequirement;
}

export interface QuotePolicy {
  /** Срок действия котировки. */
  readonly validity: DurationMs;
  /**
   * Порог движения рынка, при котором котировка гасится **внутри срока**
   * (`FUNCTIONAL.md` §4.5, `CORE.md` Ф5).
   */
  readonly driftThreshold: JustifiedThreshold;
}

export interface IntakePolicy {
  readonly version: IntakePolicyVersionId;
  readonly tolerance: TolerancePolicy;
  readonly matching: MatchingPolicy;
  readonly manualMatch: ManualMatchPolicy;
  readonly quote: QuotePolicy;
}

const INTAKE_DOC = 'docs/product/INTAKE.md';
const FUNCTIONAL_TOLERANCE = 'docs/product/FUNCTIONAL.md#432-недоплата-переплата-дробные-платежи-и-допуск-по-сумме';
const FUNCTIONAL_FX = 'docs/product/FUNCTIONAL.md#45-фиксация-курса';

/**
 * ⚠️ **Предложение, а не принятое решение.** Ни одной величины допуска, срока
 * котировки и порога дрейфа нет ни в одном документе проекта: `FUNCTIONAL.md`
 * §4.3.2 задаёт форму допуска и молчит о значении, а «от 1% до 3,5%» в §4.5 —
 * наблюдение о практике провайдеров, а не наше решение (`INTAKE.md` §3.4, §11).
 *
 * Почему это не опасно до ответа владельца: **величина допуска ничего не
 * ослабляет сама по себе.** Действующий допуск равен нулю, пока не существует
 * факта раскрытия (`disclosure.ts`), а факт раскрытия порождает приложение при
 * выдаче инструкции на перевод, а не этот объект. Принятие величин владельцем —
 * правка одного значения и новая версия политики.
 *
 * ⚠ **`tolerance` на боевом пути берётся не отсюда.** Допуск стал
 * версионируемой настройкой (`@sdelka/limits`, домен `amount_tolerance`) и
 * приходит в расчёт версией, действовавшей **в момент раскрытия**:
 * `intakePolicyAtDisclosure` подставляет её сюда вместе с идентификатором
 * версии. Значение, стоящее в этом объекте, существует затем, чтобы **им завели
 * первую версию журнала**, и совпадает с `PROVISIONAL_AMOUNT_TOLERANCE` —
 * совпадение закреплено тестом (`packages/limits/test/applied.test.ts`), чтобы
 * два места не разъехались молча. Сам приём о настройках при этом не знает:
 * подстановка собрана в одном месте на обоих потребителей — приём и комплаенс,
 * — потому что комплаенс зависеть от `@sdelka/limits` не может по построению
 * (цикл `limits → settings → auth → compliance`).
 */
export const PROPOSED_INTAKE_POLICY: IntakePolicy = Object.freeze({
  version: intakePolicyVersionId('intake/2026-09-04.1'),
  tolerance: Object.freeze({
    absolute: Object.freeze([money('GEL', 5_000n), money('USD', 2_000n), money('EUR', 2_000n)]),
    shareBp: 50,
    rationaleDocRef: FUNCTIONAL_TOLERANCE,
  }),
  matching: Object.freeze({
    weights: Object.freeze({
      referenceExactPercent: 55,
      referenceDamagedPercent: 30,
      amountFitsPercent: 20,
      sourceAccountSeenPercent: 20,
      currencyMatchesPercent: 5,
      senderNameBonusPercent: 10,
    }),
    candidateThreshold: Object.freeze({ valueBp: 2_000, rationaleDocRef: INTAKE_DOC }),
    /**
     * Ниже суммы «сумма подходит + счёт-источник знаком + валюта совпала» = 45%.
     * Это и есть требование Ф4: сопоставление обязано работать **без референса**,
     * а порог выше 45% выключал бы его ровно в том случае, ради которого оно
     * написано. Точный референс (55%) проходит и в одиночку.
     */
    autoMatchThreshold: Object.freeze({ valueBp: 4_000, rationaleDocRef: INTAKE_DOC }),
    damagedReferenceThreshold: Object.freeze({ valueBp: 7_500, rationaleDocRef: INTAKE_DOC }),
  }),
  manualMatch: Object.freeze({
    secondApprovalAbove: Object.freeze([money('GEL', 1_000_000n), money('USD', 400_000n)]),
    requiredApprovals: 1,
  }),
  quote: Object.freeze({
    validity: duration(2 * HOUR),
    driftThreshold: Object.freeze({ valueBp: 100, rationaleDocRef: FUNCTIONAL_FX }),
  }),
});
