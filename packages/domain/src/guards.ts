import {
  type CurrencyCode,
  type FxRate,
  type IsoDate,
  type Money,
  compare,
  convertAtRate,
} from '@sdelka/money';
import type { BeneficiaryLock } from './beneficiary';
import { type ConditionAct, isConditionActValid } from './condition-act';
import { type Instant, HOUR } from './instant';
import {
  type ObservationPolicy,
  type ReleaseObservation,
  type StatementFields,
  allStatementFieldsMatch,
  observationSatisfies,
} from './observation';
import { type PartyRef, isSameParty } from './party';
import type { FeeCeilingPolicy } from './tariff';
import type { TrancheEvent } from './tranche-events';

/**
 * Guard'ы транша — STATE-MACHINES.md §1.3, идентификаторы буква в букву.
 *
 * Два guard'а помечены как введённые кодом: документ формулирует условие прозой
 * («расхождение снято», «два разных пользователя») и не даёт ему имени. Имя
 * нужно, чтобы условие было тестируемо поимённо, как требует §7.
 */
export const GUARD_IDS = [
  'g_amount_sufficient',
  'g_payer_matches',
  'g_evidence_present',
  /**
   * введено E3-1 (`ORACLE.md` §6.4, `STATE-MACHINES.md` §1.3): **наблюдение
   * оракула вообще годится как основание** — оно существует, оно о том же типе
   * условия, что и акт получателя, его источник и уровень доверия удовлетворяют
   * требованию типа (`registration_transfer` → платная выписка, L3+), его
   * кадастровый код — код объекта сделки, и его возраст в пределах политики.
   *
   * Отдельный guard, а не расширение `g_fields_match`: «документ, на который мы
   * опираемся, годен» и «содержимое документа сошлось» — два разных
   * утверждения, и §7 требует, чтобы каждое проверялось поимённо. Тот же довод,
   * которым разведены `g_beneficiary_locked` и `g_beneficiary_verified`.
   *
   * Документ требовал «L3+» столбцом источника в §8, а уровня в коде не было
   * вовсе: пять полей выписки и вердикт по собственнику лежали в фактах
   * **порознь и без документа**, и фикстура законно клала пять `true`, не имея
   * за ними ни одной выписки. `CORE.md` Ф7: «автоматический релиз по
   * недокументированному источнику — риск с максимальной вероятностью и
   * максимальным ущербом».
   */
  'g_observation_sufficient',
  'g_fields_match',
  'g_owner_is_buyer',
  'g_approvals_sufficient',
  'g_beneficiary_locked',
  /**
   * введено кодом (E13-2, ROADMAP.md И13.1): доказательство владения счётом
   * приложено. Отдельный guard, а не расширение `g_beneficiary_locked`: §1.3
   * определяет тот как «заблокированы и не менялись 72 часа», а владение счётом
   * — другое утверждение. Guard, склеивающий два правила, невозможно проверить
   * поимённо, как требует §7.
   */
  'g_beneficiary_verified',
  'g_no_active_payout',
  /**
   * введено кодом: **под траншем действительно есть собранные средства**.
   *
   * В §1.3 такого guard'а нет, потому что документ считает его само собой
   * разумеющимся: в `reserved` попадают из `collected`. Но путь
   * `collecting → release_blocked → release_pending → paying_out` (§1.4, тот
   * самый, ради которого продублированы guard'ы доказательств) в `collected`
   * не заходит вовсе — платёж третьего лица уводится в блокировку, оттуда
   * выходит по утверждению оператора, и деньги на транш при этом **не
   * зачислялись**. Транш доходил до `paid_out`, не имея за собой ни лари.
   *
   * Что при этом происходило в журнале: ничего. Сумма проводки берётся из
   * собранных средств, и при их отсутствии намерение проводки просто не
   * порождалось — расчёт уходил в банк, а в учёте не оставалось следа. Ни один
   * инвариант учёта такого не видит: записи, которой нет, нечему не сойтись.
   * А деньги на выплату при этом взялись бы с номинального счёта, то есть из
   * средств других сделок — красная линия №1.
   */
  'g_funds_collected',
  /**
   * введено кодом: **средства действительно заперты под этим траншем** —
   * остаток файла `client:{клиент}:tranche:{сделка}:{транш}` покрывает сумму,
   * которую расчёт с него спишет.
   *
   * Отдельный guard рядом с `g_funds_collected`, а не его расширение: «деньги
   * по траншу собраны» и «деньги лежат в файле этого транша» — два разных
   * утверждения, и §7 требует, чтобы каждое проверялось поимённо. До того как
   * запирание стало намерением автомата, они совпадали случайно: проекция
   * запирала деньги в момент `collected`, и любой путь с собранными
   * средствами имел непустой файл.
   *
   * Дыру нашёл тест на свойствах ровно в тот момент, когда запирание переехало
   * на вход в `reserved`: путь `collected → refund_pending → refunding
   * --payout_result(rejected)--> release_blocked → release_pending →
   * paying_out → paid_out` **в `reserved` не заходит вовсе**. Деньги при этом
   * лежат в свободной части счёта покупателя, файл транша пуст, а расчёт
   * дебетует его на всю сумму — то есть выплата финансируется средствами
   * других сделок, красная линия №1. В журнале это видно отрицательным
   * остатком клиентского счёта, но ловить такое учётом уже поздно: деньги к
   * этой секунде ушли в банк.
   *
   * Стоит на **каждой** двери пути выплаты по той же причине, что и остальные:
   * guard, стоящий только на одном входе, не защищает состояние (§1.4, §4).
   */
  'g_funds_locked',
  'g_coverage_ok',
  'g_source_account_known',
  /**
   * Акт получателя об условии совершён — CORE.md Ф13. Стоит на **входе в приём
   * средств**: без него деньги принимаются раньше, чем получатель определил
   * обстоятельство, и у отложенного платежа нет основания.
   */
  'g_condition_agreed',
  /** введено кодом: §1.4 «release_blocked → release_pending on approval_added ∧ расхождение снято» */
  'g_mismatch_resolved',
  /** введено кодом: §1.4 «write_off_approved(два разных пользователя)» */
  'g_write_off_approvers_distinct',
  /**
   * введено кодом (E14): **списание закрывает ровно то обязательство, которое
   * дебетует.**
   *
   * Запись списания (`writeOffUnclaimed`, FUNCTIONAL.md §3.1, случай Б)
   * дебетует файл транша и берёт сумму из него же — перебрать его она не
   * может, и потому пустой файл не ловила никак: намерения проводки не
   * возникало вовсе, а транш уходил в `written_off` **бесследно**. Статус при
   * этом утверждает «обязательство закрыто, деньги ушли с номинального счёта»,
   * и на этом след кончается.
   *
   * Два случая пустого файла надо развести, и они разведены здесь:
   *
   * - **собирать было нечего** (`collectedAmount` пуст) — обязательства перед
   *   клиентом по этому траншу не возникло, закрывать нечего, и списание
   *   ничего о деньгах не утверждает. Так уходит транш, куда деньги не дошли:
   *   платёж третьего лица в `release_blocked` на транш не зачисляется;
   * - **собрано, но не заперто** — деньги лежат в свободной части счёта
   *   покупателя, отзывными (красная линия №7). Это **не** невостребованные
   *   средства этого транша, и списанием их закрывать нельзя: выход отсюда —
   *   возврат. Проба: `collected --refund_requested--> refund_pending
   *   --refund_initiated--> refunding --payout_result(rejected)-->
   *   release_blocked`, двое утверждающих, ноль записей в журнале, обязательство
   *   перед клиентом стоит целиком.
   *
   * Отдельный guard, а не `g_funds_locked`: тот требует непустого собранного
   * (`collected === null → false`) и на первом случае отказал бы, оставив
   * транш без денег и без выхода в списание. §7 требует, чтобы каждое правило
   * проверялось поимённо, и «нечего закрывать» — не то же самое, что «есть что
   * закрывать, и оно на месте».
   */
  'g_write_off_covers_collected',
  /** введено кодом (E11-4): новую редакцию условия приняли обе стороны */
  'g_amendment_accepted_by_both',
  /**
   * введено кодом (E9-9, CORE.md Ф17): разморозку утвердили два разных
   * пользователя. Форма та же, что у `g_write_off_approvers_distinct`.
   */
  'g_unfreeze_approvers_distinct',
] as const;

export type GuardId = (typeof GUARD_IDS)[number];

export interface ApprovalTier {
  /** Верхняя граница включительно в минорных единицах; `null` — всё, что выше. */
  readonly upToMinor: bigint | null;
  /** `null` — сумма не берётся вообще (FUNCTIONAL.md §3.5: свыше 500 000 ₾ на пилоте не берём). */
  readonly requiredApprovals: number | null;
}

export interface ApprovalPolicy {
  readonly currency: CurrencyCode;
  readonly tiers: readonly ApprovalTier[];
}

/**
 * Пороги утверждения из FUNCTIONAL.md §3.5, в тетри.
 *
 * **Ступени с нулём утверждений здесь нет и быть не может.** Раньше первая
 * ступень разрешала автоисполнение до 30 000 ₾. На сегодняшнем минимуме сделки
 * она недостижима — и именно поэтому опасна: она молча включится в день, когда
 * минимум снизят, и никакой тест этого не заметит, потому что ломаться будет
 * не поведение, а его отсутствие.
 *
 * `CRO-risk.md`: автоматический релиз запрещён **при любой сумме**. Это риск с
 * максимальной вероятностью и максимальным ущербом одновременно, и цена
 * ошибки здесь — вся сумма сделки.
 */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = Object.freeze({
  currency: 'GEL',
  tiers: Object.freeze([
    Object.freeze({ upToMinor: 15_000_000n, requiredApprovals: 1 }),
    Object.freeze({ upToMinor: 50_000_000n, requiredApprovals: 2 }),
    Object.freeze({ upToMinor: null, requiredApprovals: null }),
  ]),
});

/**
 * Официальный курс на дату создания транша — FUNCTIONAL.md §4.3.1.
 *
 * Курс лежит в фактах транша, а не выясняется в момент проверки guard'а: иначе
 * планка утверждения плавает вместе с рынком и одна и та же сделка утром
 * требует двух подписей, а вечером одной. Курс именно официальный, а не наш
 * клиентский: в клиентском сидит наш спред, то есть мы влияли бы на собственный
 * контрольный порог.
 *
 * Дата — календарная (`IsoDate`), а не момент времени: курс публикуется на дату,
 * и превращение `Instant` в дату потребовало бы зашитой временной зоны.
 */
export interface OfficialRateAtCreation {
  /** Дата публикации курса. Сверяется с датой создания транша, а не с «сегодня». */
  readonly asOf: IsoDate;
  /**
   * Курс **со своей парой валют** (`@sdelka/money`, `FxRate`): направление —
   * часть величины, а не соседние поля рядом с числом.
   *
   * Раньше здесь лежали три поля — `from`, `to` и голая дробь `rate`, — и пара
   * валют жила отдельно от множителя. Сверить их между собой можно было только
   * вручную, что эта функция и делала; в соседнем пакете такой сверки не было
   * вовсе, и умножение вместо деления проходило молча. Направление, которое
   * нельзя отделить от множителя, нельзя и рассогласовать.
   */
  readonly rate: FxRate;
}

/**
 * Запретное окно перед расчётом: 72 часа (FUNCTIONAL.md инвариант 18,
 * `CORE.md` Ф15 — «изменение реквизитов в последние 72 часа перед расчётом
 * отвергается автоматом»). Guard `g_beneficiary_locked` — та же норма с другой
 * стороны: выплата на реквизиты, изменённые внутри окна, не выпускается.
 *
 * ⚠ Это **не** период охлаждения. Охлаждение — инвариант 17 и `CORE.md` Ф15,
 * 24–48 часов, и оно живёт отдельно: `packages/compliance/src/policy.ts`,
 * `beneficiary.cooldown`, применяется в `applyBeneficiaryChange`. Второй копии
 * охлаждения в домене нет намеренно: раньше эта константа называлась
 * `BENEFICIARY_COOLDOWN_MS` и её комментарий ссылался на инвариант 18 — то есть
 * имя и ссылка описывали два разных правила.
 */
export const BENEFICIARY_PRE_RELEASE_BLACKOUT_MS = 72 * HOUR;

export interface Approval {
  readonly userId: string;
}

/**
 * Факты, на которых стоят guard'ы. Домен их не добывает: реестр, банк и
 * учёт — за портами. Здесь только значения, приведённые к решению.
 */
export interface TrancheFacts {
  readonly requiredAmount: Money<CurrencyCode>;
  readonly collectedAmount: Money<CurrencyCode> | null;
  /**
   * Сколько **сейчас заперто в файле этого транша**: остаток
   * `client:{клиент}:tranche:{сделка}:{транш}`. Считает `@sdelka/ledger`
   * (`accountBalance`), домен читает готовое — та же форма и та же оговорка,
   * что у `coverageOk` и `sourceAccountKnown`.
   *
   * `null` — денег под траншем нет: он либо ещё не резервировался, либо резерв
   * уже снят. Расфиксация, отвязка при возврате и списание берут сумму отсюда,
   * а не из `collectedAmount`: это две разные величины, и до E-этого-батча
   * каждая проекция городила против их расхождения свою защиту от пустого
   * файла — в приложении по нулевому остатку, в интерфейсе по флагу, в
   * проекции домена никакой. Одна величина в фактах убирает все три.
   */
  readonly lockedAmount: Money<CurrencyCode> | null;
  /** Ключ плательщика-покупателя, с которым сверяется отправитель платежа. */
  readonly buyerPayerKey: string;
  /**
   * Покупатель как сторона сделки — он же плательщик, чья запертая часть
   * дебетуется расчётом.
   *
   * Это не то же, что `buyerPayerKey`: тот сверяется с именем отправителя
   * банковского платежа (наблюдение из выписки), а здесь — сторона, которая
   * принимает редакцию условия (Ф13, E11-4) и чей счёт ведёт учёт.
   *
   * Раньше этих двух ответов было два разных поля в двух разных структурах:
   * `buyerPartyId` в фактах и `payerClientKey` в контексте. Между ними не
   * стояло ни одной сверки — приложение могло назвать стороной одного, а
   * деньги взять со счёта другого. Теперь это одно значение (§2.1: личность
   * одна, роль — свойство участия).
   */
  readonly buyer: PartyRef;
  /**
   * Акт получателя об условии — порождающий акт (CORE.md Ф13). `null` означает,
   * что акта нет, и приём средств не открывается: отказ закрытый.
   */
  readonly conditionAct: ConditionAct | null;
  readonly evidenceBundleId: string | null;
  /**
   * Наблюдение оракула, на которое опирается расчёт (`ORACLE.md` §4). `null` —
   * наблюдения нет, и это законное состояние почти всю жизнь транша.
   *
   * **Одно значение вместо двух плавающих ответов.** Раньше здесь лежали
   * `statementFields` (пять булевых) и `registryOwnerIsBuyer` (одно булево)
   * порознь и **без документа**: собрать факты с пятью `true` и «собственник —
   * покупатель», не имея ни одной выписки, было законной конструкцией типа, и
   * фикстура интерфейса ровно это и делала. Один документ — один вердикт:
   * наблюдения нет — вердикта нет, и «забыть сбросить булево» больше нечего.
   */
  readonly observation: ReleaseObservation | null;
  /**
   * Кадастровый код объекта **этой** сделки. Наблюдение по чужому объекту —
   * полноценное, свежее, L3 — не должно разрешать выплату по нашей сделке
   * (`ORACLE.md` §6.2).
   */
  readonly expectedCadastralCode: string;
  /**
   * Политика наблюдения (свежесть). Лежит в фактах рядом с `approvalPolicy` и
   * по той же причине: `CORE.md` Ф11 требует, чтобы решение хранило версию
   * политики, действовавшую в момент принятия.
   */
  readonly observationPolicy: ObservationPolicy;
  readonly beneficiary: BeneficiaryLock;
  /** Учётная запись, готовившая операцию: она не может быть утверждающей. */
  readonly preparedBy: string | null;
  readonly approvals: readonly Approval[];
  readonly approvalPolicy: ApprovalPolicy;
  /** Дата создания транша: к ней привязан курс пересчёта порогов (§4.3.1). */
  readonly createdOn: IsoDate;
  /**
   * Курс на дату создания. `null` для транша в валюте порогов — пересчитывать
   * нечего. Для транша в другой валюте `null` означает, что курса нет, и
   * утверждения не набираются: отказ закрытый, а не подстановка ближайшего.
   */
  readonly officialRateAtCreation: OfficialRateAtCreation | null;
  /**
   * Потолок удержания, действующий для этого транша (`tariff.ts`, эпик E16).
   * Лежит в фактах рядом с `approvalPolicy` и `observationPolicy` и по той же
   * причине: `CORE.md` Ф11 — решение хранит версию политики, действовавшую в
   * момент принятия.
   *
   * ⚠ Поле **необязательное**, и это безопасно ровно потому, что умолчание —
   * самое строгое известное значение (`DEFAULT_FEE_CEILING_POLICY`, два
   * процента). Пропуск поля не может ослабить правило, а только ужесточить
   * его до умолчания; необязательным оно сделано, чтобы не ломать сборку
   * фактов в `packages/app` и `apps/web`, куда этот батч не заходит.
   */
  readonly feeCeilingPolicy?: FeeCeilingPolicy;
  readonly activePayouts: number;
  /** Результат проверки покрытия из учёта: считает ledger, домен только читает. */
  readonly coverageOk: boolean;
  readonly sourceAccountKnown: boolean;
  readonly mismatchResolved: boolean;
}

export interface GuardInput {
  readonly facts: TrancheFacts;
  readonly event: TrancheEvent;
  readonly now: Instant;
}

/**
 * Ступень по сумме, уже приведённой к валюте порогов.
 *
 * Сравнение одно для всех сумм — и для изначально выраженных в лари, и для
 * пересчитанных (FUNCTIONAL.md §4.3.1). Округление вверх применяется только при
 * пересчёте суммы, а не при выборе ступени: иначе 30 000 лари и 12 000 долларов
 * по курсу 2,50 — равные до копейки суммы — требуют разного числа подписей, и
 * эту асимметрию невозможно объяснить оператору.
 */
function approvalsForTier(policy: ApprovalPolicy, minor: bigint): number | null {
  for (const tier of policy.tiers) {
    if (tier.upToMinor === null || minor <= tier.upToMinor) {
      return tier.requiredApprovals;
    }
  }
  return null;
}

/**
 * Сколько утверждений нужно на сумму — FUNCTIONAL.md §3.5 и §4.3.1.
 *
 * Пороги заданы в лари. Сумма в другой валюте пересчитывается по официальному
 * курсу на дату создания транша с округлением вверх до минорной единицы — это
 * защита от погрешности курса, а не выбор более строгой ступени. Ступень дальше
 * выбирается тем же сравнением, что и для суммы, изначально выраженной в лари.
 *
 * `null` означает «утверждений не набрать» и всегда читается как отказ:
 * сумма выше потолка пилота, курса на дату нет, курс не той пары или не на дату
 * создания. Подставлять ближайший курс нельзя — отказ закрытый.
 *
 * Функция экспортирована: её же показывает кабинет и консоль операций, а
 * второй реализации того же правила быть не должно.
 */
export function requiredApprovals(
  policy: ApprovalPolicy,
  amount: Money<CurrencyCode>,
  officialRate: OfficialRateAtCreation | null,
  createdOn: IsoDate,
): number | null {
  if (amount.currency === policy.currency) {
    return approvalsForTier(policy, amount.minor);
  }
  if (officialRate === null) {
    return null;
  }
  // Пара сверяется с суммой и с валютой лестницы, а не с самой собой: курс
  // теперь несёт направление сам, но применять его **не к той паре** всё ещё
  // можно — курс приходит из базы, где типов нет. Отказ здесь закрытый
  // (`null` — «утверждений не набрать»), а не исключение: `convertAtRate` на
  // чужой паре бросает, и guard, бросающий вместо отказа, уронил бы шаг вместо
  // того, чтобы остановить выплату.
  if (officialRate.rate.base !== amount.currency || officialRate.rate.quote !== policy.currency) {
    return null;
  }
  // Курс обязан быть именно на дату создания транша, а не «свежий»: проверка
  // здесь, потому что иначе правило держится на добросовестности вызывающего.
  if (officialRate.asOf !== createdOn) {
    return null;
  }
  // Вторая линия к проверке `fxRate`: ноль и отрицательный курс конструктор не
  // выпускает, но значение приходит из базы, где конструктора не было.
  if (officialRate.rate.value.numerator <= 0n) {
    return null;
  }
  const converted = convertAtRate(amount, officialRate.rate, 'ceil');
  return approvalsForTier(policy, converted.minor);
}

function distinctApprovers(facts: TrancheFacts): number {
  const approvers = new Set<string>();
  for (const approval of facts.approvals) {
    if (approval.userId !== facts.preparedBy) {
      approvers.add(approval.userId);
    }
  }
  return approvers.size;
}

/**
 * Акт, о котором идёт речь в этой проверке: у события изменения условия — новая
 * редакция из события, во всех остальных случаях — акт из фактов транша.
 * Одна проверка пригодности на оба случая: правило «акт обязан быть годным»
 * не должно существовать в двух редакциях.
 */
function effectiveConditionAct(input: GuardInput): ConditionAct | null {
  return input.event.type === 'condition_act_amended'
    ? input.event.act
    : input.facts.conditionAct;
}

export const GUARDS: Readonly<Record<GuardId, (input: GuardInput) => boolean>> = Object.freeze({
  g_amount_sufficient: ({ facts, event }) => {
    if (event.type !== 'funds_received') return false;
    if (event.amount.currency !== facts.requiredAmount.currency) return false;
    return compare(event.amount, facts.requiredAmount) >= 0;
  },
  g_payer_matches: ({ facts, event }) => {
    if (event.type !== 'funds_received') return false;
    // Инвариант 19: несовпадение имени отправителя — удержание при любой сумме.
    return event.sender === facts.buyerPayerKey;
  },
  g_evidence_present: ({ facts }) =>
    facts.evidenceBundleId !== null && facts.evidenceBundleId.length > 0,
  /**
   * Документ, на который опирается расчёт, годен — `ORACLE.md` §6.
   *
   * Тип условия берётся **из акта получателя**, а не из наблюдения: иначе
   * наблюдение отвечало бы само себе, о чём оно. Акта нет — отказ закрытый:
   * без акта у отложенного платежа нет основания вовсе (Ф13).
   */
  g_observation_sufficient: ({ facts, now }) => {
    const act = facts.conditionAct;
    if (act === null) return false;
    return observationSatisfies(facts.observation, {
      conditionType: act.conditionType,
      expectedCadastralCode: facts.expectedCadastralCode,
      now,
      policy: facts.observationPolicy,
    });
  },
  /**
   * Пять полей **наблюдения**, поимённо (FUNCTIONAL.md §3.5). Наблюдения нет —
   * нет и полей: их отсутствие не читается как совпадение (Ф7, fail-closed).
   */
  g_fields_match: ({ facts }) =>
    facts.observation !== null && allStatementFieldsMatch(facts.observation.fields),
  /**
   * Перед выплатой сверяется, что новый собственник в выписке — **покупатель**:
   * это и есть доказательство, что переход права состоялся. Выписка, всё ещё
   * показывающая продавца, доказывает обратное.
   *
   * Проверка «текущий собственник = продавец» — другая, она стоит на заведении
   * сделки (Ф3) и сюда не относится. Раньше оба момента назывались одним
   * guard'ом `g_owner_matches`, и STATE-MACHINES.md §1.3 с FUNCTIONAL.md §3.5
   * определяли его противоположно. См. §1.3.
   *
   * Вердикт берётся из наблюдения и сравнивается **с `established`**, а не
   * «не опровергнуто». `insufficient` — выписка не отдала номер документа
   * собственника — роняет guard ровно так же, как `refuted`: это открытый
   * вопрос `CORE.md` Ф7 по иностранцам, и до ответа реестра он читается как
   * «оснований нет», а не «наверное совпало» (`ORACLE.md` §5.3). Различаются
   * два исхода ключом причины и видом задачи оператора, но не разрешением:
   * автоматического пути из `insufficient` к выплате нет ни при какой сумме.
   */
  g_owner_is_buyer: ({ facts }) => facts.observation?.ownerCheck === 'established',
  g_approvals_sufficient: ({ facts }) => {
    const required = requiredApprovals(
      facts.approvalPolicy,
      facts.requiredAmount,
      facts.officialRateAtCreation,
      facts.createdOn,
    );
    if (required === null) return false;
    return distinctApprovers(facts) >= required;
  },
  g_beneficiary_locked: ({ facts, now }) => {
    if (!facts.beneficiary.locked) return false;
    const changedAt = facts.beneficiary.lastChangedAt;
    if (changedAt === null) return true;
    return now - changedAt >= BENEFICIARY_PRE_RELEASE_BLACKOUT_MS;
  },
  /**
   * Доказательство владения счётом (ROADMAP.md И13.1: «доказательства владения
   * нет → переход в `paying_out` отвергается»).
   *
   * Сравнение именно с `verified`. `name_consistent` не проходит: совпадение
   * имени не является достаточным основанием ни для чего — латинизация
   * грузинского необратима, и разные люди сходятся в одной латинской форме.
   * `applyBeneficiaryChange` возвращает реквизиты именно в `name_consistent`,
   * то есть после смены реквизитов выплата заперта до повторной верификации.
   */
  g_beneficiary_verified: ({ facts }) => facts.beneficiary.status === 'verified',
  g_no_active_payout: ({ facts }) => facts.activePayouts === 0,
  /**
   * Сравнение с валютой транша, а не только с нулём: собранное в другой валюте
   * — это не «мало», а «не те деньги», и отказ здесь закрытый, как у
   * `g_amount_sufficient`. Сверка с требуемой суммой сюда не входит: допуск по
   * недоплате — правило §4.3, у него своё место, а здесь проверяется только
   * то, что расчёту есть что двигать.
   */
  g_funds_collected: ({ facts }) => {
    const collected = facts.collectedAmount;
    if (collected === null) return false;
    if (collected.currency !== facts.requiredAmount.currency) return false;
    return collected.minor > 0n;
  },
  /**
   * Файл транша покрывает сумму, которую расчёт с него спишет.
   *
   * Сравнение именно с собранным, а не с нулём: частично запертый файл — это
   * не «мало», а расхождение, и расчёт по нему увёл бы остаток клиентского
   * счёта в минус. Валюта сверяется отдельно по той же причине, что и в
   * `g_funds_collected`: запертое в другой валюте — не те деньги.
   */
  g_funds_locked: ({ facts }) => {
    const locked = facts.lockedAmount;
    const collected = facts.collectedAmount;
    if (locked === null || collected === null) return false;
    if (locked.currency !== collected.currency) return false;
    return compare(locked, collected) >= 0;
  },
  g_coverage_ok: ({ facts }) => facts.coverageOk,
  g_source_account_known: ({ facts }) => facts.sourceAccountKnown,
  /**
   * Акт получателя годен **и назначает получателем не покупателя**.
   *
   * Вторая половина проверки стоит здесь, а не в `isConditionActValid`: сам по
   * себе акт о покупателе ничего не знает, а сравнить его с покупателем можно
   * только там, где известны факты транша. Раньше эта сверка существовала
   * ровно в одном месте — на амендменте, — то есть **изменить** условие в свою
   * пользу было нельзя, а **сразу завести** его таким было можно.
   *
   * Одно лицо по обе стороны — отказ, а не предупреждение (FUNCTIONAL.md §2.1).
   * Здесь же и красная линия №6: условие, которое получатель определил сам
   * себе, будучи покупателем, зависит только от воли одной стороны и делает
   * сделку ничтожной целиком. Учёт отвергнет такой расчёт своим
   * `settlementSelfDealing`, но к тому моменту деньги уже приняты — отказывать
   * надо на входе, до денег.
   */
  g_condition_agreed: (input) => {
    const act = effectiveConditionAct(input);
    if (act === null) return false;
    if (isSameParty(act.recipient, input.facts.buyer)) return false;
    return isConditionActValid(act, input.now);
  },
  g_amendment_accepted_by_both: ({ facts, event }) => {
    if (event.type !== 'condition_act_amended') return false;
    // «Обе стороны» — это покупатель и получатель, а не два любых подписанта:
    // иначе условие переопределяется в одностороннем порядке двумя учётными
    // записями одной стороны (CORE.md Ф13).
    const accepted = new Set(event.acceptedBy);
    const recipient = event.act.recipient;
    if (isSameParty(recipient, facts.buyer)) return false;
    return accepted.has(facts.buyer.partyId) && accepted.has(recipient.partyId);
  },
  g_mismatch_resolved: ({ facts }) => facts.mismatchResolved,
  /**
   * Списание дебетует файл транша — значит, всё, что оно закрывает, обязано в
   * этом файле лежать. Ноль наравне с `null`: пустой файл возвращает не `null`,
   * а ноль в валюте (`accountBalance`).
   */
  g_write_off_covers_collected: ({ facts }) => {
    const collected = facts.collectedAmount;
    // Собирать было нечего: обязательства нет, закрывать нечего.
    if (collected === null || collected.minor === 0n) return true;
    const locked = facts.lockedAmount;
    if (locked === null) return false;
    // Запертое в другой валюте — не те деньги, ровно как в `g_funds_locked`.
    if (locked.currency !== collected.currency) return false;
    return compare(locked, collected) >= 0;
  },
  g_write_off_approvers_distinct: ({ facts, event }) => {
    if (event.type !== 'write_off_approved') return false;
    const approvers = new Set(event.userIds.filter((userId) => userId !== facts.preparedBy));
    return approvers.size >= 2;
  },
  /**
   * Разморозку утверждают два разных человека, и ни один из них не готовил
   * операцию (CORE.md Ф17, форма как у списания).
   *
   * ⚠ Здесь проверяется только `facts.preparedBy` — учётная запись, готовившая
   * операцию, которая приходит снаружи на каждый вызов. Автор **самой
   * заморозки** лежит в состоянии (`frozenBy`), а `GuardInput` состояния не
   * видит, и расширять его ради одного правила значит трогать все места вызова
   * guard'ов. Поэтому сверка с `frozenBy` сделана в ветке `unfreeze` редьюсера —
   * см. комментарий там. Полное закрытие — E7-4 (журнал с хеш-цепочкой).
   */
  g_unfreeze_approvers_distinct: ({ facts, event }) => {
    if (event.type !== 'unfreeze') return false;
    const approvers = new Set(event.userIds.filter((userId) => userId !== facts.preparedBy));
    return approvers.size >= 2;
  },
});

export function evaluateGuard(guard: GuardId, input: GuardInput): boolean {
  return GUARDS[guard](input);
}
