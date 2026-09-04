import {
  type Rational,
  money,
  rational,
  rationalFromDecimalString,
  split,
} from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEE_CEILING_POLICY,
  DomainError,
  RejectionCode,
  assertWithholdingWithinCeiling,
  feeCeilingPolicy,
  maxWithholding,
  reduceTranche,
  withholdingWithinCeiling,
} from '../src/index';
import { context } from './support/facts';
import { stateAt } from './support/drive';

/**
 * Потолок удержания — эпик E16, `tariff.ts`.
 *
 * Проба, с которой начался батч: транш на 20 000 000 тетри, полностью
 * обеспеченный, удержание 19 999 999. Получателю — одна минорная единица.
 * `split` пропускает: он отвергает только «удержано больше суммы». Инварианты
 * учёта пусты: запись сходится, покрытие держится, остаток неотрицателен.
 */

const GROSS = money('GEL', 20_000_000n);
const ABSURD_FEE = money('GEL', 19_999_999n);

describe('комиссия: предел сверху', () => {
  it('арифметика пропускает почти всю сумму — вот почему предел нужен', () => {
    // Сначала фиксируем, что дефект был не в арифметике. `split` считает верно
    // и в этом случае: сумма частей равна исходной, остаток у получателя.
    const parts = split(GROSS, [{ key: 'fee:income', fixed: ABSURD_FEE.minor }]);
    expect(parts.deductions[0]?.amount.minor).toBe(19_999_999n);
    expect(parts.recipient.minor).toBe(1n);
  });

  it('и всё же это удержание недопустимо', () => {
    expect(withholdingWithinCeiling(GROSS, ABSURD_FEE)).toBe(false);
    const error = (() => {
      try {
        assertWithholdingWithinCeiling(GROSS, ABSURD_FEE);
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(RejectionCode.feeExceedsCeiling);
  });

  it('задокументированные тарифы проходят, промах на разряд — нет', () => {
    // `FUNCTIONAL.md` §3.3: 1 067 из 213 495 — поток P1, живой продукт.
    const p1 = money('GEL', 213_495n * 100n);
    expect(withholdingWithinCeiling(p1, money('GEL', 106_700n))).toBe(true);
    // §3.4: 61 из 4 050 — поток P2, верхняя из записанных ставок.
    const p2 = money('GEL', 405_000n);
    expect(withholdingWithinCeiling(p2, money('GEL', 6_100n))).toBe(true);
    // Опечатка в проценте: 0,5 → 5. Ровно то, против чего потолок и ставится.
    const typo = (rate: Rational) =>
      split(p1, [{ key: 'fee:income', rate }]).deductions[0]?.amount ?? money('GEL', 0n);
    expect(withholdingWithinCeiling(p1, typo(rationalFromDecimalString('0.005')))).toBe(true);
    expect(withholdingWithinCeiling(p1, typo(rationalFromDecimalString('0.05')))).toBe(false);
  });

  it('потолок стоит на сумме удержаний, а не на строке расчёта', () => {
    // Иначе он обходится добавлением строки: три удержания по одной пятой —
    // это три законных строки и три пятых суммы клиента.
    const parts = split(GROSS, [
      { key: 'fee:income', rate: rational(1n, 5n) },
      { key: 'partner:fee', rate: rational(1n, 5n) },
      { key: 'service:income', rate: rational(1n, 5n) },
    ]);
    const withheld = parts.deductions.reduce((total, part) => total + part.amount.minor, 0n);
    expect(withholdingWithinCeiling(GROSS, money('GEL', withheld))).toBe(false);
    // При этом каждая строка по отдельности — тоже сверх потолка, и это
    // случайность значения, а не свойство правила: проверяется сумма.
    expect(maxWithholding(GROSS).minor).toBe(400_000n);
  });

  it('граница включительна, спорная единица достаётся получателю', () => {
    // Округление вниз: на сумме, не делящейся на потолок нацело, лишняя
    // минорная единица уходит клиенту, как и остаток при расщеплении.
    const odd = money('GEL', 1_001n);
    expect(maxWithholding(odd).minor).toBe(20n);
    expect(withholdingWithinCeiling(odd, money('GEL', 20n))).toBe(true);
    expect(withholdingWithinCeiling(odd, money('GEL', 21n))).toBe(false);
  });

  it('сравнение чужих валют — не «не укладывается», а отказ', () => {
    expect(withholdingWithinCeiling(GROSS, money('USD', 1n))).toBe(false);
    expect(withholdingWithinCeiling(GROSS, money('GEL', -1n))).toBe(false);
  });

  it('сам потолок — величина, а не любая дробь', () => {
    expect(() => feeCeilingPolicy(rational(-1n, 100n))).toThrow(DomainError);
    // Доля больше единицы — не «щедрый потолок», а величина, которой не бывает.
    expect(() => feeCeilingPolicy(rational(101n, 100n))).toThrow(DomainError);
    expect(feeCeilingPolicy(rational(1n, 1n)).maxShare).toEqual(rational(1n, 1n));
    // Умолчание названо здесь, чтобы смена значения ломала тест, а не тихо
    // расширяла предел: ⚠ [открыто] владельцу, это рабочее значение, не норма.
    expect(DEFAULT_FEE_CEILING_POLICY.maxShare).toEqual(rational(1n, 50n));
  });

  it('предел едет в намерении расчёта, посчитанный по политике транша', () => {
    // Ставку применяет проекция, значит и предел обязан доехать туда же:
    // правило, оставшееся в домене, существует там, где его некому нарушить.
    const paidOut = reduceTranche(
      stateAt('paying_out'),
      { type: 'payout_result', outcome: 'settled' },
      context(),
    );
    expect(paidOut.ok).toBe(true);
    if (!paidOut.ok) return;
    const settlement = paidOut.value.intents.find(
      (intent) => intent.type === 'post_settlement_entry',
    );
    expect(settlement).toBeDefined();
    if (settlement?.type !== 'post_settlement_entry') return;
    expect(settlement.maxWithholding).toEqual(maxWithholding(settlement.amount));

    // Политика транша, а не сегодняшняя настройка: Ф11 — решение хранит
    // политику, действовавшую в момент принятия.
    const stricter = reduceTranche(
      stateAt('paying_out'),
      { type: 'payout_result', outcome: 'settled' },
      context({ feeCeilingPolicy: feeCeilingPolicy(rational(1n, 1000n)) }),
    );
    expect(stricter.ok).toBe(true);
    if (!stricter.ok) return;
    const stricterSettlement = stricter.value.intents.find(
      (intent) => intent.type === 'post_settlement_entry',
    );
    if (stricterSettlement?.type !== 'post_settlement_entry') return;
    expect(stricterSettlement.maxWithholding.minor).toBe(
      stricterSettlement.amount.minor / 1000n,
    );
  });
});
