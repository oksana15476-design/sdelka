import type { Capability } from './capabilities';
import { CAPABILITY_SPECS } from './capabilities';
import { assertExhausted } from './errors';
import { type AuthReasonKey, AUTH_REASON_KEYS } from './keys';
import type { ActorRef } from './ids';
import { includesActor } from './ids';
import { APPROVAL_LEVELS } from './approval';
import { type RoleId, roleHasCapability } from './roles';

/**
 * Разделение обязанностей — **на уровне права, а не дисциплины**.
 *
 * Шесть несовместимостей `ACTORS.md` §2. Каждая здесь названа, у каждой свой
 * ключ причины, и каждая проверяется поимённо: несовместимость, склеенная с
 * соседней, невозможна к проверке по частям, и это то же правило, по которому
 * `STATE-MACHINES.md` §7 требует именовать guard'ы.
 *
 * Почему этого мало на уровне ролей. Роль, у которой полномочия просто нет,
 * защищена компилятором — но `ACTORS.md` §6.6 прямо предусматривает совмещение
 * должностей **по времени** (офицер 0,3 FTE, руководитель операций 0,07 FTE), а
 * §9 случай 5 объявляет пересечение невозможным на том основании, что учётные
 * записи разные. Разными они останутся; человек может стать одним. Поэтому
 * правила ниже сравнивают лица, а не только учётные записи.
 */
export const SOD_RULES = [
  /** Н1. Готовил ≠ утверждает. */
  'n1_preparer_not_approver',
  /** Н2. Установил факт регистрации ≠ утвердил выплату по той же сделке. */
  'n2_observer_not_approver',
  /** Н3. Первое утверждение ≠ второе утверждение. */
  'n3_levels_distinct',
  /** Н4. Ввёл или изменил реквизиты ≠ утвердил изменение. */
  'n4_requester_not_approver',
  /** Н5. Вызвал расхождение ≠ снял остановку. */
  'n5_causer_not_lifter',
  /** Н6. Видит маржу ≠ имеет полномочие с денежным эффектом. */
  'n6_economics_not_money',
] as const;

export type SodRuleId = (typeof SOD_RULES)[number];

/**
 * Какие несовместимости связывают это полномочие.
 *
 * **Второе место разбора перечня полномочий.** Исчерпывающий `switch`:
 * добавление полномочия ломает компиляцию здесь, и автор обязан ответить, какие
 * несовместимости его связывают. Ответ «никакие» законен, но он должен быть
 * написан явно, а не получиться по умолчанию — умолчание здесь означает
 * «разрешено всем и всегда».
 */
export function separationRulesFor(capability: Capability): readonly SodRuleId[] {
  switch (capability) {
    /* Чтение никого ни с кем не разводит — кроме Н6: экономика и деньги. */
    case 'read_deal':
    case 'read_party':
    case 'read_beneficiary':
    case 'read_audit':
      return EMPTY;
    case 'read_economics':
      return N6;

    /* Подготовка операции. Разведение происходит на утверждении, не здесь. */
    case 'create_deal':
    case 'invite_party':
    case 'verify_property':
    case 'record_condition_act':
    case 'order_extract':
    case 'record_observation':
    case 'run_screening':
    case 'write_beneficiary':
    case 'confirm_test_transfer_code':
    case 'act_on_behalf':
      return EMPTY;

    /* Утверждение выплаты — три несовместимости сразу. */
    case 'approve_payout':
      return Object.freeze([
        'n1_preparer_not_approver',
        'n2_observer_not_approver',
        'n3_levels_distinct',
        'n6_economics_not_money',
      ]);

    /* Утверждение изменения реквизитов: Н4 и Н1. */
    case 'approve_beneficiary_change':
      return Object.freeze([
        'n1_preparer_not_approver',
        'n4_requester_not_approver',
        'n6_economics_not_money',
      ]);

    /* Снятие блокировки: вторая подпись, и она не автора и не запросившего. */
    case 'approve_lift_block':
      return Object.freeze([
        'n1_preparer_not_approver',
        'n4_requester_not_approver',
        'n5_causer_not_lifter',
        'n6_economics_not_money',
      ]);

    /* Первая половина снятия — автор расхождения её не делает. */
    case 'lift_block':
    case 'lift_halt':
      return Object.freeze(['n5_causer_not_lifter', 'n6_economics_not_money']);

    /* Разбор санкционного хита — решение с денежным эффектом. */
    case 'adjudicate_screening':
      return N6;

    /* Сужающие. Работают ночью и в одиночку — их не разводит ничего (§7.3). */
    case 'halt_intake':
    case 'freeze_participation':
    case 'confirm_incident':
      return EMPTY;

    /* Рычаги и доступ: Н6 не о них — владельцу они и принадлежат. */
    case 'manage_settings':
    case 'manage_access':
      return EMPTY;

    /* Персональные данные — комплаенс-периметр, разведений нет. */
    case 'export_personal_data':
    case 'erase_personal_data':
      return EMPTY;

    default:
      return assertExhausted(capability);
  }
}

const EMPTY: readonly SodRuleId[] = Object.freeze([]);
const N6: readonly SodRuleId[] = Object.freeze(['n6_economics_not_money']);

/**
 * Факты о том, кто что уже делал. Пакет их не добывает — они приходят из
 * журнала и из состояния сделки, ровно как факты guard'ов в `packages/domain`.
 *
 * Пустой перечень значит «никто», а не «неизвестно». Разница существенная:
 * если вызывающий не знает, кто готовил операцию, он обязан не вызвать решение,
 * а не подставить пустоту — иначе Н1 отключается молчанием.
 */
export interface ActionContext {
  /** Кто готовил операцию, по которой запрашивается утверждение. Н1. */
  readonly preparedBy: readonly ActorRef[];
  /** Кто вносил наблюдение оракула по этой сделке. Н2. */
  readonly observedBy: readonly ActorRef[];
  /** Кто запрашивал или вводил изменение реквизитов. Н4. */
  readonly beneficiaryChangeRequestedBy: readonly ActorRef[];
  /** Чьё действие вызвало расхождение или остановку. Н5. */
  readonly causedBy: readonly ActorRef[];
}

export const EMPTY_CONTEXT: ActionContext = Object.freeze({
  preparedBy: Object.freeze([]),
  observedBy: Object.freeze([]),
  beneficiaryChangeRequestedBy: Object.freeze([]),
  causedBy: Object.freeze([]),
});

export interface SodViolation {
  readonly rule: SodRuleId;
  readonly reason: AuthReasonKey;
}

/**
 * Проверка несовместимостей для одного действующего лица.
 *
 * Возвращает **все** нарушения, а не первое: оператору надо показать, чего не
 * хватает целиком, иначе он будет чинить их по одному, каждый раз получая новый
 * отказ.
 */
export function evaluateSeparation(
  capability: Capability,
  roleId: RoleId,
  actor: ActorRef,
  context: ActionContext,
): readonly SodViolation[] {
  const violations: SodViolation[] = [];

  for (const rule of separationRulesFor(capability)) {
    switch (rule) {
      case 'n1_preparer_not_approver':
        if (includesActor(context.preparedBy, actor)) {
          violations.push({ rule, reason: AUTH_REASON_KEYS.sodPreparerCannotApprove });
        }
        break;

      case 'n2_observer_not_approver':
        if (includesActor(context.observedBy, actor)) {
          violations.push({ rule, reason: AUTH_REASON_KEYS.sodObserverCannotApprove });
        }
        break;

      case 'n3_levels_distinct':
        // На одном утверждающем правило вырождается в «роль вообще даёт уровень».
        // Различность уровней между двумя подписями проверяет `evaluateQuorum`.
        if (APPROVAL_LEVELS[roleId] === null) {
          violations.push({ rule, reason: AUTH_REASON_KEYS.sodApprovalLevelMissing });
        }
        break;

      case 'n4_requester_not_approver':
        if (includesActor(context.beneficiaryChangeRequestedBy, actor)) {
          violations.push({ rule, reason: AUTH_REASON_KEYS.sodRequesterCannotApprove });
        }
        break;

      case 'n5_causer_not_lifter':
        if (includesActor(context.causedBy, actor)) {
          violations.push({ rule, reason: AUTH_REASON_KEYS.sodCauserCannotLift });
        }
        break;

      case 'n6_economics_not_money':
        /*
         * Роль, видящая экономику компании, не совершает действий с денежным
         * эффектом, и наоборот. Проверка идёт по классу действия, а не по
         * перечню запрещённых полномочий: перечень устареет на следующем.
         */
        if (
          roleHasCapability(roleId, 'read_economics') &&
          CAPABILITY_SPECS[capability].effect === 'release'
        ) {
          violations.push({ rule, reason: AUTH_REASON_KEYS.sodEconomicsExcludesMoney });
        }
        break;

      default:
        assertExhausted(rule);
    }
  }

  return Object.freeze(violations);
}
