/**
 * Технические ключи ошибок для разработчика. Не пользовательский текст.
 *
 * Граница та же, что в `@sdelka/settings` и `@sdelka/pricing`: **бросают** здесь
 * только испорченные величины — порог, который вообще не является порогом
 * (отрицательный, дробный, нижняя граница выше верхней, перечень валют без
 * валюты расчёта). Отказ по конкретной сделке или по конкретному действию
 * владельца — значение (`Result` и `LIMITS_REFUSAL_KEYS` в `keys.ts`).
 *
 * Почему именно бросок, а не отказ: **величина проверяется на записи настройки,
 * а не при применении** (задача E16-7). Ошибка в настройке, отложенная до
 * применения, доезжает до денег: до неё расчёт уже посчитан, инструкция уже
 * выдана, а порог, который «сработает неверно», к этому моменту уже раскрыт
 * стороне. Отсюда и место проверки — конструктор величины, до того как она
 * попадёт в версию настройки.
 */
export const LimitsErrorCode = {
  /* --- Перечень валют --- */
  /** Перечень валют сделки пуст: продукта без валюты сделки не существует. */
  currencyListEmpty: 'limits.currencies.list_empty',
  /** Одна валюта названа в перечне дважды. */
  currencyDuplicated: 'limits.currencies.duplicated',
  /**
   * В перечне валют сделки нет лари. Расчёт по недвижимости на территории
   * Грузии возможен только в национальной валюте **[установлено, `PRODUCT.md`
   * §6; `SETTINGS.md` §9 п.15]**, поэтому лари из перечня не выключается —
   * это не настройка, а условие существования продукта.
   */
  settlementCurrencyMissing: 'limits.currencies.settlement_currency_missing',
  /** Число открытых позиций по валюте задано не целым неотрицательным числом. */
  openPositionsInvalid: 'limits.currencies.open_positions_invalid',

  /* --- Доли --- */
  /** Доля задана не целым числом базисных пунктов: плавающая точка через форму. */
  shareNotInteger: 'limits.share.not_integer',
  /**
   * Доля вне `0…10 000` базисных пунктов. Верхняя граница — не вкусовая:
   * `10 000` б.п. это сама сумма, и доля больше неё означает допуск **больше
   * суммы поступления** (`SETTINGS.md` §9 п.13).
   */
  shareOutOfRange: 'limits.share.out_of_range',

  /* --- Суммы --- */
  /** Порог, заданный суммой, отрицателен. */
  amountNegative: 'limits.amount.negative',
  /** Порог, заданный суммой, равен нулю там, где ноль означает «порога нет». */
  amountNotPositive: 'limits.amount.not_positive',
  /** Порог назван в валюте, которой нет в перечне валют сделки. */
  currencyNotAdmitted: 'limits.amount.currency_not_admitted',
  /** Порог значимости назван не в лари: норма названа в национальной валюте. */
  currencyNotSettlement: 'limits.amount.currency_not_settlement',

  /* --- Возрастные границы очереди --- */
  /** Граница возраста задана не целым числом миллисекунд или неположительна. */
  ageBandNotPositiveInteger: 'limits.queue.age_band_not_positive_integer',
  /**
   * Границы возраста не строго возрастают: нижняя оказалась выше верхней.
   * Лестница, у которой вторая ступень ниже первой, не эскалирует, а
   * перескакивает — и разобрать через год, какой уровень был назначен задаче,
   * будет нечем.
   */
  ageBandsNotAscending: 'limits.queue.age_bands_not_ascending',
  /**
   * Возрастных границ не объявлено ни одной. Очередь без единой границы — это
   * очередь без норматива: ни одна задача никогда не эскалируется, и выглядит
   * это как «всё в срок». Норматив дежурного не выключается пустым перечнем;
   * если норматив надо ослабить, границу двигают, а не убирают.
   */
  ageBandsEmpty: 'limits.queue.age_bands_empty',

  /* --- Обоснование --- */
  /** Порог заведён без ссылки на документ, объясняющий его величину. */
  thresholdUnjustified: 'limits.threshold.unjustified',
} as const;

export type LimitsErrorCode = (typeof LimitsErrorCode)[keyof typeof LimitsErrorCode];

export class LimitsError extends Error {
  readonly code: LimitsErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: LimitsErrorCode, details: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'LimitsError';
    this.code = code;
    this.details = details;
  }
}
