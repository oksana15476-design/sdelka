import type { Anchor } from '@sdelka/audit';
import type { Session } from '@sdelka/auth';
import {
  type BeneficiaryState,
  type ReviewTask,
  accountFingerprint,
  toBeneficiaryLock,
} from '@sdelka/compliance';
import {
  type Instant,
  type PayoutState,
  type TrancheFacts,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_OBSERVATION_POLICY,
  boundConditionAct,
  isTerminalTrancheStatus,
} from '@sdelka/domain';
import { type ClientKey, clientKey } from '@sdelka/ledger';
import { type CurrencyCode, type Money, isoDate } from '@sdelka/money';
import { initialObservationState } from '@sdelka/oracle';
import { seqOfEternalId } from './ids';
import {
  type RestoredDeal,
  type RestoredTranche,
  type RestoredWorld,
  type UnmappedPart,
  surfaceOfRestored,
} from './store';
import {
  type ActionFact,
  type CollectedClaim,
  type DealRuntime,
  type InvariantViolation,
  type Notification,
  type ObservationTask,
  type SuppressedEntry,
  type TrancheRuntime,
  type World,
  collectedClaimViolations,
  coverageOk,
  sealed,
  seedWorld,
  surfaceViolations,
} from './world';

/**
 * Продолжение мира, поднятого из хранилища.
 *
 * **Что здесь чинится.** `restoreWorld` отдаёт `RestoredWorld` — снимки, а не
 * мир, — и это было сделано намеренно: `World` собирается только запечатыванием,
 * поэтому «записать непроверенные данные» невыразимо в типах. Цена оказалась
 * ровно та, что и должна была: перезапущенный процесс поднимал состояние и
 * **ничего не мог с ним сделать**. Ни следующего шага, ни счётчика записей — то
 * есть первое же, что делал новый процесс с той же цепочкой, это встречал свои
 * собственные строки.
 *
 * **Как открыт путь и почему это не лазейка.** Четыре правила, и все четыре
 * держатся структурой:
 *
 * 1. *Подъём проходит ту же проверку, что запечатывание.* Не похожую копию, а
 *    ту же функцию: `surfaceViolations` над `InvariantSurface`, плюс притязания
 *    на собранное — той же `collectedClaimViolations`, которой считает их мир в
 *    памяти. Разойтись двум проверкам нечем: она одна.
 * 2. *Нарушение возвращается значением, а не молчанием и не исключением.*
 *    `Resumption` — размеченное значение: до мира можно дойти, только разобрав
 *    его, а отказ несёт список нарушенных инвариантов. Тот же приём, что у
 *    `recorded` (`world.ts`): расхождение обязано быть видно.
 * 3. *Выдумывать факты нечем.* Единственное, что подъём принимает снаружи, —
 *    **собранная сумма** по каждому живому траншу, и она немедленно проверяется
 *    учётом (притязания клиента против того, что учёт ему должен). Подписей,
 *    полномочий, реквизитов, наблюдений, следов «кто готовил» подъём не
 *    принимает **вовсе**: аргумента под них нет. Поэтому мир, собранный отсюда,
 *    строго **беднее** живого, а не богаче, и «набрать кворум подъёмом» —
 *    конструкция, которой нет.
 * 4. *Умолчания закрытые.* Всё, чего хранилище не знает, поднятый мир объявляет
 *    самым строгим известным значением: реквизитов нет (`draft`, отпечаток, под
 *    который счёта не существует), подписей нет, готовившего нет, кадастровый
 *    код пуст, источник счёта неизвестен, расхождение не снято. Каждое из них —
 *    отказ, а не разрешение, и каждое названо в `gaps` значением, а не
 *    примечанием в отчёте.
 *
 * **Что поднятый мир умеет и чего не умеет.** Умеет то, что обеспечено учётом:
 * довести транш до возврата покупателю (красная линия №7 — состояние по
 * умолчанию при бездействии обязано переживать перезапуск). Не умеет выплатить:
 * `g_approvals_sufficient` не набирается без подписей, `requireQuorum` не
 * находит готовившего, `g_beneficiary_verified` не проходит на `draft`, а
 * запись `payout_ordered` требует непустого пакета доказательств. Ни одно из
 * этих «не умеет» здесь не написано условием — все они следуют из закрытых
 * умолчаний.
 */

/* ------------------------------------------------------------------------- */
/* Реквизиты, которых у хранилища нет                                        */
/* ------------------------------------------------------------------------- */

/**
 * Отпечаток, которому не соответствует ни один счёт.
 *
 * Реквизиты выплаты в схеме не хранятся (`store.ts`, `TrancheSnapshot`), и
 * восстановить их неоткуда. Оставить поле пустым нельзя — тип его требует, —
 * а выдумать отпечаток настоящего счёта означало бы назвать получателя
 * выплаты, которого никто не называл (красная линия №9). Поэтому здесь стоит
 * значение, которое **не может** совпасть ни с одним отпечатком: хеш из одних
 * нулей — не результат хеширования, а его форма.
 *
 * Само по себе оно ничего не разрешает и не запрещает: запрещает статус
 * `draft` рядом. Обе половины вместе означают «реквизитов у этого мира нет».
 */
const NO_ACCOUNT = accountFingerprint('0'.repeat(64));

const UNKNOWN_BENEFICIARY: BeneficiaryState = Object.freeze({
  requisites: Object.freeze({
    account: NO_ACCOUNT,
    holderNames: Object.freeze([]),
    holderDocument: null,
    ownershipEvidence: null,
  }),
  // Начальный статус, а не `blocked`: блокировка — это **решение** комплаенса о
  // конкретных реквизитах, а решения здесь никто не принимал. `draft` не
  // проходит `g_beneficiary_verified` ровно так же.
  status: 'draft',
  locked: false,
  lastChangedAt: null,
});

/* ------------------------------------------------------------------------- */
/* Объявление собранного                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Собранное по траншу, объявленное поднимающим.
 *
 * **Почему это приходит аргументом, а не берётся из базы.** Отнесение
 * поступления на транш в журнале не записано: зачисление кредитует свободную
 * часть счёта клиента, где траншей не видно (`world.ts`, `collected_not_backed`).
 * Вывести собранное из журнала нельзя — но **проверить** можно, и проверяется
 * оно здесь тем же правилом, что у мира в памяти: сумма притязаний живых
 * траншей одного клиента не может превышать того, что учёт этому клиенту
 * должен. Объявление, которое учёт не выдерживает, подъём отвергает.
 *
 * **Почему объявление обязательно для каждого живого транша.** Молчание
 * означало бы `null` — «собранного нет», — и возврат посчитался бы от
 * требуемой суммы вместо собранной (`flow.ts`, `collectedAmount ??
 * requiredAmount`). У недоплаченного транша это возврат чужих денег. Поэтому
 * «нечего объявлять» пишется словом: `collected: null`.
 */
export interface ResumeDeclaration {
  readonly trancheId: string;
  /** `null` — денег по этому траншу не собрано. Не «мы не знаем», а «их нет». */
  readonly collected: Money<CurrencyCode> | null;
}

/**
 * Чем продолжается поднятый мир: часы нового процесса и объявления собранного.
 *
 * Часов в хранилище нет и быть не может — время не состояние. Их приносит тот,
 * кто поднимает: тот же аргумент, что у `emptyWorld`.
 */
export interface ResumeSeed {
  readonly now: Instant;
  readonly declared: readonly ResumeDeclaration[];
}

/* ------------------------------------------------------------------------- */
/* Исход подъёма                                                             */
/* ------------------------------------------------------------------------- */

export type Resumption =
  | {
      readonly kind: 'resumed';
      readonly world: World;
      /** Чего поднятый мир не знает. Пустым не бывает: хранилище знает не всё. */
      readonly gaps: readonly UnmappedPart[];
    }
  | {
      readonly kind: 'refused';
      /** Нарушенные инварианты — те же, что остановили бы шаг. */
      readonly violations: readonly InvariantViolation[];
      /** Чего не хватило, чтобы вопрос об инвариантах вообще был законным. */
      readonly missing: readonly UnmappedPart[];
    };

function part(subject: string, reasonKey: string): UnmappedPart {
  return Object.freeze({ subject, reasonKey });
}

/**
 * Чего поднятый мир не знает — список **структурный**, одинаковый при любом
 * содержимом базы: перечислено то, чего у хранилища нет вовсе.
 */
const GAPS: readonly UnmappedPart[] = Object.freeze([
  part('tranche.beneficiary', 'beneficiary.not_storable'),
  part('tranche.approvals', 'approvals.not_storable'),
  part('tranche.evidence', 'evidence.not_storable'),
  part('tranche.observation', 'observation.not_storable'),
  part('tranche.buyer_payer_key', 'payer_key.not_storable'),
  part('tranche.buyer_names', 'names.not_storable'),
  part('tranche.deductions', 'tariff.not_storable'),
  part('tranche.created_on', 'created_on.not_storable'),
  part('deal.object_cadastral_code', 'deal.object_not_storable'),
  part('sessions', 'port.no_method'),
  part('facts', 'port.no_method'),
]);

/* ------------------------------------------------------------------------- */
/* Подъём                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Номер, с которого поднятый мир продолжает чеканить записи.
 *
 * Берётся из **записанного**: наибольший номер, встреченный в идентификаторах
 * своей цепочки — и в журнале учёта, и в журнале аудита, потому что счётчик у
 * них один (`ids.ts`). Без этого продолжение писало бы поверх собственных
 * строк: первая же запись нового процесса получила бы занятый идентификатор, и
 * хранилище ответило бы конфликтом — в лучшем случае.
 */
function resumedSeq(restored: RestoredWorld): number {
  const chainId = restored.chain.chainId;
  let seq = 0;
  for (const record of restored.chain.records) {
    seq = Math.max(seq, seqOfEternalId(chainId, record.recordId) ?? 0);
  }
  for (const entry of restored.journal.entries) {
    seq = Math.max(seq, seqOfEternalId(chainId, entry.id) ?? 0);
  }
  return seq;
}

interface Restored {
  readonly deal: RestoredDeal;
  readonly tranche: RestoredTranche;
}

function restoredTranches(restored: RestoredWorld): readonly Restored[] {
  return restored.deals.flatMap((deal) => deal.tranches.map((tranche) => ({ deal, tranche })));
}

function ownerOf(deal: RestoredDeal): ClientKey {
  // Покупатель сделки — он же плательщик по её траншам (`world.ts`, `payerOf`):
  // второй половины личности у сделки нет, а стороны в снимке обязательны.
  return clientKey(deal.deal.buyer.accountKey);
}

/** Объявления по номеру транша, с отказом на повтор и на неизвестный транш. */
function declarationsOf(
  seed: ResumeSeed,
  live: ReadonlySet<string>,
): {
  readonly byTranche: ReadonlyMap<string, Money<CurrencyCode> | null>;
  readonly missing: readonly UnmappedPart[];
} {
  const byTranche = new Map<string, Money<CurrencyCode> | null>();
  const missing: UnmappedPart[] = [];
  for (const declaration of seed.declared) {
    if (!live.has(declaration.trancheId)) {
      // Объявление о траншe, которого в подъёме нет либо который уже
      // терминален. Молча пропустить нельзя: объявляющий считает, что сказал
      // что-то о деньгах, а сказал в пустоту.
      missing.push(part(`tranche:${declaration.trancheId}`, 'tranche.declaration_unknown'));
      continue;
    }
    if (byTranche.has(declaration.trancheId)) {
      missing.push(part(`tranche:${declaration.trancheId}`, 'tranche.declaration_repeated'));
      continue;
    }
    byTranche.set(declaration.trancheId, declaration.collected);
  }
  for (const trancheId of live) {
    if (!byTranche.has(trancheId)) {
      missing.push(part(`tranche:${trancheId}`, 'tranche.collected_not_declared'));
    }
  }
  return { byTranche, missing };
}

function factsOf(
  item: Restored,
  required: Money<CurrencyCode>,
  collected: Money<CurrencyCode> | null,
  seed: ResumeSeed,
  restored: RestoredWorld,
): TrancheFacts {
  return {
    requiredAmount: required,
    collectedAmount: collected,
    // Запертое пересчитывается из журнала на каждый вызов (`contextFor`), здесь
    // только начальное значение — как и у только что заведённого транша.
    lockedAmount: null,
    // Ключ плательщика — наблюдение из выписки, а не сторона сделки: хранилище
    // его не держит, и пустая строка означает «сверять не с чем», то есть
    // отказ `g_payer_matches`.
    buyerPayerKey: '',
    buyer: item.deal.deal.buyer,
    // Акт об условии лежит **внутри** состояния транша и потому хранится
    // (`TrancheSnapshot.state`). У `pending` его ещё нет, и это законно.
    conditionAct: boundConditionAct(item.tranche.snapshot.state),
    evidenceBundleId: null,
    observation: null,
    // Кадастровый код объекта у сделки в схеме отсутствует. Пустой читается
    // как «сверяться не с чем» — отказ закрытый (`flow.ts`, `DealSpec`).
    expectedCadastralCode: '',
    observationPolicy: DEFAULT_OBSERVATION_POLICY,
    beneficiary: toBeneficiaryLock(UNKNOWN_BENEFICIARY),
    preparedBy: null,
    approvals: Object.freeze([]),
    approvalPolicy: DEFAULT_APPROVAL_POLICY,
    /*
     * Дата создания транша не хранится. Взята дата подъёма, и это безопасно
     * ровно потому, что одна она ничего не решает: к ней привязан **курс**
     * пересчёта порогов утверждения, а курса у поднятого мира нет
     * (`officialRateAtCreation: null`) — для транша не в валюте порогов это
     * закрытый отказ «утверждений не набрать», а для транша в валюте порогов
     * дата не участвует вовсе. Названо в `gaps`.
     */
    createdOn: isoDate(new Date(seed.now).toISOString().slice(0, 10)),
    officialRateAtCreation: null,
    // Пересчитывается в `contextFor` из списка поручений, здесь — начальное.
    activePayouts: 0,
    coverageOk: coverageOk(restored.journal),
    sourceAccountKnown: false,
    // Расхождение не снято: снимает его человек, и след этого решения в схеме
    // не лежит. Закрытый отказ `g_mismatch_resolved`.
    mismatchResolved: false,
  };
}

function runtimeOf(
  item: Restored,
  required: Money<CurrencyCode>,
  collected: Money<CurrencyCode> | null,
  seed: ResumeSeed,
  restored: RestoredWorld,
): TrancheRuntime {
  return {
    dealId: item.tranche.snapshot.dealId,
    trancheId: item.tranche.snapshot.trancheId,
    state: item.tranche.snapshot.state,
    facts: factsOf(item, required, collected, seed, restored),
    deductions: Object.freeze([]),
    tariffVersionId: '',
    // Поручения — из снимков: `PayoutSnapshot.state` и есть состояние домена.
    // Без них инвариант «не более одной активной выплаты на транш» проверял бы
    // пустой список, то есть не проверял бы ничего.
    payouts: Object.freeze(item.tranche.payouts.map((payout): PayoutState => payout.state)),
    approvalRecords: Object.freeze([]),
    beneficiary: UNKNOWN_BENEFICIARY,
    buyerNames: Object.freeze([]),
    evidence: Object.freeze([]),
    suspendedRemaining: null,
    observation: initialObservationState,
  };
}

/**
 * Поднять мир и продолжить его — либо назвать, почему нельзя.
 *
 * Единственный вход в `World` из хранилища. Всё, что он умеет сверх
 * `restoreWorld`, — собрать значение и провести его через ту же проверку, что
 * и шаг мира; всё, чего он не умеет, перечислено в `gaps`.
 */
export function resumeWorld(restored: RestoredWorld, seed: ResumeSeed): Resumption {
  /*
   * Часы нового процесса не могут стоять раньше последней записанной записи.
   *
   * Это **дефект вызывающего**, а не состояние базы, поэтому здесь исключение,
   * а не отказ значением: значением возвращается то, что база рассказала о
   * себе, а часы рассказал тот, кто поднимает. Без проверки мир собрался бы, а
   * упал бы первый же шаг — отказом журнала аудита о регрессии времени, из
   * которого причину («у процесса отстали часы») пришлось бы выводить.
   */
  const last = restored.chain.records[restored.chain.records.length - 1];
  if (last !== undefined && seed.now < last.recordedAt) {
    throw new Error(`app.resume.clock_behind_chain:${seed.now}<${last.recordedAt}`);
  }

  const items = restoredTranches(restored);
  const live = new Set(
    items
      .filter((item) => !isTerminalTrancheStatus(item.tranche.snapshot.state.status))
      .map((item) => item.tranche.snapshot.trancheId),
  );
  const declarations = declarationsOf(seed, live);
  const missing: UnmappedPart[] = [...declarations.missing];

  const claims: CollectedClaim[] = [];
  const runtimes: TrancheRuntime[] = [];
  for (const item of items) {
    const snapshot = item.tranche.snapshot;
    const required = snapshot.required;
    if (required === null) {
      /*
       * Требуемая сумма у транша не назначена. Собрать факты без неё нечем —
       * тип требует величину, а подставить сюда ноль значило бы объявить, что
       * с покупателя ничего не причитается.
       */
      missing.push(part(`tranche:${snapshot.trancheId}`, 'tranche.required_amount_missing'));
      continue;
    }
    const collected = declarations.byTranche.get(snapshot.trancheId) ?? null;
    claims.push({
      owner: ownerOf(item.deal),
      dealId: snapshot.dealId,
      trancheId: snapshot.trancheId,
      terminal: isTerminalTrancheStatus(snapshot.state.status),
      claimed: collected,
    });
    runtimes.push(runtimeOf(item, required, collected, seed, restored));
  }

  /*
   * Та же проверка, что у запечатывания: поверхность инвариантов плюс
   * притязания на собранное. Первая — `surfaceViolations` над тем же
   * `InvariantSurface`, вторая — `collectedClaimViolations`, которой считает
   * притязания мир в памяти. Ни одной похожей копии.
   */
  const violations = surfaceViolations(
    surfaceOfRestored(restored),
    collectedClaimViolations(restored.journal, claims),
  );
  if (violations.length > 0 || missing.length > 0) {
    return Object.freeze({
      kind: 'refused' as const,
      violations,
      missing: Object.freeze(missing),
    });
  }

  const deals = new Map<string, DealRuntime>();
  for (const deal of restored.deals) {
    deals.set(deal.deal.dealId, {
      dealId: deal.deal.dealId,
      state: deal.deal.state,
      // Акт об условии у сделки в схеме не лежит; у транша лежит внутри
      // состояния и оттуда и берётся. Здесь `null` — отказ закрытый.
      conditionAct: null,
      // Готовившего хранилище не знает. Это не «никто не готовил», а «спросить
      // некого»: разделение обязанностей на выплате читает факты мира, а их
      // нет вовсе, и кворум поэтому не набирается.
      preparedBy: null,
      trancheIds: Object.freeze(deal.tranches.map((item) => item.snapshot.trancheId)),
      objectCadastralCode: '',
      filings: Object.freeze([]),
      unwindReview: null,
    });
  }

  const tranches = new Map<string, TrancheRuntime>();
  for (const runtime of runtimes) tranches.set(runtime.trancheId, runtime);

  /*
   * `sealed` здесь не может отказать: только что проведена та же проверка, и
   * оба её слагаемых собраны из тех же значений. Он стоит **всё равно** — вход
   * в мир один, и подъём не делается исключением из правила «инварианты
   * проверяются после каждого шага». Счётчик проверок у поднятого мира поэтому
   * начинается с единицы, а не с нуля: проверка была.
   */
  const world = sealed(
    seedWorld({
      now: seed.now,
      journal: restored.journal,
      chain: restored.chain,
      // Якоря времени в схеме есть, а метода у порта нет: поднимать неоткуда.
      anchors: Object.freeze<Anchor[]>([]),
      deals,
      tranches,
      tasks: Object.freeze<ReviewTask[]>([]),
      observationTasks: Object.freeze<ObservationTask[]>([]),
      notifications: Object.freeze<Notification[]>([]),
      suppressed: Object.freeze<SuppressedEntry[]>([]),
      reissuedPayouts: Object.freeze<string[]>([]),
      // Ни одной сессии и ни одного следа «кто что делал»: новый процесс
      // никого не впускал. Вход требует `openSession`, как и у пустого мира.
      sessions: new Map<string, Session>(),
      facts: Object.freeze<ActionFact[]>([]),
      checks: 0,
      seq: resumedSeq(restored),
    }),
  );

  return Object.freeze({ kind: 'resumed' as const, world, gaps: GAPS });
}
