/**
 * Полномочия — `ACTORS.md` §5.
 *
 * **Право выражается перечнем, а не строкой.** Разница не в аккуратности: строка
 * `'approve_payout'` в проверке — это опечатка, которая компилируется и молча
 * запрещает всё; перечень с полными разборами — это опечатка, которую не собрать.
 *
 * Мест разбора здесь **два**, и оба обязаны быть полными:
 *
 * 1. `CAPABILITY_SPECS` — тотальная запись `Record<Capability, CapabilitySpec>`.
 *    Новое полномочие без описания не собирается.
 * 2. `separationRulesFor` в `separation.ts` — исчерпывающий `switch`. Новое
 *    полномочие обязано ответить, какие несовместимости его связывают; ответ
 *    «никакие» допустим, но он должен быть написан, а не получиться сам.
 *
 * Перечень целевой из `ACTORS.md` §5.1 — 27 значений: 11 существующих в
 * `packages/compliance/src/roles.ts` плюс 16 названных в таблице §5.1.
 * Двадцать восьмое (`manage_access`) введено реализацией — см. его комментарий.
 */
export const CAPABILITIES = [
  /* --- Чтение --- */
  'read_deal',
  'read_party',
  'read_beneficiary',
  'read_audit',
  'read_economics',

  /* --- Ведение сделки --- */
  'create_deal',
  'invite_party',
  'verify_property',
  'record_condition_act',

  /* --- Оракул --- */
  'order_extract',
  'record_observation',

  /* --- Реквизиты выплаты --- */
  'write_beneficiary',
  'confirm_test_transfer_code',

  /* --- Комплаенс --- */
  'run_screening',
  'adjudicate_screening',

  /* --- Снятие ограничений и утверждения --- */
  'lift_block',
  'approve_lift_block',
  'approve_beneficiary_change',
  'approve_payout',

  /* --- Сужающие: работают ночью и в одиночку --- */
  'halt_intake',
  'freeze_participation',
  'confirm_incident',
  'lift_halt',

  /* --- Управление --- */
  'manage_settings',
  'manage_access',

  /* --- Персональные данные --- */
  'export_personal_data',
  'erase_personal_data',

  /* --- Работа от имени --- */
  'act_on_behalf',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Класс действия. По нему проверяются два правила, которые иначе держались бы
 * на памяти автора:
 *
 * - Н6 (`ACTORS.md` §2): владелец видит экономику и **не имеет ни одного
 *   полномочия с денежным эффектом**. Выражается перечнем допустимых классов,
 *   а не списком запрещённых полномочий: список запрещённых устаревает при
 *   добавлении двадцать девятого.
 * - §7.3: дежурство добавляет **только сужающие** полномочия. Тот же довод.
 */
export type CapabilityEffect =
  /** Только чтение. Ничего не двигает. */
  | 'read'
  /** Готовит операцию, сам её не разрешает. Утверждает кто-то другой (Н1). */
  | 'prepare'
  /** Расширяющее: снимает ограничение или разрешает движение денег. */
  | 'release'
  /** Только сужает. Ошибочное нажатие стоит разбора, не денег (§7.3). */
  | 'narrow'
  /** Рычаги и доступ. Меняет правила, а не отдельную операцию. */
  | 'govern'
  /** Персональные данные: выдача и удаление по требованию субъекта. */
  | 'personal_data';

/**
 * Требование второго фактора **на это действие**, а не на вход.
 *
 * `session` — фактор обязан быть подтверждён при выдаче сессии и этого хватает.
 * `step_up` — фактор обязан быть подтверждён заново и недавно: подтверждение
 * часовой давности не подтверждает того, кто сидит за клавиатурой сейчас.
 */
export type SecondFactorRequirement = 'none' | 'step_up';

export interface CapabilitySpec {
  readonly effect: CapabilityEffect;
  readonly secondFactor: SecondFactorRequirement;
  /**
   * Попадает ли **успешное** применение в журнал отдельной записью.
   *
   * Не всё: `read_deal` при каждом открытии карточки — это шум, который топит
   * журнал и делает его непригодным для того, ради чего он ведётся. Просмотр
   * персональных данных логируется отдельным видом записи (`personal_data_viewed`
   * в `packages/audit`), а не этим полем.
   */
  readonly journaled: boolean;
  /** Откуда взято. Ссылка обязательна: полномочие без источника — это догадка. */
  readonly source: string;
}

/**
 * Полный разбор перечня. Добавление полномочия ломает компиляцию здесь.
 */
export const CAPABILITY_SPECS: Readonly<Record<Capability, CapabilitySpec>> = Object.freeze({
  read_deal: {
    effect: 'read',
    secondFactor: 'none',
    journaled: false,
    source: 'ACTORS.md §4.2 B1',
  },
  read_party: {
    effect: 'read',
    secondFactor: 'none',
    journaled: false,
    source: 'ACTORS.md §4.1',
  },
  /**
   * Даёт **проекцию** реквизитов: маску, статус и отпечаток счёта. Полного
   * значения не даёт ни одному носителю — `ACTORS.md` §4.2 B3, §8 п.1.
   * См. `beneficiaryDisclosure` в `roles.ts`.
   */
  read_beneficiary: {
    effect: 'read',
    secondFactor: 'none',
    journaled: false,
    source: 'ACTORS.md §5.1, §4.2 B4',
  },
  read_audit: {
    effect: 'read',
    secondFactor: 'none',
    journaled: false,
    source: 'ACTORS.md §5.1 (Ф11), §4.4 D1',
  },
  read_economics: {
    effect: 'read',
    secondFactor: 'none',
    journaled: false,
    source: 'ACTORS.md §4.3 C3, §5.1',
  },
  create_deal: {
    effect: 'prepare',
    secondFactor: 'none',
    journaled: true,
    source: 'ACTORS.md §5.1 (Ф1)',
  },
  invite_party: {
    effect: 'prepare',
    secondFactor: 'none',
    journaled: true,
    source: 'ACTORS.md §5.1 (E11-1)',
  },
  verify_property: {
    effect: 'prepare',
    secondFactor: 'none',
    journaled: true,
    source: 'ACTORS.md §5.1 (Ф3)',
  },
  /**
   * Акт получателя об условии. Второй фактор — потому что акт определяет, при
   * каком внешнем факте уйдут деньги (красная линия №6), и подменённый акт стоит
   * всей суммы.
   */
  record_condition_act: {
    effect: 'prepare',
    secondFactor: 'step_up',
    journaled: true,
    source: 'ACTORS.md §5.1 (Ф13, И11.1)',
  },
  /** Заказ платной выписки — это расход (`oracle:cost:expense`), у него автор. */
  order_extract: {
    effect: 'prepare',
    secondFactor: 'none',
    journaled: true,
    source: 'ACTORS.md §5.1 (Ф7), §6.4',
  },
  record_observation: {
    effect: 'prepare',
    secondFactor: 'none',
    journaled: true,
    source: 'ACTORS.md §5.1 (Ф7)',
  },
  /**
   * Ввод реквизитов — второй фактор обязателен (`CABINETS.md` §4.1). Требование
   * документа существовало без носителя: полномочие было, канала не было
   * (`ACTORS.md` §4.2, Р6). Здесь оно получает носителя.
   */
  write_beneficiary: {
    effect: 'prepare',
    secondFactor: 'step_up',
    journaled: true,
    source: 'CABINETS.md §4.1, ACTORS.md §4.2 B3',
  },
  confirm_test_transfer_code: {
    effect: 'prepare',
    secondFactor: 'step_up',
    journaled: true,
    source: 'CABINETS.md §4.1',
  },
  run_screening: {
    effect: 'prepare',
    secondFactor: 'none',
    journaled: true,
    source: 'compliance/src/roles.ts',
  },
  /** Разбор санкционного хита — решение, после которого деньги идут дальше. */
  adjudicate_screening: {
    effect: 'release',
    secondFactor: 'step_up',
    journaled: true,
    source: 'compliance/src/roles.ts, ACTORS.md §4.1 A7',
  },
  /**
   * Снятие блокировки — **первая половина**. `ACTORS.md` §5.3: часть типов
   * снимается одним человеком, часть — двумя, и вторая подпись это
   * `approve_lift_block`. Полномочие само по себе разрешения не даёт: тип
   * блокировки решает, нужен ли второй.
   */
  lift_block: {
    effect: 'release',
    secondFactor: 'step_up',
    journaled: true,
    source: 'ACTORS.md §5.3',
  },
  approve_lift_block: {
    effect: 'release',
    secondFactor: 'step_up',
    journaled: true,
    source: 'ACTORS.md §5.1, §5.3',
  },
  approve_beneficiary_change: {
    effect: 'release',
    secondFactor: 'step_up',
    journaled: true,
    source: 'CABINETS.md §4.1, ACTORS.md §2 Н4',
  },
  approve_payout: {
    effect: 'release',
    secondFactor: 'step_up',
    journaled: true,
    source: 'FUNCTIONAL.md §3.5, ACTORS.md §5.2',
  },
  /**
   * Стоп-кран. Второго фактора **нет намеренно**: он работает 24/7, в 23:40 в
   * субботу, с чужого телефона, и он только сужает (§7.3). Шаг подтверждения на
   * сужающем действии — это шаг, на котором в реальном инциденте споткнутся.
   * Цена ошибочного нажатия — утренний разбор; цена не нажатого стоп-крана —
   * покрытие ≠ 1 (красная линия №3).
   */
  halt_intake: {
    effect: 'narrow',
    secondFactor: 'none',
    journaled: true,
    source: 'ACTORS.md §7.3 (Ф17)',
  },
  freeze_participation: {
    effect: 'narrow',
    secondFactor: 'none',
    journaled: true,
    source: 'ACTORS.md §7.3 (И13.3)',
  },
  confirm_incident: {
    effect: 'narrow',
    secondFactor: 'none',
    journaled: true,
    source: 'ACTORS.md §7.3 (И6.3)',
  },
  /**
   * Снятие остановки — расширяющее, и это ровно то, чего у дежурного нет
   * (§7.3). Двое требуются не полномочием, а правилом Н5 и кворумом.
   */
  lift_halt: {
    effect: 'release',
    secondFactor: 'step_up',
    journaled: true,
    source: 'ACTORS.md §7.4 (Ф17)',
  },
  /**
   * Рычаги: тариф, спред, пороги, лимиты. Настройка, поменянная без следа, —
   * способ переписать историю денег (`ACTORS.md` §4.3 C5).
   */
  manage_settings: {
    effect: 'govern',
    secondFactor: 'step_up',
    journaled: true,
    source: 'ACTORS.md §4.3 C5 (Ф16)',
  },
  /**
   * Заведение учётных записей и назначение ролей.
   *
   * ⚠ **Введено реализацией, в `ACTORS.md` §5.1 его нет.** Документ описывает
   * тринадцать ролей и двадцать семь полномочий и не называет никого, кто вправе
   * роль назначить. Полномочие, которого нет, — это либо «может кто угодно», либо
   * «не может никто»; первое отменяет всю матрицу разом, поэтому здесь второе:
   * `ROLE_CAPABILITIES` не выдаёт `manage_access` **ни одной роли**, и сегодня
   * смена роли внутри системы невозможна. Кому его выдать — развилка владельца,
   * см. отчёт.
   */
  manage_access: {
    effect: 'govern',
    secondFactor: 'step_up',
    journaled: true,
    source: 'введено реализацией; пробел ACTORS.md §5',
  },
  export_personal_data: {
    effect: 'personal_data',
    secondFactor: 'step_up',
    journaled: true,
    source: 'ACTORS.md §5.1, §2 (3 рабочих дня)',
  },
  erase_personal_data: {
    effect: 'personal_data',
    secondFactor: 'step_up',
    journaled: true,
    source: 'ACTORS.md §5.1',
  },
  /**
   * Работа от имени клиента. Ужесточается против сегодняшнего: только при
   * дежурстве или в окне поддержки (`ACTORS.md` §5.1). Согласие, TTL и след —
   * `packages/compliance/src/roles.ts`, `grantImpersonation`; здесь только право.
   */
  act_on_behalf: {
    effect: 'prepare',
    secondFactor: 'step_up',
    journaled: true,
    source: 'ACTORS.md §5.1 (Ф12)',
  },
});

export function capabilitySpec(capability: Capability): CapabilitySpec {
  return CAPABILITY_SPECS[capability];
}

export function capabilityEffect(capability: Capability): CapabilityEffect {
  return CAPABILITY_SPECS[capability].effect;
}

/** Полномочия заданного класса. Используется инвариантами ролей, не рантаймом. */
export function capabilitiesWithEffect(effect: CapabilityEffect): readonly Capability[] {
  return Object.freeze(CAPABILITIES.filter((item) => CAPABILITY_SPECS[item].effect === effect));
}
