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
  /** Чем устанавливается факт. Ключ, а не текст. */
  readonly sourceKey: string;
}

export const RELEASE_CONDITIONS: Readonly<Record<ReleaseConditionType, ReleaseConditionMeta>> =
  Object.freeze({
    registration_transfer: Object.freeze({
      requiresConfirmation: false,
      sourceKey: 'registry.paid_extract',
    }),
    // [открыто] STATE-MACHINES.md §8: регистрация предварительного договора как
    // основание расчёта не подтверждена. До подтверждения — не используется.
    registration_preliminary: Object.freeze({
      requiresConfirmation: true,
      sourceKey: 'registry.preliminary_contract',
    }),
    calendar_date: Object.freeze({
      requiresConfirmation: false,
      sourceKey: 'time.independent_timestamp',
    }),
  });

export function isReleaseConditionType(value: string): value is ReleaseConditionType {
  return (RELEASE_CONDITION_TYPES as readonly string[]).includes(value);
}

export function isUsableReleaseCondition(type: ReleaseConditionType): boolean {
  return !RELEASE_CONDITIONS[type].requiresConfirmation;
}
