import type { Capability, CapabilityEffect } from './capabilities';
import { CAPABILITIES, CAPABILITY_SPECS } from './capabilities';

/**
 * Роли доступа — `ACTORS.md` §3.1.
 *
 * **Тринадцать, а не восемь.** Постановка задачи говорила «восемь ролей из
 * `CABINETS.md` плюс владелец»; `CABINETS.md` §1 называет семь, `ACTORS.md`
 * (версия 1.0 от 2026-09-04, тот же день) — тринадцать и прямо помечает
 * `CABINETS.md` §1 как переписываемый. Взят перечень `ACTORS.md`: он строгий
 * надмножеством к «восьми плюс владелец» и разводит те пары, ради которых
 * разделение обязанностей вообще существует — оператора оракула от
 * финконтролёра (Н2), финконтролёра от руководителя операций (Н3), аудитора от
 * юриста клиента. Расхождение постановки и документа названо в отчёте.
 *
 * Правило расширения перечня — `ACTORS.md` §2: **роль заводится только тогда,
 * когда её отсутствие делает невозможной несовместимость.** «Нужен другой
 * экран» — это проекция существующей роли, а не новая роль.
 */
export const ROLE_IDS = [
  'party',
  'representative',
  'operator',
  'oracle_operator',
  'compliance_analyst',
  'compliance_officer',
  'financial_controller',
  'head_of_operations',
  'support',
  'principal',
  'auditor',
  'client_counsel',
] as const;

export type RoleId = (typeof ROLE_IDS)[number];

/**
 * Нечеловеческие акторы журнала — `ACTORS.md` §3.4.
 *
 * Они **не** входят в `RoleId`, и это выражено типом, а не соглашением: сессия
 * параметризована `RoleId`, поэтому `establishSession` с ролью `system` не
 * собирается. Полномочий у них нет, войти ими нельзя; они существуют, чтобы
 * запись «кто это сделал» никогда не была пустой и никогда не приписывалась
 * человеку.
 *
 * `oracle_source`, а не `oracle`: `ACTORS.md` §1 — оператор оракула это человек,
 * и это третья сущность рядом с двумя.
 */
export const NON_HUMAN_ACTORS = ['system', 'oracle_source'] as const;
export type NonHumanActorId = (typeof NON_HUMAN_ACTORS)[number];

/** Кто это: наш сотрудник, клиент или внешний читатель. */
export type RoleAudience = 'console' | 'client' | 'external';

export interface RoleSpec {
  readonly audience: RoleAudience;
  /**
   * Может ли роль нести дежурство (`ACTORS.md` §7.1: режим поверх ОП, ФК, РО).
   * Дежурство — не роль; флаг на сессии, добавляющий ровно три сужающих
   * полномочия и **ни одного поля данных** (§4, колонка ДЖ пуста).
   */
  readonly dutyEligible: boolean;
  readonly source: string;
}

/* ------------------------------------------------------------------------- */
/* Полномочия по ролям                                                       */
/* ------------------------------------------------------------------------- */

/*
 * Каждый перечень объявлен `as const` и помечен `satisfies`: опечатка в
 * названии полномочия не собирается, а тип роли выводится из того же массива,
 * из которого строится рантайм-проверка. Двух источников истины нет.
 */

/**
 * СТ — сторона. Роль покупателя или получателя — свойство **участия**, а не
 * человека (`FUNCTIONAL.md` §2.1): кабинет один, переключателя нет.
 *
 * Чего здесь нет и почему: `read_audit` (`ACTORS.md` §4.4 D1 даёт стороне `◐` —
 * свои записи; это **проекция**, и выдать под неё полномочие на весь журнал
 * значит выдать журнал целиком — см. отчёт), `record_condition_act` есть, а
 * `halt_intake` нет: сторона останавливает своё участие, не платформу (§7.3).
 */
const PARTY_CAPABILITIES = [
  'read_deal',
  'read_party',
  'read_beneficiary',
  'write_beneficiary',
  'confirm_test_transfer_code',
  'record_condition_act',
  'freeze_participation',
] as const satisfies readonly Capability[];
export type PartyCapability = (typeof PARTY_CAPABILITIES)[number];

/**
 * ПР — представитель по доверенности. Ровно два полномочия (`ACTORS.md` §6.2):
 * реквизиты не меняет и код тестового перевода не подтверждает — иначе
 * доверенность обходит весь периметр Ф15.
 *
 * `record_condition_act` не выдан **намеренно**: §6.2 и §9 случай 6 помечают
 * вопрос «допускает ли доверенность акт об условии» как **[открыто]**, и он
 * блокирует И11.1. Открытый вопрос закрывается решением владельца, а не
 * выданным правом.
 */
const REPRESENTATIVE_CAPABILITIES = ['read_deal', 'read_party'] as const satisfies
  readonly Capability[];
export type RepresentativeCapability = (typeof REPRESENTATIVE_CAPABILITIES)[number];

/**
 * ОП — оператор. Готовит, не утверждает (Н1).
 *
 * `write_beneficiary` **снят** — `ACTORS.md` §4.2: реквизиты вводит только
 * сторона, в кабинете, под вторым фактором. Оператор, вводящий реквизиты «по
 * телефону, потому что клиент не разобрался», — ровно тот сценарий, против
 * которого построен весь периметр Ф15. Сегодня это полномочие у него есть
 * (`packages/compliance/src/roles.ts`), и снятие его там — не наш пакет.
 */
const OPERATOR_CAPABILITIES = [
  'read_deal',
  'read_party',
  'read_beneficiary',
  'create_deal',
  'invite_party',
  'verify_property',
  'run_screening',
  'halt_intake',
] as const satisfies readonly Capability[];
export type OperatorCapability = (typeof OPERATOR_CAPABILITIES)[number];

/**
 * ОР — оператор оракула. Устанавливает факт, не утверждает выплату (Н2).
 *
 * `approve_payout` отсутствует в перечне — это первый рубеж, и он
 * компиляционный. Второй рубеж — правило Н2 в `separation.ts`, которое ловит
 * тот же запрет по человеку, а не по учётной записи: критерий приёмки
 * `ACTORS.md` §10 требует, чтобы попытка утвердить отвергалась **на уровне
 * полномочия**, а §6.6 прямо предусматривает совмещение должностей по времени.
 *
 * Суммы сделки ОР не видит (§4.2 B7: сумма — самый сильный мотив ошибиться в
 * пользу «да, совпало»). Это ограничение **проекции** данных, а не полномочия:
 * `read_deal` здесь есть, а карточка обязана прийти без суммы — см. отчёт.
 */
const ORACLE_OPERATOR_CAPABILITIES = [
  'read_deal',
  'read_party',
  'order_extract',
  'record_observation',
  'lift_block',
  'halt_intake',
] as const satisfies readonly Capability[];
export type OracleOperatorCapability = (typeof ORACLE_OPERATOR_CAPABILITIES)[number];

/**
 * АН — комплаенс-аналитик. Разбирает очередь.
 *
 * `lift_block` сохранён, но он больше не значит «снять любую блокировку»:
 * `ACTORS.md` §5.3 расщепляет снятие по типу, и финансовые типы требуют второй
 * подписи (`approve_lift_block`), которой у аналитика нет. Аналитик снимает то,
 * что сам и поставил, и теряет право снимать финансовые блокировки.
 */
const COMPLIANCE_ANALYST_CAPABILITIES = [
  'read_deal',
  'read_party',
  'read_beneficiary',
  'run_screening',
  'adjudicate_screening',
  'lift_block',
  'halt_intake',
] as const satisfies readonly Capability[];
export type ComplianceAnalystCapability = (typeof COMPLIANCE_ANALYST_CAPABILITIES)[number];

/**
 * КО — комплаенс-офицер. Должность, предписанная законом (`ACTORS.md` §2,
 * сила 1): ответственное лицо уровня руководства по AML-закону.
 *
 * `export_personal_data` и `erase_personal_data` выданы ему по рекомендации Р4
 * варианта A (совмещение на пилоте). Срок в три рабочих дня идёт независимо от
 * того, назначен адресат или нет; полномочие без носителя означает, что срок
 * идёт и ответить некому.
 *
 * `approve_payout` не выдан: `ACTORS.md` §5.2 — уровень утверждения дают только
 * ФК и РО. §6.5–6.6 при этом формулирует запрет как «не может утверждать выплату
 * **по сделке, где принимал решение по источнику средств**», что читается как
 * разрешение в остальных случаях. Прочтения два, выбрано строгое — см. отчёт.
 */
const COMPLIANCE_OFFICER_CAPABILITIES = [
  'read_deal',
  'read_party',
  'read_beneficiary',
  'read_audit',
  'run_screening',
  'adjudicate_screening',
  'lift_block',
  'export_personal_data',
  'erase_personal_data',
  'halt_intake',
] as const satisfies readonly Capability[];
export type ComplianceOfficerCapability = (typeof COMPLIANCE_OFFICER_CAPABILITIES)[number];

/**
 * ФК — финансовый контролёр. **Первое** утверждение, уровень 1 (`ACTORS.md`
 * §5.2). Сверка, покрытие, пофайловое обеспечение.
 */
const FINANCIAL_CONTROLLER_CAPABILITIES = [
  'read_deal',
  'read_party',
  'read_beneficiary',
  'approve_payout',
  'approve_beneficiary_change',
  'approve_lift_block',
  'lift_block',
  'lift_halt',
  'halt_intake',
] as const satisfies readonly Capability[];
export type FinancialControllerCapability = (typeof FINANCIAL_CONTROLLER_CAPABILITIES)[number];

/**
 * РО — руководитель операций. **Второе** утверждение, уровень 2. Нормативы
 * очереди, эскалации, участие в снятии остановки.
 *
 * Маржи не видит (`ACTORS.md` §4.3 C3: `◐` — человеко-часы и стоимость смены,
 * но не выручка). `read_economics` поэтому не выдан: полномочие даёт экономику
 * целиком, а `◐` — это другая проекция, и её носителя в перечне §5.1 нет.
 */
const HEAD_OF_OPERATIONS_CAPABILITIES = [
  'read_deal',
  'read_party',
  'read_beneficiary',
  'read_audit',
  'approve_payout',
  'approve_beneficiary_change',
  'approve_lift_block',
  'lift_halt',
  'halt_intake',
] as const satisfies readonly Capability[];
export type HeadOfOperationsCapability = (typeof HEAD_OF_OPERATIONS_CAPABILITIES)[number];

/**
 * ПД — поддержка.
 *
 * **Реквизитов выплаты здесь нет ни на чтение, ни на запись — никогда.**
 * `authorize(support, 'read_beneficiary')` не собирается, потому что такого
 * члена нет в `SupportCapability`. Это первый рубеж; второй — `beneficiaryDisclosure`,
 * который для поддержки возвращает `none` и не имеет варианта, возвращающего
 * значение. Третий — отсутствие полей в проекции, и он не здесь.
 *
 * `halt_intake` выдан: стоп-кран доступен любому сотруднику (`ACTORS.md` §7.3),
 * и он только сужает.
 */
const SUPPORT_CAPABILITIES = [
  'read_deal',
  'read_party',
  'act_on_behalf',
  'halt_intake',
] as const satisfies readonly Capability[];
export type SupportCapability = (typeof SUPPORT_CAPABILITIES)[number];

/**
 * ВЛ — владелец. Отдельная роль, **а не оператор с расширенными правами**
 * (`ROADMAP.md`:65).
 *
 * Имя `principal`, а не `owner`: `owner` занято ролью базы (`OWNER_ROLE =
 * 'sdelka_owner'`, `packages/db/src/roles.ts`), и на её отделении от `sdelka_app`
 * стоит инвариант 21. Рекомендация `ACTORS.md` §11 Р1 вариант A.
 *
 * Здесь ровно два класса действий — `read` и `govern` — и это проверяется
 * инвариантом `roleInvariantViolations`, а не перечислением запретов: список
 * запрещённых полномочий устаревает при добавлении следующего, список
 * разрешённых классов — нет. Н6: видит маржу ⇒ не имеет ни одного полномочия с
 * денежным эффектом. Ни утвердить, ни снять, ни выплатить, ни остановить.
 *
 * `halt_intake` не выдан, хотя §7.3 говорит «любой сотрудник»: §0 п.11 говорит
 * «ни одного полномочия с денежным эффектом», а остановка приёма — денежный
 * эффект на всю платформу. Два места документа расходятся; взято строгое.
 *
 * Имён клиентов не видит (§4.5): `read_party` отсутствует.
 */
const PRINCIPAL_CAPABILITIES = [
  'read_deal',
  'read_economics',
  'manage_settings',
] as const satisfies readonly Capability[];
export type PrincipalCapability = (typeof PRINCIPAL_CAPABILITIES)[number];

/**
 * АУ — аудитор. Читает всё, включая ПДн и экономику. **Действий нет вовсе**
 * (`ACTORS.md` §6.11): наблюдателю действия не показываются, а не показываются
 * недоступными.
 */
const AUDITOR_CAPABILITIES = [
  'read_deal',
  'read_party',
  'read_beneficiary',
  'read_audit',
  'read_economics',
] as const satisfies readonly Capability[];
export type AuditorCapability = (typeof AUDITOR_CAPABILITIES)[number];

/**
 * ЮК — юрист клиента. По доверенности **одной** стороны, в объёме её
 * собственной видимости, с записью и уведомлением стороны.
 *
 * Разрезан с аудитором (`ACTORS.md` §6.12): у них противоположные границы, и
 * одна роль на двоих даёт либо аудитора без доступа, либо юриста с доступом ко
 * всей клиентской базе.
 */
const CLIENT_COUNSEL_CAPABILITIES = ['read_deal', 'read_party'] as const satisfies
  readonly Capability[];
export type ClientCounselCapability = (typeof CLIENT_COUNSEL_CAPABILITIES)[number];

/**
 * Тип полномочий по роли. Запись тотальная: новая роль без перечня полномочий
 * не собирается.
 */
export interface RoleCapabilityMap {
  readonly party: PartyCapability;
  readonly representative: RepresentativeCapability;
  readonly operator: OperatorCapability;
  readonly oracle_operator: OracleOperatorCapability;
  readonly compliance_analyst: ComplianceAnalystCapability;
  readonly compliance_officer: ComplianceOfficerCapability;
  readonly financial_controller: FinancialControllerCapability;
  readonly head_of_operations: HeadOfOperationsCapability;
  readonly support: SupportCapability;
  readonly principal: PrincipalCapability;
  readonly auditor: AuditorCapability;
  readonly client_counsel: ClientCounselCapability;
}

/** Полномочия, доступные роли `R`, как **тип**. Даёт компиляционный рубеж. */
export type CapabilityOf<R extends RoleId> = RoleCapabilityMap[R];

/** Полномочия, доступные роли, как **значение**. Даёт рантайм-рубеж. */
export const ROLE_CAPABILITIES: Readonly<Record<RoleId, readonly Capability[]>> = Object.freeze({
  party: PARTY_CAPABILITIES,
  representative: REPRESENTATIVE_CAPABILITIES,
  operator: OPERATOR_CAPABILITIES,
  oracle_operator: ORACLE_OPERATOR_CAPABILITIES,
  compliance_analyst: COMPLIANCE_ANALYST_CAPABILITIES,
  compliance_officer: COMPLIANCE_OFFICER_CAPABILITIES,
  financial_controller: FINANCIAL_CONTROLLER_CAPABILITIES,
  head_of_operations: HEAD_OF_OPERATIONS_CAPABILITIES,
  support: SUPPORT_CAPABILITIES,
  principal: PRINCIPAL_CAPABILITIES,
  auditor: AUDITOR_CAPABILITIES,
  client_counsel: CLIENT_COUNSEL_CAPABILITIES,
});

export const ROLE_SPECS: Readonly<Record<RoleId, RoleSpec>> = Object.freeze({
  party: { audience: 'client', dutyEligible: false, source: 'ACTORS.md §6.1' },
  representative: { audience: 'client', dutyEligible: false, source: 'ACTORS.md §6.2' },
  operator: { audience: 'console', dutyEligible: true, source: 'ACTORS.md §6.3' },
  oracle_operator: { audience: 'console', dutyEligible: false, source: 'ACTORS.md §6.4' },
  compliance_analyst: { audience: 'console', dutyEligible: false, source: 'ACTORS.md §6.5' },
  compliance_officer: { audience: 'console', dutyEligible: false, source: 'ACTORS.md §6.6' },
  financial_controller: { audience: 'console', dutyEligible: true, source: 'ACTORS.md §6.7' },
  head_of_operations: { audience: 'console', dutyEligible: true, source: 'ACTORS.md §6.8' },
  support: { audience: 'console', dutyEligible: false, source: 'ACTORS.md §6.9' },
  principal: { audience: 'console', dutyEligible: false, source: 'ACTORS.md §6.10' },
  auditor: { audience: 'external', dutyEligible: false, source: 'ACTORS.md §6.11' },
  client_counsel: { audience: 'external', dutyEligible: false, source: 'ACTORS.md §6.12' },
});

/**
 * Полномочия дежурства — `ACTORS.md` §7.3. Ровно три, все сужающие, ни одного
 * расширяющего. Дежурный **не снимает** остановку и не размораживает участие.
 */
export const DUTY_CAPABILITIES = [
  'confirm_incident',
  'halt_intake',
  'freeze_participation',
] as const satisfies readonly Capability[];
export type DutyCapability = (typeof DUTY_CAPABILITIES)[number];

export function roleHasCapability(roleId: RoleId, capability: Capability): boolean {
  return ROLE_CAPABILITIES[roleId].includes(capability);
}

/**
 * Полномочия роли с учётом дежурства. Дежурство **добавляет** три сужающих и не
 * убирает ничего: базовая роль и её запреты остаются в силе (§7.1 п.2).
 */
export function effectiveCapabilities(roleId: RoleId, onDuty: boolean): readonly Capability[] {
  const base = ROLE_CAPABILITIES[roleId];
  if (!onDuty) return base;
  const merged = new Set<Capability>(base);
  for (const capability of DUTY_CAPABILITIES) merged.add(capability);
  return Object.freeze([...merged]);
}

/* ------------------------------------------------------------------------- */
/* Раскрытие реквизитов выплаты                                              */
/* ------------------------------------------------------------------------- */

/**
 * Что роль видит в реквизитах выплаты — `ACTORS.md` §4.2 B3, §8 п.1.
 *
 * **[решение документа] Полного значения не видит ни одна внутренняя роль.**
 * Не «поддержка не видит» — не видит никто. Поэтому `full` в объединении есть
 * ровно для стороны (это её собственные реквизиты), а разовая выдача аналитику
 * и офицеру при разборе «это не я» — отдельное значение `by_exception`: она
 * идёт с записью в журнал и уведомлением стороны, то есть это другой процесс, а
 * не тот же доступ пошире.
 *
 * Запись тотальная: новая роль обязана ответить на этот вопрос, и ответ по
 * умолчанию не выдаётся.
 */
export type BeneficiaryDisclosure = 'none' | 'status_only' | 'masked' | 'by_exception' | 'full';

export const BENEFICIARY_DISCLOSURE: Readonly<Record<RoleId, BeneficiaryDisclosure>> =
  Object.freeze({
    party: 'full',
    representative: 'status_only',
    operator: 'masked',
    oracle_operator: 'none',
    compliance_analyst: 'by_exception',
    compliance_officer: 'by_exception',
    financial_controller: 'masked',
    head_of_operations: 'masked',
    /** Никогда. Ни значения, ни маски — только статус (§4.2 B4). */
    support: 'status_only',
    principal: 'none',
    auditor: 'by_exception',
    client_counsel: 'none',
  });

export function beneficiaryDisclosure(roleId: RoleId): BeneficiaryDisclosure {
  return BENEFICIARY_DISCLOSURE[roleId];
}

/* ------------------------------------------------------------------------- */
/* Инварианты карты ролей                                                    */
/* ------------------------------------------------------------------------- */

/** Классы действий, разрешённые владельцу. Н6, `ACTORS.md` §0 п.11. */
const PRINCIPAL_ALLOWED_EFFECTS: readonly CapabilityEffect[] = Object.freeze(['read', 'govern']);

/**
 * Проверки, которые карта ролей обязана выдерживать всегда. Возвращает ключи
 * нарушений, а не бросает: вызывающий — тест, и ему нужен перечень, а не первое.
 *
 * Это не украшение. Каждая из проверок соответствует правилу, которое сегодня
 * записано только прозой, и проза не ломается при правке кода.
 */
export function roleInvariantViolations(): readonly string[] {
  const violations: string[] = [];

  for (const roleId of ROLE_IDS) {
    for (const capability of ROLE_CAPABILITIES[roleId]) {
      if (!CAPABILITIES.includes(capability)) {
        violations.push(`unknown_capability:${roleId}:${capability}`);
      }
    }
  }

  // Н6: владелец видит экономику ⇒ ни одного действия с денежным эффектом.
  for (const capability of ROLE_CAPABILITIES.principal) {
    const effect = CAPABILITY_SPECS[capability].effect;
    if (!PRINCIPAL_ALLOWED_EFFECTS.includes(effect)) {
      violations.push(`principal_effect:${capability}:${effect}`);
    }
  }

  // §5.2: никакая роль не даёт оба уровня утверждения — проверяется в approval.ts,
  // здесь проверяется противоположное: утверждать может только тот, у кого есть уровень.

  // §7.3: дежурство добавляет только сужающие полномочия.
  for (const capability of DUTY_CAPABILITIES) {
    if (CAPABILITY_SPECS[capability].effect !== 'narrow') {
      violations.push(`duty_widens:${capability}`);
    }
  }

  // §4.2 B3: полного значения реквизитов не видит ни одна внутренняя роль.
  for (const roleId of ROLE_IDS) {
    if (ROLE_SPECS[roleId].audience === 'client') continue;
    if (BENEFICIARY_DISCLOSURE[roleId] === 'full') {
      violations.push(`beneficiary_full_value:${roleId}`);
    }
  }

  // §6.9: у поддержки нет полномочия на реквизиты ни в каком виде.
  for (const capability of ROLE_CAPABILITIES.support) {
    if (capability === 'read_beneficiary' || capability === 'write_beneficiary') {
      violations.push(`support_beneficiary:${capability}`);
    }
  }

  // §6.11: у аудитора нет ни одного действия.
  for (const capability of ROLE_CAPABILITIES.auditor) {
    if (CAPABILITY_SPECS[capability].effect !== 'read') {
      violations.push(`auditor_acts:${capability}`);
    }
  }

  // Полномочие, не выданное ни одной роли, — это либо пробел документа, либо
  // умышленный тупик. Умышленный здесь один: `manage_access`, см. его комментарий.
  for (const capability of CAPABILITIES) {
    if (capability === 'manage_access') continue;
    const held = ROLE_IDS.some((roleId) => ROLE_CAPABILITIES[roleId].includes(capability));
    const byDuty = (DUTY_CAPABILITIES as readonly Capability[]).includes(capability);
    if (!held && !byDuty) {
      violations.push(`capability_held_by_no_role:${capability}`);
    }
  }

  return Object.freeze(violations);
}
