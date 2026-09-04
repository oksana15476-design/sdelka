import type { Capability } from './capabilities';
import { CAPABILITY_SPECS } from './capabilities';
import { assertExhausted } from './errors';
import { type AuthReasonKey, AUTH_REASON_KEYS } from './keys';
import type { ActorFact, ActorRef } from './ids';
import { UNKNOWN_FACT, includesActor } from './ids';
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
 * **Все четыре поля обязательны, и у каждого три ответа, а не два.** Пустой
 * перечень значит «никто» — это утверждение вызывающего, за которое он отвечает;
 * `UNKNOWN_FACT` значит «не выяснял» — и тогда несовместимость, которой нужен
 * этот факт, не считается пройденной, а даёт нарушение с ключом
 * `sodContextUnknown`.
 *
 * Прежняя редакция просила того же прозой («вызывающий обязан не вызвать решение,
 * а не подставить пустоту») и не давала это выразить: у пустоты и незнания была
 * одна форма записи. Проза не ломается при правке кода — тип ломается.
 */
export interface ActionContext {
  /** Кто готовил операцию, по которой запрашивается утверждение. Н1. */
  readonly preparedBy: ActorFact;
  /** Кто вносил наблюдение оракула по этой сделке. Н2. */
  readonly observedBy: ActorFact;
  /** Кто запрашивал или вводил изменение реквизитов. Н4. */
  readonly beneficiaryChangeRequestedBy: ActorFact;
  /** Чьё действие вызвало расхождение или остановку. Н5. */
  readonly causedBy: ActorFact;
}

/**
 * Контекст, в котором не известно ничего.
 *
 * Он **не** «пустой»: полномочие, связанное хоть одной несовместимостью на
 * фактах, с ним не выдаётся. Годится ровно там, где фактов и не требуется, —
 * чтение сделки, стоп-кран, — и именно поэтому им нельзя молча закрыть
 * утверждение выплаты. Прежний `EMPTY_CONTEXT` делал ровно это: четыре пустых
 * перечня отключали Н1, Н2, Н4 и Н5 разом и без следа.
 */
export const UNKNOWN_CONTEXT: ActionContext = Object.freeze({
  preparedBy: UNKNOWN_FACT,
  observedBy: UNKNOWN_FACT,
  beneficiaryChangeRequestedBy: UNKNOWN_FACT,
  causedBy: UNKNOWN_FACT,
});

export interface SodViolation {
  readonly rule: SodRuleId;
  readonly reason: AuthReasonKey;
}

/**
 * Проверка одной несовместимости, стоящей на факте.
 *
 * Три исхода, а не два: лицо в перечне — нарушение с причиной правила; лица нет —
 * чисто; факт неизвестен — нарушение с причиной «проверить нечем». Третий исход
 * и есть вся правка: раньше он был неотличим от второго.
 */
function checkActorFact(
  violations: SodViolation[],
  rule: SodRuleId,
  fact: ActorFact,
  actor: ActorRef,
  reason: AuthReasonKey,
): void {
  if (fact === UNKNOWN_FACT) {
    violations.push({ rule, reason: AUTH_REASON_KEYS.sodContextUnknown });
    return;
  }
  if (includesActor(fact, actor)) {
    violations.push({ rule, reason });
  }
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
        checkActorFact(
          violations,
          rule,
          context.preparedBy,
          actor,
          AUTH_REASON_KEYS.sodPreparerCannotApprove,
        );
        break;

      case 'n2_observer_not_approver':
        checkActorFact(
          violations,
          rule,
          context.observedBy,
          actor,
          AUTH_REASON_KEYS.sodObserverCannotApprove,
        );
        break;

      case 'n3_levels_distinct':
        // На одном утверждающем правило вырождается в «роль вообще даёт уровень».
        // Различность уровней между двумя подписями проверяет `evaluateQuorum`.
        if (APPROVAL_LEVELS[roleId] === null) {
          violations.push({ rule, reason: AUTH_REASON_KEYS.sodApprovalLevelMissing });
        }
        break;

      case 'n4_requester_not_approver':
        checkActorFact(
          violations,
          rule,
          context.beneficiaryChangeRequestedBy,
          actor,
          AUTH_REASON_KEYS.sodRequesterCannotApprove,
        );
        break;

      case 'n5_causer_not_lifter':
        checkActorFact(
          violations,
          rule,
          context.causedBy,
          actor,
          AUTH_REASON_KEYS.sodCauserCannotLift,
        );
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
