/**
 * Роль владельца — **отдельная роль, а не оператор с расширенными правами**
 * (E16-1).
 *
 * Разделение здесь не косметическое и не про навигацию. Оно про две вещи,
 * которые нельзя совмещать в одном лице:
 *
 * 1. **Операционная роль не видит маржу компании.** Оператор решает про чужие
 *    деньги: утверждает выплату, снимает приостановку, разбирает непознанное.
 *    Сумма, которую компания заработает на этой сделке, для такого решения не
 *    аргумент, а искушение — и первый вопрос проверяющего будет именно о том,
 *    видел ли утверждающий, сколько мы на этом заработаем.
 * 2. **Владелец не утверждает выплату.** Утверждение — контроль над чужими
 *    деньгами, и он существует только пока утверждающие независимы. Владелец,
 *    имеющий право утвердить, обнуляет схему двух утверждений: он и есть тот,
 *    в чью пользу считается маржа.
 *
 * «Расширенные права» — это ровно тот способ, которым разделение теряется:
 * роль, включающая всё, что может оператор, плюс деньги компании, — это не
 * новая роль, а снятие обоих ограничений разом.
 *
 * ⚠ **Сегодня это модель, а не запрет.** Аутентификации в приложении нет вовсе
 * (задача «аутентификация и хранилище» открыта), поэтому кабинет владельца
 * доступен по адресу, как и консоль. Значение ниже — то, что сервер обязан
 * проверять, когда сессии появятся; здесь оно определяет навигацию и то, что
 * экран говорит о собственных границах.
 */

/** Полномочия, вокруг которых проходит граница ролей. */
export const CAPABILITIES = [
  /** Видеть выручку, себестоимость и маржу компании. */
  'view_company_money',
  /** Видеть и двигать тариф, наценку, пороги. */
  'view_tariff',
  /** Утверждать выплату. */
  'approve_payout',
  /** Разбирать очередь исключений: непознанное, сверка, приостановка. */
  'work_queue',
  /** Видеть остатки и движения по счёту клиента. */
  'view_client_account',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const ROLES = ['owner', 'operator'] as const;
export type Role = (typeof ROLES)[number];

const OWNER: readonly Capability[] = Object.freeze(['view_company_money', 'view_tariff']);

const OPERATOR: readonly Capability[] = Object.freeze([
  'approve_payout',
  'work_queue',
  'view_client_account',
]);

export const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = Object.freeze({
  owner: OWNER,
  operator: OPERATOR,
});

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

/**
 * Пересечения нет ни одного, и это проверяемое свойство, а не обещание в
 * комментарии: любое добавленное полномочие обязано попасть ровно в одну роль.
 */
export function overlappingCapabilities(): readonly Capability[] {
  return OWNER.filter((capability) => OPERATOR.includes(capability));
}

/** Полномочия, которых нет ни у одной роли: перечень не должен молча худеть. */
export function unassignedCapabilities(): readonly Capability[] {
  return CAPABILITIES.filter(
    (capability) => !OWNER.includes(capability) && !OPERATOR.includes(capability),
  );
}
