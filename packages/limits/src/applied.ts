import type { CompliancePolicy, QueuePolicy } from '@sdelka/compliance';
import type { Instant, Result } from '@sdelka/domain';
import { ok } from '@sdelka/domain';
import { type IntakePolicy, type IntakePolicyVersionId, intakePolicyVersionId } from '@sdelka/intake';
import type { SettingsRefusalKey, SettingsVersionId } from '@sdelka/settings';
import {
  type AmountToleranceSeries,
  type QueueAgeSeries,
  amountToleranceAtDisclosure,
  queueAgeBandsAt,
} from './series';

/**
 * **Подстановка версии в боевой путь.** Здесь величина, разрешённая журналом
 * версий, занимает место константы — и больше здесь не происходит ничего.
 *
 * ## Чего в этом файле нет и не должно появиться
 *
 * **Ни одной проверки величины.** Негодный порог отвергается **на записи
 * настройки** (`thresholds.ts`: дробная доля, доля больше самой суммы,
 * отрицательный абсолют, границы не по возрастанию, перечень без лари), и
 * вторая проверка здесь была бы не «на всякий случай», а вторым местом, где
 * правило живёт: два места расходятся, и расходятся молча. Подстановка обязана
 * быть подстановкой — значение уходит дальше **тем же объектом**, а не
 * пересобранным (это закреплено тестом на тождество ссылки, а не обещанием в
 * комментарии).
 *
 * **Ни одного расчёта.** Допуск считает `toleranceFor`/`effectiveTolerance`
 * (`@sdelka/intake`), уровень эскалации — `escalationLevel`/`prioritize`
 * (`@sdelka/compliance`). Формы значений совпадают поле в поле именно затем,
 * чтобы версия подставлялась как есть, и второй редакции расчёта не заводилось
 * ни одной.
 *
 * **Ни одного умолчания.** Нет действующей версии — отказ
 * (`SETTINGS_REFUSAL_KEYS.noVersionInEffect`), который вызывающий обязан
 * разобрать. `?? PROVISIONAL_…` компилируется, читается как забота о крайнем
 * случае и подставляет в деньги число, которого никто не выбирал. Временные
 * значения существуют затем, чтобы **ими завели первую версию** журнала, и
 * тогда они видны в журнале со своим основанием, а не спрятаны в коде.
 *
 * ## Почему этот файл здесь, а не в приёме и не в комплаенсе
 *
 * `@sdelka/compliance` не может зависеть от `@sdelka/limits` **по построению**:
 * `limits → settings → auth → compliance` — обратное ребро замкнуло бы цикл.
 * Пакет величин владельца лежит **над** доменными пакетами, а не между ними, и
 * подстановка живёт на той стороне, где она возможна для обоих потребителей
 * сразу. Одно место вместо двух — это ещё и одно место, где видно, что версия
 * величины и сама величина ходят вместе.
 */

/* ------------------------------------------------------------------------- */
/* Допуск по сумме → политика приёма                                         */
/* ------------------------------------------------------------------------- */

/**
 * Идентификатор версии допуска в пространстве имён приёма.
 *
 * Формы совпадают хвостом: `SettingsVersionId` — `<домен>/<ГГГГ-ММ-ДД>.<n>`,
 * `IntakePolicyVersionId` — `intake/<ГГГГ-ММ-ДД>.<n>`, и правая часть у них
 * одна и та же. Отказать конструктор приёма здесь не может: форма идентификатора
 * настройки строго уже (порядковый без ведущего нуля, дата проверена на
 * существование), поэтому перевод всегда законен.
 *
 * ⚠ **Пространство имён приёма при этом общее.** Выведенный идентификатор
 * совпадёт с рукописным `intake/<та же дата>.<тот же номер>`, если такой заведут.
 * Сегодня рукописный ровно один — `PROPOSED_INTAKE_POLICY` — и он существует
 * затем, чтобы им завели первую версию журнала, а не затем, чтобы жить рядом с
 * ней. Развилка «чем факт раскрытия называет версию допуска» вынесена в
 * `DECISIONS-REVIEW.md` §K6 **[открыто]**.
 */
function intakeVersionOf(versionId: SettingsVersionId): IntakePolicyVersionId {
  // Хвост — всё после первого разделителя. Своей проверки формы здесь нет
  // намеренно: её уже сделал конструктор идентификатора настройки, а второй раз
  // сделает конструктор приёма — и если хвост когда-нибудь окажется чужим,
  // бросит громко. Третьего места, где эта форма якобы проверяется, заводить
  // нельзя.
  const tail = versionId.slice(versionId.indexOf('/') + 1);
  return intakePolicyVersionId(`intake/${tail}`);
}

/** Допуск, действовавший в момент раскрытия, — вместе с версией, которая его дала. */
export interface AppliedTolerance {
  /** Версия в журнале настроек. Ею объясняется величина оператору и аудиту. */
  readonly versionId: SettingsVersionId;
  /** Та же версия в пространстве имён приёма — см. `intakeVersionOf`. */
  readonly policyVersionId: IntakePolicyVersionId;
  /**
   * Значение версии **как есть**. Тип — тамошний `TolerancePolicy`: если приём
   * когда-нибудь заведёт в допуске новое поле, сломается эта строка, а не
   * расчёт на боевом пути.
   */
  readonly tolerance: IntakePolicy['tolerance'];
}

export function tolerancePolicyAtDisclosure(
  series: AmountToleranceSeries,
  disclosedAt: Instant,
): Result<AppliedTolerance, SettingsRefusalKey> {
  const resolved = amountToleranceAtDisclosure(series, disclosedAt);
  if (!resolved.ok) return resolved;
  const applied = resolved.value.applied;
  return ok(
    Object.freeze({
      versionId: applied.versionId,
      policyVersionId: intakeVersionOf(applied.versionId),
      tolerance: applied.value,
    }),
  );
}

/**
 * Политика приёма, у которой допуск взят из журнала версий на момент раскрытия.
 *
 * **Версия политики заменяется вместе с допуском, и одно без другого
 * невозможно.** Причина не в аккуратности: `effectiveTolerance` сравнивает
 * `disclosure.policyVersionId` с `policy.version` и по расхождению объясняет
 * оператору, что раскрытие сделано под другую версию (`INTAKE.md` §3.3 п.4).
 * Подставить допуск, оставив прежний идентификатор, значило бы: величина
 * поменялась, а объяснение говорит «версия та же». Сумма при этом осталась бы
 * верной — минимум берётся всегда, — а вот причина, которую читает человек,
 * стала бы ложной. Поэтому идентификатор здесь не «тоже обновляется», а
 * является частью той же подстановки.
 *
 * Остальные величины политики (веса сопоставления, срок котировки, порог
 * дрейфа) остаются из `base`: они живут своей версией и настройкой пока не
 * стали.
 */
export function intakePolicyAtDisclosure(
  base: IntakePolicy,
  series: AmountToleranceSeries,
  disclosedAt: Instant,
): Result<IntakePolicy, SettingsRefusalKey> {
  const applied = tolerancePolicyAtDisclosure(series, disclosedAt);
  if (!applied.ok) return applied;
  return ok(
    Object.freeze({
      ...base,
      version: applied.value.policyVersionId,
      tolerance: applied.value.tolerance,
    }),
  );
}

/* ------------------------------------------------------------------------- */
/* Границы очереди → политика комплаенса                                     */
/* ------------------------------------------------------------------------- */

/** Границы очереди, действующие в названный момент наблюдения. */
export interface AppliedQueuePolicy {
  readonly versionId: SettingsVersionId;
  /**
   * Значение версии **как есть**. `QueueAgeBands` несёт сверх `QueuePolicy`
   * ссылку на обоснование — она уходит вместе со значением и никому не мешает:
   * очередь читает два поля, которые ей объявлены, и о третьем не знает.
   */
  readonly queue: QueuePolicy;
}

export function queuePolicyAt(
  series: QueueAgeSeries,
  observedAt: Instant,
): Result<AppliedQueuePolicy, SettingsRefusalKey> {
  const resolved = queueAgeBandsAt(series, observedAt);
  if (!resolved.ok) return resolved;
  const applied = resolved.value.applied;
  return ok(Object.freeze({ versionId: applied.versionId, queue: applied.value }));
}

/**
 * Политика комплаенса, у которой границы очереди взяты из журнала версий на
 * момент наблюдения.
 *
 * **Версия политики здесь, в отличие от приёма, не подменяется — и это не
 * забывчивость.** `CompliancePolicy.version` попадает в решение детектора и в
 * `ReviewTask.policyVersionId`: она называет политику, **которая приняла
 * решение**. Границы очереди ни одного решения не принимают — они задают
 * порядок разбора и уровень эскалации, то есть очередь, а не вывод. Подменить
 * идентификатор решения версией границ значило бы соврать о том, по какой
 * политике задача заведена. Версия границ при этом не теряется: она возвращается
 * рядом, в `AppliedQueuePolicy.versionId`, — тем, кому нужно объяснить уровень
 * эскалации.
 */
export function compliancePolicyAt(
  base: CompliancePolicy,
  series: QueueAgeSeries,
  observedAt: Instant,
): Result<CompliancePolicy, SettingsRefusalKey> {
  const applied = queuePolicyAt(series, observedAt);
  if (!applied.ok) return applied;
  return ok(Object.freeze({ ...base, queue: applied.value.queue }));
}
