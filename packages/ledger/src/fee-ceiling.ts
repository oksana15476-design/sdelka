import {
  type CurrencyCode,
  type Money,
  type Rational,
  applyRational,
  compareRational,
  money,
  rational,
} from '@sdelka/money';
import { LedgerError, LedgerErrorCode } from './errors';

/**
 * Потолок удержания — предел доли суммы к распределению, которую платформа
 * вправе оставить себе (эпик E16).
 *
 * **Почему величина переехала сюда из домена.** Правило было написано в
 * `@sdelka/domain` (`tariff.ts`) с оговоркой: «учёт не может её знать: ему
 * приходит готовая сумма, и любая сходится». Оговорка неверна ровно в одном
 * месте — и это то самое место, где удержание и происходит. В записи расчёта
 * (`settleTrancheToClientAccount`) учёт видит **обе** величины сразу: брутто
 * дебетуется с запертой части плательщика, нетто кредитуется свободной части
 * получателя, и разница между ними и есть удержание. Отношение одного к
 * другому учёт посчитать может, а значит и обязан.
 *
 * Пока правило жило только в домене, оно запрещало ровно ничего: боевой путь
 * (`packages/app`, `projectSettlementIntent`) его не звал, `accrueFee` и
 * `settleTrancheToClientAccount` о нём не знали, и удержание 99 000 из 100 000
 * собиралось, записывалось и сходилось повалютно. Проба воспроизведена в
 * `test/fee-ceiling.test.ts`.
 *
 * Домен своё правило не потерял: `tariff.ts` продолжает считать предел от
 * политики транша и класть его в намерение расчёта (`CORE.md` Ф11 — решение
 * хранит политику, действовавшую в момент принятия). Он только перестал быть
 * **единственным** местом, где предел существует: в домене — норма, здесь —
 * запрет, который нечем обойти.
 *
 * Рациональное число, а не число с плавающей точкой: красная линия №4.
 */
export interface FeeCeiling {
  /**
   * Предельная доля суммы к распределению, которую можно удержать **всего** —
   * комиссия платформы, вознаграждение партнёра и что бы ни добавилось потом.
   *
   * Именно всего, а не по строке: три удержания по одной пятой каждое — это
   * три законных строки и три пятых суммы клиента. Потолок, стоящий на строке,
   * обходится добавлением строки. Учёт считает удержание вычитанием (брутто
   * минус то, что дошло до получателя), поэтому число строк ему безразлично по
   * построению.
   */
  readonly maxShare: Rational;
}

/**
 * Жёсткий предел учёта — **два процента**.
 *
 * Значение то же, что у `DEFAULT_FEE_CEILING_POLICY` в домене, и это не копия
 * константы, а её источник: домен теперь ссылается сюда, чтобы двух правд о
 * потолке не было (расхождение двух моделей одного и того же в этом проекте
 * уже случалось — см. `ledger-projection.ts`).
 *
 * ⚠ **[открыто] владельцу — само значение.** Ставка и её предел принадлежат
 * E16. Здесь стоит самое строгое значение, не отвергающее ни один
 * задокументированный тариф: `FUNCTIONAL.md` §3.3 (поток P1, 0,4998 %) и §3.4
 * (поток P2, 1,5 %). Промах на разряд (`0,5` → `5`) ловится, промах вчетверо
 * (`0,5` → `2`) — нет; более тесный потолок останавливает деньги и потому
 * назначается владельцем, а не нами.
 */
export const DEFAULT_FEE_CEILING: FeeCeiling = Object.freeze({
  maxShare: rational(2n, 100n),
});

/** Потолок как величина: доля не бывает отрицательной и не бывает больше единицы. */
export function feeCeiling(maxShare: Rational): FeeCeiling {
  if (compareRational(maxShare, rational(0n, 1n)) < 0) {
    throw new LedgerError(LedgerErrorCode.feeCeilingInvalid, { reason: 'negative' });
  }
  // Доля больше единицы — не «очень щедрый потолок», а величина, которой не
  // существует: удержать больше суммы нельзя ни при какой ставке.
  if (compareRational(maxShare, rational(1n, 1n)) > 0) {
    throw new LedgerError(LedgerErrorCode.feeCeilingInvalid, { reason: 'above_one' });
  }
  return Object.freeze({ maxShare });
}

/**
 * Строже из двух потолков.
 *
 * Нужна ровно затем, чтобы объявленный на записи потолок мог только **сужать**
 * предел учёта, но не расширять его. Иначе «потолок как значение» стал бы
 * дырой: `feeCeiling(rational(1n, 1n))` — законная величина, и запись,
 * приносящая её с собой, разрешала бы себе удержать всё.
 */
export function strictestFeeCeiling(left: FeeCeiling, right: FeeCeiling): FeeCeiling {
  return compareRational(left.maxShare, right.maxShare) <= 0 ? left : right;
}

/**
 * Наибольшее удержание, законное для этой суммы.
 *
 * Округление вниз (`trunc` от неотрицательной величины) — в пользу клиента: на
 * границе спорная минорная единица достаётся получателю, как и остаток от
 * округления при расщеплении (`FUNCTIONAL.md` §4.3 п.5).
 */
export function feeCeilingCap<C extends CurrencyCode>(
  gross: Money<C>,
  ceiling: FeeCeiling = DEFAULT_FEE_CEILING,
): Money<C> {
  if (gross.minor < 0n) {
    throw new LedgerError(LedgerErrorCode.feeCeilingInvalid, {
      reason: 'negative_gross',
      amount: gross.minor.toString(),
    });
  }
  return money(gross.currency, applyRational(gross.minor, ceiling.maxShare, 'trunc'));
}

/**
 * Укладывается ли удержание в потолок. Сравнение целых минорных единиц —
 * никакой плавающей точки на пути от ставки до ответа (красная линия №4).
 *
 * Отрицательное удержание — не «укладывается с запасом»: это значит, что
 * получателю досталось больше брутто, и разбирать такую запись потолком нечем.
 * Ответ `false`, разбирается вызывающим.
 */
export function feeWithinCeiling(
  gross: Money<CurrencyCode>,
  withheld: Money<CurrencyCode>,
  ceiling: FeeCeiling = DEFAULT_FEE_CEILING,
): boolean {
  if (gross.currency !== withheld.currency) return false;
  if (withheld.minor < 0n) return false;
  return withheld.minor <= feeCeilingCap(gross, ceiling).minor;
}
