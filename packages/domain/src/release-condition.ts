/**
 * Тип условия расчёта — закрытый перечень внешних фактов (STATE-MACHINES.md §8).
 * Строковый тип здесь запрещён: добавление значения обязано ломать компиляцию
 * во всех местах разбора. Перечень расширяется только изменением документа.
 *
 * Из перечня намеренно исключены «внесение средств» (зависит от воли покупателя;
 * отлагательное условие, зависящее только от воли стороны, делает сделку
 * ничтожной целиком) и «веха строительства» (воля застройщика без независимого
 * акта).
 */
export const RELEASE_CONDITION_TYPES = [
  'registration_transfer',
  'registration_preliminary',
  'calendar_date',
] as const;

export type ReleaseConditionType = (typeof RELEASE_CONDITION_TYPES)[number];

export interface ReleaseConditionMeta {
  /**
   * `true` — значение помечено в документе как **[открыто]** и до подтверждения
   * не используется. Редьюсер отказывает по нему явно, чтобы попытка применить
   * непроверенное условие была видна, а не растворилась в конфигурации.
   */
  readonly requiresConfirmation: boolean;
  /**
   * `true` — наблюдение требуемого уровня от этого источника **кто-то
   * производит**.
   *
   * Отдельный признак, а не второе значение `requiresConfirmation`, по правилу
   * §7 (каждое правило проверяется поимённо): «владелец не подтвердил тип» и
   * «источника нет в природе» — два разных утверждения о двух разных людях.
   * Первое снимает владелец решением, второе — код, которого пока нет.
   * Склеенные, они дают один отказ на две причины, и оператор не узнает, чего
   * ждать.
   *
   * Найдено пробой: `calendar_date` требует `L3` от `time.independent_timestamp`
   * (`OBSERVATION_REQUIREMENTS`), а такого наблюдения не собирает ни одна
   * строка кода — `packages/oracle` умеет только реестр. Плюс `g_fields_match`
   * требует пяти сошедшихся полей **выписки** и непустого кадастрового кода,
   * которых у календарной даты не бывает вовсе. Тип стоял в перечне и работать
   * не мог; закрывала его не норма, а отсутствие фикстуры.
   */
  readonly sourceImplemented: boolean;
  /** Чем устанавливается факт. Ключ, а не текст. */
  readonly sourceKey: string;
}

export const RELEASE_CONDITIONS: Readonly<Record<ReleaseConditionType, ReleaseConditionMeta>> =
  Object.freeze({
    // Единственный работающий тип: платную выписку собирает `packages/oracle`,
    // уровень `L3` она несёт, и пять полей выписки у неё есть по построению.
    registration_transfer: Object.freeze({
      requiresConfirmation: false,
      sourceImplemented: true,
      sourceKey: 'registry.paid_extract',
    }),
    // [открыто] STATE-MACHINES.md §8: регистрация предварительного договора как
    // основание расчёта не подтверждена. До подтверждения — не используется.
    // Источника у неё тоже нет: `registry.preliminary_contract` не производит
    // никто. Два разных «нет», и оба записаны.
    registration_preliminary: Object.freeze({
      requiresConfirmation: true,
      sourceImplemented: false,
      sourceKey: 'registry.preliminary_contract',
    }),
    /**
     * ⚠ Тип **недостижим**, и с этого батча об этом сказано вслух.
     *
     * Владельцем он подтверждён (`STATE-MACHINES.md` §8 помечает его
     * **[установлено]**, «для траншей без условия»), поэтому
     * `requiresConfirmation: false` остаётся верным. Недостаёт другого:
     *
     *  · наблюдения `L3` от `time.independent_timestamp` не производит ни одна
     *    строка кода — `TimestampPort` в `packages/audit` объявлен, поставщика
     *    метки нет;
     *  · `g_fields_match` требует пяти сошедшихся полей **выписки из реестра**,
     *    а `g_observation_sufficient` — непустого кадастрового кода. У
     *    календарной даты нет ни выписки, ни объекта: наблюдение такой формы
     *    невозможно собрать честно, его можно только подделать пятью `true`.
     *
     * До этого батча тип молча не срабатывал: попытка уходила в отказ
     * guard'ов, то есть выглядела как «доказательств не хватило», хотя их не
     * могло хватить никогда. Теперь отказ называет причину
     * (`releaseConditionSourceUnavailable`).
     *
     * Чтобы сделать тип достижимым, нужны две вещи, и обе — не этот батч:
     * поставщик независимой метки времени и **отдельная форма наблюдения** для
     * условий без объекта. Второе — продуктовое решение владельца: расширять
     * `ReleaseObservation` вариантом без выписки значит трогать guard'ы, стоящие
     * на пути выплаты.
     */
    calendar_date: Object.freeze({
      requiresConfirmation: false,
      sourceImplemented: false,
      sourceKey: 'time.independent_timestamp',
    }),
  });

export function isReleaseConditionType(value: string): value is ReleaseConditionType {
  return (RELEASE_CONDITION_TYPES as readonly string[]).includes(value);
}

/**
 * Годится ли тип условия для живой сделки — **оба** условия сразу.
 *
 * Акт получателя с негодным типом невалиден (`isConditionActValid`), то есть
 * `g_condition_agreed` не пропустит приём средств по нему. Это и есть «пометить
 * явно» вместо «молча не сработает»: раньше транш с календарной датой законно
 * принимал деньги и упирался в guard'ы доказательств уже после того, как деньги
 * лежали у нас.
 */
export function isUsableReleaseCondition(type: ReleaseConditionType): boolean {
  const meta = RELEASE_CONDITIONS[type];
  return !meta.requiresConfirmation && meta.sourceImplemented;
}
