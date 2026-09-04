import type { Instant } from '@sdelka/domain';

/**
 * Прилипание: к какому моменту сделки величина привязывает свою версию.
 *
 * `SETTINGS.md` §2.1 и §8. Ключевое правило проекта — пересчёт задним числом
 * запрещён, изменение действует на будущие сделки; «на будущие» привязано к
 * событию, и событие у каждой величины своё. Здесь это выражено **типом**:
 * величина объявляет свой момент, и спросить её «а что сейчас» там, где
 * положено «а что было в момент прилипания», не даёт компилятор
 * (`resolve.ts`).
 *
 * Перечень закрыт: новый момент — правка кода, а не значение в форме.
 * Величин здесь нет — только моменты; какая величина к какому моменту
 * прилипает, решает пакет этой величины по таблице §8.
 */
export const STICKING_POINTS = [
  /** Создание сделки. */
  'deal_created',
  /** Создание транша: самое раннее, где величина уже влияет на цифру. */
  'tranche_created',
  /** Выпуск котировки: клиент подтверждает конкретную котировку, а не «вообще». */
  'quote_issued',
  /** Выдача инструкций на перевод. */
  'transfer_instructions_issued',
  /** Факт раскрытия величины стороне до платежа. */
  'disclosure_made',
] as const;

export type StickingPoint = (typeof STICKING_POINTS)[number];

/**
 * «Не прилипает вовсе» — не отсутствие ответа, а ответ (`SETTINGS.md` §В6, §В7:
 * окна наблюдения). Отдельное значение, потому что `undefined` читалось бы и
 * как «не прилипает», и как «забыли назначить», а это разные вещи: у первой
 * версия берётся на момент наблюдения, у второй не берётся никак.
 */
export const NOT_STICKY = 'not_sticky' as const;
export type NotSticky = typeof NOT_STICKY;

export type Attachment = StickingPoint | NotSticky;

/**
 * Момент прилипания: событие **и** время. Одного времени мало — иначе любой
 * `Instant`, включая «сейчас», годился бы туда, где нужен момент создания
 * транша, и прилипание держалось бы на внимательности вызывающего.
 */
export interface StickingMoment<P extends StickingPoint> {
  readonly point: P;
  readonly at: Instant;
}

export function stickingMoment<P extends StickingPoint>(point: P, at: Instant): StickingMoment<P> {
  return Object.freeze({ point, at });
}

/**
 * Момент наблюдения — «сейчас». Годится **только** величинам, которые не
 * прилипают: тип несёт `NOT_STICKY`, и величина с моментом прилипания его не
 * примет.
 */
export interface ObservationMoment {
  readonly point: NotSticky;
  readonly at: Instant;
}

export function observationMoment(at: Instant): ObservationMoment {
  return Object.freeze({ point: NOT_STICKY, at });
}
