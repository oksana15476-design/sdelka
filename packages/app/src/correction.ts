import {
  type AuditRecord,
  type RawSourceRef,
  appendRecord,
  auditInstant,
  correctionsOf,
  findRecord,
} from '@sdelka/audit';
import { type Authority, assertOrigin, journalActor } from './authority';
import { auditRecordId } from './ids';
import { type World, sealed } from './world';

/**
 * Исправление записи журнала — путь из продукта.
 *
 * ## Зачем модуль появился
 *
 * Красная линия №11 состоит из двух половин: «журнал не редактируется» и
 * «исправление — только новой записью со ссылкой на предыдущую». Первая
 * держалась (в пакете аудита нет ни одной операции, меняющей запись; база
 * отбирает `UPDATE`/`DELETE` у роли приложения), **вторая не существовала**.
 * Механизм был построен целиком — тело `CorrectionBody`, проверки самоссылки и
 * отсутствующей цели в `chain.ts` и в триггере `0007_audit.sql`, сбор
 * `correctionsOf`/`effectiveView`, включение в досье `reconstructPayout`, — и
 * ни одна строка продукта его не звала: все вызовы `appendRecord` строили
 * `decision_made`, `state_transition`, `condition_act_recorded`,
 * `evidence_attached`, `payout_ordered`, `payout_result`.
 *
 * Причём путь был закрыт **типом**, а не просто не написан: `World` брендирован
 * модуль-локальным символом (`world.ts`), `sealed` наружу не экспортируется, и
 * потребитель, позвавший `appendRecord` прямо из `@sdelka/audit`, вернуть
 * полученную цепочку в мир не мог. То есть журнал был не «неизменяемый и
 * исправляемый», как обещает красная линия и как печатает оператору консоль
 * операций, а просто **неисправимый**: ошибочная запись оставалась навсегда, и
 * опровергнуть её по правилам было нечем.
 *
 * ## Что именно можно исправить, и почему так узко
 *
 * Ответ взят у самого `@sdelka/audit`, а не выбран по вкусу.
 *
 * 1. **Исправление ничего не подменяет.** `corrections.ts` пишет об этом
 *    прямо: «действующее представление — это не подмена исходной записи, а
 *    исходная запись плюс упорядоченная цепочка исправлений к ней», и
 *    `reconstructPayout` это подтверждает поведением — `result`, `ordered`,
 *    `decisions` и `policies` он считает по исходным записям и **после**
 *    исправления. Значит исправлением можно тронуть только то, чей
 *    единственный потребитель — читающий человек. Всё, из чего что-нибудь
 *    выводится, им не трогается.
 * 2. Отсюда — **`reasonKey` записи `payout_result`, и больше ничего**. Это
 *    единственное поле продукта, которое целиком является собственной
 *    классификацией вносящего: значение приходит от вызывающего
 *    (`TrancheEventOptions.payoutReasonKey`, `WithdrawalStepOptions.reasonKey`),
 *    ни один автомат его не читает, ни одна проводка на нём не стоит.
 *
 * ### Чего исправлять нельзя, и это ответ, а не пропуск
 *
 * - **Исход выплаты (`outcome`).** Его читает машина выплаты и по нему уходят
 *   деньги. Пометка на полях, расходящаяся с учётом, — это два разных ответа на
 *   один вопрос без способа их свести. Выход из «неизвестно» уже имеет путь и
 *   он не здесь: `reconciliation_resolved` через сверку (красная линия №8).
 * - **Сырой ответ (`response`).** Это не пересказ, а засвидетельствованные
 *   байты: связь держится отпечатком (`verifyRawSource`). «Не тот ответ» —
 *   значит приложен не тот документ, и лечится это приложением нужного, а не
 *   утверждением о нём.
 * - **Решение человека (`decision_made`).** Решение — это действие, а не
 *   высказывание о мире: оно двигало состояние и деньги. Исправление его не
 *   отменяет (досье соберёт его прежним) и создавало бы ровно ту иллюзию,
 *   которой в вечном журнале быть не должно, — что решение можно взять назад
 *   запиской. Отменяется решение новым решением: разбор отката, списание
 *   невостребованного, сверка.
 * - **Запись, сделанную «не тем актором».** Актор выводится из сессии
 *   (`journalActor`) и аргументом не приходит **нигде**. Значит запись под
 *   чужим именем означает не описку, а чужую сессию — это инцидент
 *   безопасности, а не исправление. И доказать такое исправление нечем: его
 *   собственный автор тоже берётся из сессии, то есть оно могло бы лишь
 *   **заявить** настоящего актора. Поля под такое заявление в `@sdelka/audit`
 *   нет, и заводить его значило бы дать способ переписать авторство пометкой.
 *
 * ## Чего здесь нет намеренно
 *
 * **Второй подписи.** Соблазн велик — запись вечная, — но `unwind.ts` называет
 * ровно этот приём вредным: проверка утверждающих живёт в guard'е домена, и
 * второй её экземпляр в приложении означает, что снятие guard'а ничего не
 * меняет. Guard'а под исправлением в домене нет вовсе, поэтому кворум,
 * поставленный здесь, стоял бы **только** здесь и держался бы дисциплиной. Нужна
 * ли под исправлением вторая подпись — вопрос владельца, он назван [открыто] в
 * `docs/product/APP-LAYER.md`.
 *
 * **Нового полномочия.** Взято существующее — `record_bank_outcome`, «внешний
 * факт платежа: ответ провайдера и банковская выписка» (`origins.ts`). Оно и
 * есть то полномочие, под которым `reasonKey` был записан; исправление
 * собственной формулировки нового права не даёт. Заводить своё значило бы
 * править `CAPABILITIES`, `separationRulesFor`, `roles.ts` и метку перечня
 * `sdelka.capability` в базе одним заходом — то есть решать за владельца
 * вопрос, которого он не ставил.
 */

/* ------------------------------------------------------------------------- */
/* Что исправляется                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Имя исправляемого поля — **значение, а не строка на месте вызова**.
 *
 * Живёт в атрибутах исправления и по нему исправление узнаётся при исправлении
 * исправления. Точка внутри допустима формой `AUDIT_TOKEN`.
 */
export const CORRECTED_FIELD = 'payout_result.reasonKey';

export interface CorrectionRequest {
  /** Запись, которую исправляем. Ссылка обязательна и типом, и цепочкой. */
  readonly correctsRecordId: string;
  /** Почему исправляем — ключ локализации. Текста в коде нет. */
  readonly reasonKey: string;
  /**
   * На основании чего. Служебная записка оператора — тоже основание, и она
   * выразима: `operator_note` в `RAW_SOURCE_KINDS`.
   */
  readonly basis: RawSourceRef;
  /** Ключ причины исхода, каким он должен был быть записан. */
  readonly statedReasonKey: string;
}

/**
 * Значение, которое исправление объявляет верным.
 *
 * Читается защитно: `attributes` — свободный `AuditAttributes`, типа за ним не
 * стоит, а запись могла приехать из базы (типы границу процесса не переживают).
 * Всё, что не строка под ключом `stated`, — «не наше исправление».
 */
export function statedReasonKeyOf(record: AuditRecord): string | null {
  const body = record.body;
  if (body.kind !== 'correction' || body.attributes['field'] !== CORRECTED_FIELD) {
    return null;
  }
  const stated = body.attributes['stated'];
  return typeof stated === 'string' ? stated : null;
}

/**
 * Цель исправления вместе с её корнем.
 *
 * Корень нужен затем, что исправить можно и **исправление** — иначе описка в
 * самой пометке осталась бы неисправимой, а это ровно тот дефект, который
 * закрывает весь модуль. Цепочка `correctsRecordId` разматывается до записи,
 * которая исправлением не является, и корень обязан быть `payout_result`:
 * пометка на пометке о чужом поле — не наш случай.
 */
function targetOf(world: World, recordId: string): AuditRecord {
  const target = findRecord(world.chain, recordId);
  if (target === null) {
    // Ссылка на запись, которой в цепочке нет, ссылкой не является. Проверка
    // стоит и в `appendRecord`, и в триггере базы; здесь она первая только
    // затем, чтобы отказ назывался на языке шага, а не цепочки.
    throw new Error(`app.correction.target_missing:${recordId}`);
  }
  let root = target;
  const seen = new Set<string>([root.recordId]);
  while (root.body.kind === 'correction') {
    if (statedReasonKeyOf(root) === null) {
      throw new Error(`app.correction.foreign_correction:${root.recordId}`);
    }
    const next = findRecord(world.chain, root.body.correctsRecordId);
    if (next === null || seen.has(next.recordId)) {
      // Цикл в цепочке исправлений построить нечем — исправляемая запись всегда
      // раньше исправляющей, — но цепочка могла приехать из хранилища.
      throw new Error(`app.correction.target_missing:${root.body.correctsRecordId}`);
    }
    seen.add(next.recordId);
    root = next;
  }
  if (root.body.kind !== 'payout_result') {
    throw new Error(`app.correction.kind_not_correctable:${root.body.kind}`);
  }
  return target;
}

/** Значение, которое исправление отменяет: либо прежняя пометка, либо запись. */
function recordedReasonKey(target: AuditRecord): string | null {
  const stated = statedReasonKeyOf(target);
  if (stated !== null) {
    return stated;
  }
  return target.body.kind === 'payout_result' ? target.body.reasonKey : null;
}

/**
 * Действующее значение ключа причины: исходная запись плюс исправления к ней.
 *
 * Ровно то, что `corrections.ts` называет «действующим представлением», и
 * ничего сверх: подмены исходной записи здесь нет — она читается прежней, а
 * это отдельный ответ на отдельный вопрос «что считать верным сейчас».
 *
 * Читатель нужен именно здесь, а не у вызывающего: `reconstructPayout`
 * исправления **не применяет** намеренно (досье обязано показывать исходное), и
 * консоль, складывающая пометки самостоятельно, сложила бы их по-своему.
 * `null` — записи нет либо она не `payout_result`.
 */
export function effectivePayoutReasonKey(world: World, recordId: string): string | null {
  const record = findRecord(world.chain, recordId);
  if (record === null || record.body.kind !== 'payout_result') {
    return null;
  }
  let effective = record.body.reasonKey;
  for (const correction of correctionsOf(world.chain, recordId)) {
    const stated = statedReasonKeyOf(correction);
    if (stated !== null) {
      effective = stated;
    }
  }
  return effective;
}

/* ------------------------------------------------------------------------- */
/* Шаг                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Исправить ключ причины у записанного исхода выплаты.
 *
 * Деньги не двигаются, состояние не меняется, исходная запись остаётся в
 * цепочке ровно такой, какой была: шаг только **дописывает**. Через `sealed`
 * он всё равно идёт — «инварианты после каждого шага» не знает исключений, и
 * среди них есть целостность самой цепочки (`audit_chain_broken`).
 *
 * Автора называть нечем: он выводится из `authority`, как на всех прочих шагах
 * мира. Поля вроде `options.actor` здесь нет и не будет — именно оно когда-то
 * позволяло записать в журнал одно имя, а в решение подставить другое.
 */
export function correctPayoutReason(
  world: World,
  request: CorrectionRequest,
  authority: Authority<'record_bank_outcome'>,
): World {
  assertOrigin(['record_bank_outcome'], authority, 'correction.payout_reason');
  const target = targetOf(world, request.correctsRecordId);
  if (request.reasonKey.length === 0) {
    // Исправление без причины — это правка, у которой нет объяснения, а значит
    // и способа отличить её от подгонки. Пустую строку не примет и сама запись
    // (`AUDIT_TOKEN`); отказ здесь только называет её понятнее.
    throw new Error(`app.correction.reason_required:${request.correctsRecordId}`);
  }
  if (request.statedReasonKey.length === 0) {
    // «Ключа не должно было быть вовсе» здесь невыразимо намеренно: снятие
    // значения молчанием — ровно то, от чего уходил `AuditSettingValue`.
    throw new Error(`app.correction.stated_reason_required:${request.correctsRecordId}`);
  }
  const recorded = recordedReasonKey(target);
  if (recorded === request.statedReasonKey) {
    // Исправление, ничего не меняющее, — шум в вечном журнале. Тот же отказ,
    // что у `settingChangeIsNoop` и `roleChangeIsNoop` в `@sdelka/audit`.
    throw new Error(`app.correction.is_noop:${request.correctsRecordId}`);
  }

  const seq = world.seq + 1;
  return sealed({
    ...world,
    seq,
    chain: appendRecord(world.chain, {
      recordId: auditRecordId(world.chain.chainId, seq),
      recordedAt: auditInstant(world.now),
      actor: journalActor(authority),
      // Предмет и связи берутся у исправляемой записи, а не называются заново:
      // исправление про выплату X обязано находиться там же, где выплата X.
      subject: target.subject,
      related: target.related,
      body: {
        kind: 'correction',
        correctsRecordId: target.recordId,
        reasonKey: request.reasonKey,
        basis: request.basis,
        attributes: {
          field: CORRECTED_FIELD,
          /** Что стояло в записи. `null` — не стояло ничего. */
          recorded,
          stated: request.statedReasonKey,
        },
      },
    }),
    checks: world.checks,
  });
}
