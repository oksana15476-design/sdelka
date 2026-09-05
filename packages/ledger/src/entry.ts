import {
  type ConvertedAmount,
  type CurrencyCode,
  type Money,
  convertAtRate,
  isPositive,
  money,
} from '@sdelka/money';
import {
  type Account,
  type ClientKey,
  accountCode,
  accountType,
  assertAccountIdentifier,
  bankOperating,
  clientAccountOwner,
  clientFreeAccount,
  clientFundsFile,
  clientLockedAccount,
  conversionOfAccount,
  isClientCustodyAccount,
  isClientFundsAccount,
  isClientObligationAccount,
  isPlatformBankAccount,
  isPlatformIncomeAccount,
  isPlatformReceivableAccount,
  poolDirection,
} from './accounts';
import { LedgerError, LedgerErrorCode } from './errors';
import {
  DEFAULT_FEE_CEILING,
  type FeeCeiling,
  feeCeilingCap,
  strictestFeeCeiling,
} from './fee-ceiling';

/**
 * Направление проводки перечнем, а не только типом: перечень переписан в базу
 * (`sdelka.direction`), и сверять его с типом нечем — типа в рантайме нет.
 * Тот же довод, что у `ACCOUNT_TYPES` (`accounts.ts`).
 */
export const DIRECTIONS = ['debit', 'credit'] as const;

export type Direction = (typeof DIRECTIONS)[number];

/** Отнесение проводки к сделке и траншу — основание пофайловой сверки. */
export interface TrancheRef {
  readonly dealId: string;
  readonly trancheId: string;
}

/** Отнесение проводки к клиенту вне сделки — второй вид файла (FUNCTIONAL.md §3.1). */
export interface ClientRef {
  readonly clientKey: ClientKey;
}

/**
 * Источник средств: транш или клиент. Union структурный, без тега, — чтобы
 * `debit(acc, m, { dealId, trancheId })` оставался тем же вызовом, что и до
 * появления счёта клиента: различение по наличию поля владельца.
 */
export type FundsRef = TrancheRef | ClientRef;

export function isClientRef(ref: FundsRef): ref is ClientRef {
  return 'clientKey' in ref;
}

/**
 * Файл счёта клиентского обязательства с владельцем в коде: транш, если счёт
 * несёт транш, иначе сам клиент. `null` — у счёта владельца нет (пул).
 *
 * Читается **из значения**, а не из перечня видов счетов. Прежде эта развилка
 * была выписана по именам (`kind === 'client_locked' ? … : kind === 'client_free' ? …`)
 * в трёх местах сразу, и счёт, заведённый мимо всех трёх, тихо попадал бы в
 * корзину «вне файлов» — то есть исчезал бы из пофайловой сверки.
 */
export function clientAccountFile(account: Account): FundsRef | null {
  const owner = clientAccountOwner(account);
  if (owner === null) return null;
  return 'dealId' in account && 'trancheId' in account
    ? { dealId: account.dealId, trancheId: account.trancheId }
    : { clientKey: owner };
}

export interface Posting {
  readonly account: Account;
  readonly direction: Direction;
  readonly amount: Money<CurrencyCode>;
  /** `null` допустим только там, где сделка ещё не известна: непознанное поступление. */
  readonly attribution: FundsRef | null;
}

/**
 * `correction` — единственный способ исправления (красная линия №11: журнал не
 * редактируется, исправление только новой записью со ссылкой на предыдущую).
 */
export const JOURNAL_ENTRY_KINDS = ['settlement', 'correction'] as const;

export type JournalEntryKind = (typeof JOURNAL_ENTRY_KINDS)[number];

/**
 * Объявление расчёта по траншу: кто платит, кто получает, по какой сделке.
 *
 * Красная линия №1 — архитектурный запрет, а не дисциплина. Обязательство
 * плательщика заперто структурой: код счёта `client:{плательщик}:tranche:{сделка}:{транш}`
 * содержит и владельца, и транш. **У получателя такой опоры не было вовсе**:
 * расчёт кредитовал свободную часть произвольного клиента, и запись «деньги
 * сделки А ушли лицу, к сделке А отношения не имеющему» строилась молча — после
 * чего это лицо законно запирало их под свою сделку Б.
 *
 * Ledger не знает и не может знать состав участников сделки: участники живут в
 * домене. Первая редакция сделала из этого вывод «значит, проверяемо только то,
 * что утверждение присутствует в записи» — и остановилась на самосертификации:
 * объявление изготавливал тот же вызывающий, который строил проводки, поэтому
 * расчёт по-прежнему собирался для любого постороннего лица, просто теперь
 * громко. Нарушение стало видимым для аудита, но не невозможным.
 *
 * Правильный вывод другой: связь «получатель ↔ сделка» обязана **прийти
 * снаружи** обязательным аргументом (`DealPartiesAttestation`), которого учёту
 * нечем подделать. Тогда защита состоит из четырёх частей:
 *
 * 1. движение обязательства между разными владельцами вообще невозможно без
 *    этого объявления (`assertClientOwnerMoveOnlySettles`);
 * 2. объявление собирается только из подтверждения домена, выданного на **эту**
 *    сделку, **этого** плательщика и **этого** получателя, со ссылкой на пакет
 *    доказательств (красная линия №5);
 * 3. объявление называет сделку, транш, плательщика и получателя одним
 *    значением, и каждая проводка записи сверяется с ним: в расчёте не может
 *    участвовать ни один посторонний счёт клиента;
 * 4. объявление остаётся в журнале (`JournalEntry.settles`) вместе со ссылкой
 *    на доказательства — претензия «Y получатель по сделке A» становится
 *    проверяемым фактом записи для аудита и сверки.
 *
 * Значение брендированное: структурный литерал на его место подставить нельзя,
 * идентификаторы валидируются теми же правилами, что и код счёта.
 */
export interface TrancheSettlement {
  readonly deal: TrancheRef;
  /** Владелец запертой части: она же источник денег расчёта. */
  readonly payer: ClientKey;
  /** Получатель расчёта. Свободную часть его счёта — и ничью больше — кредитует запись. */
  readonly recipient: ClientKey;
  /** Ссылка на пакет доказательств, под которым домен подтвердил стороны. */
  readonly evidenceRef: string;
  /**
   * Потолок удержания, действующий для этого расчёта (`fee-ceiling.ts`).
   *
   * Едет в объявлении, а не аргументом записи, по той же причине, что и
   * стороны: политика принадлежит решению домена, принятому в момент расчёта
   * (`CORE.md` Ф11), а не настройке, действующей в момент сборки проводки.
   *
   * **Только сужает.** Действующим считается строжайший из объявленного и
   * жёсткого предела учёта (`DEFAULT_FEE_CEILING`), поэтому объявление не
   * может разрешить больше, чем разрешает учёт: `feeCeiling(rational(1n, 1n))`
   * — законная величина, и без этого правила запись приносила бы себе право
   * удержать всё.
   */
  readonly ceiling: FeeCeiling;
  readonly __trancheSettlement: unique symbol;
}

/**
 * Ambient-символ: значения у него нет ни в рантайме, ни в типах учёта, поэтому
 * объект с этим ключом **невозможно построить кодом** — ни здесь, ни где-либо
 * ещё. Единственный способ получить `DealPartiesAttestation` — приведение типа,
 * и приведение это обязано стоять там, где знание о сторонах сделки живёт.
 */
declare const attestedByDomain: unique symbol;

/**
 * Подтверждение домена: перечисленные лица — стороны этого транша, и деньги
 * идут от плательщика получателю.
 *
 * **Зачем это здесь.** Прежняя редакция считала достаточным, что запись *несёт*
 * объявление получателя. Это самосертификация: объявление изготавливал тот же
 * вызывающий, который строил проводки, поэтому `settleTrancheToClientAccount`
 * собиралась для любого постороннего Z, а Z потом законно запирал полученное
 * под свою сделку Б. Нарушение стало видимым для аудита, но не невозможным.
 *
 * Учёт не знает и не может знать состав участников сделки — участники живут в
 * домене. Значит связь обязана **прийти снаружи** обязательным аргументом,
 * которого учёту нечем подделать: в `src/` нет ни одного значения этого типа и
 * ни одного приведения к нему, а построить объект с ambient-ключом нельзя.
 * Учёт проверяет ровно то, что может: подтверждение выдано на **эту** сделку,
 * **этого** плательщика и **этого** получателя, и несёт ссылку на пакет
 * доказательств (красная линия №5). Подтверждение от другой сделки или на
 * другое лицо к этому расчёту не подходит.
 *
 * Что обязан передавать домен, см. `docs`-отчёт по батчу: значение выдаётся
 * автоматом сделки в момент, когда транш переходит в расчёт, и только для той
 * пары сторон, которая записана в сделке.
 */
export interface DealPartiesAttestation {
  readonly dealId: string;
  readonly trancheId: string;
  readonly payer: ClientKey;
  readonly recipient: ClientKey;
  /**
   * Пакет доказательств, под которым домен подтвердил стороны и наступление
   * условия расчёта. Красная линия №5: выплата невозможна без ссылки на него.
   */
  readonly evidenceRef: string;
  readonly [attestedByDomain]: true;
}

export function trancheSettlement(
  deal: TrancheRef,
  payer: ClientKey,
  recipient: ClientKey,
  attestation: DealPartiesAttestation,
  /**
   * Потолок удержания по политике транша. Необязателен, и это безопасно ровно
   * потому, что умолчание — жёсткий предел учёта: пропуск аргумента не может
   * ослабить правило, а объявление — только ужесточить его.
   */
  ceiling: FeeCeiling = DEFAULT_FEE_CEILING,
): TrancheSettlement {
  assertAccountIdentifier(deal.dealId, 'dealId');
  assertAccountIdentifier(deal.trancheId, 'trancheId');
  assertAccountIdentifier(payer, 'payer');
  assertAccountIdentifier(recipient, 'recipient');
  if (payer === recipient) {
    // FUNCTIONAL.md §2.1, «Что запрещено жёстко»: одна и та же личность на обеих
    // сторонах одной сделки — отказ, а не предупреждение. Возврат самому себе
    // расчётом не является: у него своя запись (`unlockToClientAccount`).
    throw new LedgerError(LedgerErrorCode.settlementSelfDealing, {
      dealId: deal.dealId,
      trancheId: deal.trancheId,
      clientKey: payer,
    });
  }
  // Подтверждение с чужой сделки, чужого плательщика или чужого получателя —
  // не подтверждение этого расчёта. Без этой сверки одно выданное доменом
  // значение открывало бы расчёт кому угодно и по чему угодно.
  if (
    attestation.dealId !== deal.dealId ||
    attestation.trancheId !== deal.trancheId ||
    attestation.payer !== payer ||
    attestation.recipient !== recipient ||
    attestation.evidenceRef.length === 0
  ) {
    throw new LedgerError(LedgerErrorCode.settlementAttestationMismatch, {
      dealId: deal.dealId,
      trancheId: deal.trancheId,
      payer,
      recipient,
      attestedDealId: attestation.dealId,
      attestedTrancheId: attestation.trancheId,
      attestedPayer: attestation.payer,
      attestedRecipient: attestation.recipient,
    });
  }
  return Object.freeze({
    deal: Object.freeze({ dealId: deal.dealId, trancheId: deal.trancheId }),
    payer,
    recipient,
    evidenceRef: attestation.evidenceRef,
    ceiling: strictestFeeCeiling(ceiling, DEFAULT_FEE_CEILING),
  }) as unknown as TrancheSettlement;
}

/**
 * Объявление обмена на записи — по образцу `TrancheSettlement`.
 *
 * **Зачем оно есть.** Курса в журнале не было вовсе: `receiveConversion`
 * принимала посчитанные суммы, записывала их проводками и забывала, по какому
 * курсу они получены. И14.2 требует выписку по сделке «суммы, курсы, комиссии,
 * даты», а восстановить курс из двух сумм задним числом нельзя — усечение
 * необратимо. Поэтому курс становится фактом записи, а не аргументом вызова,
 * которого потом нет.
 *
 * Второе назначение — сверка. Обмен состоит из трёх записей (FUNCTIONAL.md
 * §3.3), и связывает их только ключ конверсии в коде счёта. Объявление
 * добавляет к ключу суммы обеих ног: подменить сумму в одной из трёх записей,
 * оставив остальные, больше нельзя — проводка по счёту расчётов обязана быть
 * равна объявленной ноге.
 */
export interface FxExecution {
  /** Ключ обмена: тот же, что в коде счёта `fx:settlement:{k}`. */
  readonly conversionId: string;
  /** Исходная и встречная суммы вместе с тремя курсами и датой (§4.5). */
  readonly converted: ConvertedAmount<CurrencyCode, CurrencyCode>;
}

/**
 * Объявление собирается только здесь, и здесь же проверяется, что оно не
 * противоречит само себе: встречная сумма обязана быть исходной, пересчитанной
 * по **клиентскому** курсу с усечением (FUNCTIONAL.md §4.3, «направление
 * округления при конвертации — усечение»).
 *
 * Проверка не лишняя, хотя `convert` из `@sdelka/money` строит `ConvertedAmount`
 * ровно так же: значение приходит из базы и от провайдера, где типов нет, и
 * пара «суммы отдельно, курсы отдельно» рассогласуется молча.
 */
export function fxExecution(
  conversionId: string,
  converted: ConvertedAmount<CurrencyCode, CurrencyCode>,
): FxExecution {
  assertAccountIdentifier(conversionId, 'conversionId');
  if (!isPositive(converted.source) || !isPositive(converted.target)) {
    throw new LedgerError(LedgerErrorCode.entryConversionDeclarationMismatch, {
      conversionId,
      source: converted.source.minor.toString(),
      target: converted.target.minor.toString(),
    });
  }
  const expected = convertAtRate(converted.source, converted.rates.client, 'trunc');
  if (expected.currency !== converted.target.currency || expected.minor !== converted.target.minor) {
    throw new LedgerError(LedgerErrorCode.entryConversionDeclarationMismatch, {
      conversionId,
      declared: `${converted.target.currency} ${converted.target.minor}`,
      atClientRate: `${expected.currency} ${expected.minor}`,
    });
  }
  return Object.freeze({ conversionId, converted });
}

/**
 * Счёт расчётов с валютным контрагентом трогается только объявленным обменом, и
 * только на объявленные суммы.
 *
 * Три правила, каждое закрывает свой способ разойтись:
 *
 * 1. **Нет проводки — нет объявления, и наоборот.** Объявление на записи, где
 *    обмена нет, — это курс, приписанный чужой операции; проводка без
 *    объявления — движение валюты неизвестно по какому курсу.
 * 2. **Счёт обмена один.** Запись, трогающая две конверсии сразу, снова
 *    сложила бы их позиции в одну — ровно то, ради чего ключ появился в коде
 *    счёта. Сверяется именно **код счёта**, а не ключ конверсии: с владельцем
 *    в коде один и тот же ключ у двух клиентов — это два разных счёта, и
 *    проверка по одному ключу пропустила бы запись, гасящую позицию клиента A
 *    ногой клиента B.
 * 3. **Сумма — одна из двух объявленных ног.** Иначе можно объявить обмен на
 *    сто лари, а двинуть сто тысяч.
 */
function assertConversionDeclared(
  postings: readonly Posting[],
  converts: FxExecution | undefined,
): void {
  const legs = postings.filter((posting) => conversionOfAccount(posting.account) !== null);
  if (converts === undefined) {
    const undeclared = legs[0];
    if (undeclared !== undefined) {
      throw new LedgerError(LedgerErrorCode.entryConversionUndeclared, {
        account: accountCode(undeclared.account),
      });
    }
    return;
  }
  if (legs.length === 0) {
    throw new LedgerError(LedgerErrorCode.entryConversionUndeclared, {
      conversionId: converts.conversionId,
      reason: 'not_applied',
    });
  }
  const { source, target } = converts.converted;
  let account: string | null = null;
  for (const posting of legs) {
    const code = accountCode(posting.account);
    account ??= code;
    if (conversionOfAccount(posting.account) !== converts.conversionId || code !== account) {
      throw new LedgerError(LedgerErrorCode.entryConversionUndeclared, {
        account: accountCode(posting.account),
        conversionId: converts.conversionId,
      });
    }
    const amount = posting.amount;
    const matchesSource =
      amount.currency === source.currency && amount.minor === source.minor;
    const matchesTarget =
      amount.currency === target.currency && amount.minor === target.minor;
    if (!matchesSource && !matchesTarget) {
      throw new LedgerError(LedgerErrorCode.entryConversionUndeclared, {
        account: accountCode(posting.account),
        amount: `${amount.currency} ${amount.minor}`,
        source: `${source.currency} ${source.minor}`,
        target: `${target.currency} ${target.minor}`,
      });
    }
  }
}

/**
 * Объявление начисления комиссии на записи: по какой сделке, сколько и **по
 * какой версии тарифного плана**.
 *
 * §4.2 требует буквально этого: «на каждой сделке хранится идентификатор версии
 * плана, применённой в момент создания — иначе через год нельзя воспроизвести,
 * почему списали именно столько». Хранить его обязана сделка (это домен), но
 * запись журнала, которая комиссию признаёт, обязана назвать его тоже: журнал
 * переживает сделку и читается отдельно от неё (Ф11, «каждое решение хранит
 * версию политики, действовавшую в момент принятия»).
 */
export interface FeeAccrualDeclaration {
  readonly deal: TrancheRef;
  readonly fee: Money<CurrencyCode>;
  readonly tariffVersionId: string;
}

/**
 * Объявление начисления **необязательно**, но ложным быть не может.
 *
 * Обязательным его сделать нельзя, не сломав смысл: `fee:income` — обычный счёт
 * дохода, и запись, признающая доход помимо тарифного начисления, законна (её
 * держит `assertPlatformIncomeSweptToOperating`). Поэтому контракт такой же, как
 * у объявления расчёта, минус обязательность: **объявил — обязан соответствовать**.
 * Признание должно двигать `fee:income` ровно на объявленную сумму, в файле
 * объявленного транша. Исправление двигает его в обратную сторону — на ту же
 * сумму и по тому же траншу.
 */
function assertFeeAccrualDeclared(
  kind: JournalEntryKind,
  postings: readonly Posting[],
  accrues: FeeAccrualDeclaration | undefined,
): void {
  if (accrues === undefined) return;
  let moved = 0n;
  for (const posting of postings) {
    if (posting.account.kind !== 'fee_income') continue;
    const attribution = posting.attribution;
    const matchesFile =
      attribution !== null &&
      !isClientRef(attribution) &&
      attribution.dealId === accrues.deal.dealId &&
      attribution.trancheId === accrues.deal.trancheId;
    if (!matchesFile || posting.amount.currency !== accrues.fee.currency) {
      throw new LedgerError(LedgerErrorCode.entryFeeAccrualMismatch, {
        dealId: accrues.deal.dealId,
        trancheId: accrues.deal.trancheId,
        currency: posting.amount.currency,
      });
    }
    moved += posting.direction === 'credit' ? posting.amount.minor : -posting.amount.minor;
  }
  const expected = kind === 'correction' ? -accrues.fee.minor : accrues.fee.minor;
  if (moved !== expected) {
    throw new LedgerError(LedgerErrorCode.entryFeeAccrualMismatch, {
      dealId: accrues.deal.dealId,
      trancheId: accrues.deal.trancheId,
      declared: expected.toString(),
      recognised: moved.toString(),
    });
  }
}

/**
 * Объявление довнесения недостачи: **какое именно признание** закрывается этим
 * переводом с операционного счёта на номинальный (FUNCTIONAL.md §3.1, случай А,
 * момент 2).
 *
 * Зачем ссылка, если сумма и владелец и так берутся из токена признания. Токен
 * — защита конструктора словаря: он делает форму «доложить кому угодно сколько
 * угодно» невыразимой в `entries.ts`. Но записанной в журнал остаётся обычная
 * пара проводок «Дт bank:nominal (файл клиента) / Кт bank:operating», в которой
 * **не написано, что она закрывает**. Из-за этого:
 *
 * - одно признание можно довнести дважды: токен — значение, его никто не гасит;
 * - признание вообще может не попасть в журнал: `absorbShortfall` возвращает
 *   запись, а положить её в журнал — отдельное действие.
 *
 * Оба случая ловил только инвариант `shortfallOverfunded` и только постфактум,
 * сложением по клиенту за всю историю. Со ссылкой их ловит `appendEntry`: она
 * видит журнал и требует, чтобы признание в нём было, совпадало по владельцу,
 * валюте и сумме и не было закрыто раньше.
 */
export interface ShortfallFunding {
  /** Идентификатор записи признания (`absorbShortfall`). */
  readonly recognisedEntryId: string;
  readonly owner: ClientKey;
  readonly amount: Money<CurrencyCode>;
}

/**
 * Довнесение делает ровно одно и ровно столько, сколько объявлено.
 *
 * Прирост обеспечения в записи обязан быть **один**, в файле объявленного
 * клиента, в объявленной валюте и на объявленную сумму; и ровно столько же
 * обязано уйти с банковского счёта платформы. `assertNoUnfundedClientFileGain`
 * проверяет неравенство (прирост не больше финансирования) — здесь равенство в
 * обе стороны: довнесение, попутно двигающее чужой файл или уводящее с
 * операционного счёта больше объявленного, довнесением не является.
 */
function assertShortfallFundingDeclared(
  kind: JournalEntryKind,
  postings: readonly Posting[],
  funds: ShortfallFunding | undefined,
): void {
  if (funds === undefined) return;
  const fail = (details: Readonly<Record<string, string>>): never => {
    throw new LedgerError(LedgerErrorCode.entryShortfallFundingMismatch, {
      recognisedEntryId: funds.recognisedEntryId,
      owner: funds.owner,
      ...details,
    });
  };
  // Исправление довнесения — обратная проводка со ссылкой на исправляемую
  // запись, а не второе довнесение по тому же признанию. Объявление на
  // исправлении означало бы, что признание закрыто ещё раз.
  if (kind !== 'settlement') {
    fail({ kind });
  }
  let gained = 0n;
  for (const gain of clientFileGains(postings)) {
    if (gain.minor === 0n) continue;
    const source = gain.source;
    const belongsToOwner =
      source !== null && isClientRef(source) && source.clientKey === funds.owner;
    if (!belongsToOwner || gain.currency !== funds.amount.currency) {
      fail({
        file:
          source === null
            ? ''
            : isClientRef(source)
              ? source.clientKey
              : `${source.dealId}:${source.trancheId}`,
        currency: gain.currency,
        minor: gain.minor.toString(),
      });
    }
    gained += gain.minor;
  }
  if (gained !== funds.amount.minor) {
    fail({ declared: funds.amount.minor.toString(), gained: gained.toString() });
  }
  const funded = platformFunding(kind, postings).get(funds.amount.currency) ?? 0n;
  if (funded !== funds.amount.minor) {
    fail({ declared: funds.amount.minor.toString(), funded: funded.toString() });
  }
}

export interface JournalEntryInput {
  readonly id: string;
  readonly occurredAt: string;
  readonly kind: JournalEntryKind;
  readonly postings: readonly Posting[];
  /** Ключ локализации/тип операции, не текст для клиента. */
  readonly memoKey: string;
  readonly correctsEntryId?: string;
  /**
   * Объявление расчёта. Обязательно ровно там, где обязательство переходит от
   * одного клиента к другому, и запрещено там, где такого перехода нет.
   */
  readonly settles?: TrancheSettlement;
  /**
   * Объявление обмена. Обязательно ровно там, где запись трогает счёт расчётов
   * с валютным контрагентом, и запрещено там, где не трогает.
   */
  readonly converts?: FxExecution;
  /**
   * Объявление начисления комиссии вместе с версией тарифного плана (§4.2).
   * Необязательно; объявленное обязано соответствовать проводкам.
   */
  readonly accrues?: FeeAccrualDeclaration;
  /**
   * Объявление довнесения недостачи со ссылкой на признание. Обязательно там,
   * где деньги платформы кладутся в файл клиента: без ссылки признание нечем
   * погасить, и одно признание довносится сколько угодно раз.
   */
  readonly funds?: ShortfallFunding;
}

export interface JournalEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly kind: JournalEntryKind;
  readonly postings: readonly Posting[];
  readonly memoKey: string;
  readonly correctsEntryId: string | null;
  readonly settles: TrancheSettlement | null;
  readonly converts: FxExecution | null;
  readonly accrues: FeeAccrualDeclaration | null;
  readonly funds: ShortfallFunding | null;
}

function signedMinor(posting: Posting): bigint {
  return posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor;
}

/**
 * Остаток в **естественном знаке счёта**: актив и расход — Дт минус Кт,
 * обязательство и доход — Кт минус Дт. Так «отрицательный остаток клиентского
 * счёта» означает ровно то, что означает в инварианте, а не зависит от того, с
 * какой стороны смотреть.
 *
 * Модель знака одна на весь пакет и живёт **здесь**, рядом с моделью проводки:
 * её спрашивают и отчёт об остатках (`balance.ts`), и правило журнала
 * «исправление отматывает только то, что ещё на счёте» (`journal.ts`). Две
 * копии этой функции разошлись бы молча — и разошлись бы ровно в знаке, то
 * есть в ту сторону, где расхождение выглядит как норма.
 */
export function postingNaturalSign(posting: Posting): bigint {
  const type = accountType(posting.account);
  const debitPositive = type === 'asset' || type === 'expense';
  const signed = signedMinor(posting);
  return debitPositive ? signed : -signed;
}

/** Дт минус Кт по каждой валюте отдельно. */
export function balanceByCurrency(postings: readonly Posting[]): ReadonlyMap<CurrencyCode, bigint> {
  const totals = new Map<CurrencyCode, bigint>();
  for (const posting of postings) {
    const currency = posting.amount.currency;
    totals.set(currency, (totals.get(currency) ?? 0n) + signedMinor(posting));
  }
  return totals;
}

function assertBalanced(postings: readonly Posting[]): void {
  // Мультивалютная запись балансируется в каждой валюте, а не в пересчёте:
  // пересчёт зависит от курса, а курс — это отдельная проводка (FUNCTIONAL.md §3.3).
  for (const [currency, total] of balanceByCurrency(postings)) {
    if (total !== 0n) {
      throw new LedgerError(LedgerErrorCode.entryUnbalanced, {
        currency,
        difference: total.toString(),
      });
    }
  }
}

function assertAttribution(postings: readonly Posting[]): void {
  // Непознанное поступление не может быть отнесено к сделке — на то оно и
  // непознанное (FUNCTIONAL.md §3.3, шаг 1). Во всех остальных записях проводка
  // по номинальному счёту обязана нести отнесение, иначе пофайловая сверка
  // (CORE.md Ф10) не построится — теперь по любому из двух файлов: транш или
  // клиент.
  // «Рядом с непознанным поступлением» — свойство пула-входа, а не имени счёта:
  // любой будущий пул со `pool: 'intake'` получает то же послабление сам.
  const hasIntakePool = postings.some((posting) => poolDirection(posting.account) === 'intake');
  for (const posting of postings) {
    const account = posting.account;
    const attribution = posting.attribution;
    const scope = clientFundsFile(account);
    if (scope === null) continue;

    if (scope === 'owner_in_code') {
      // Файл такого счёта уже записан в его коде, поэтому отнесение проводки
      // либо отсутствует, либо обязано совпасть с ним. Разойтись им нельзя:
      // обеспечение считалось бы по чужому файлу, и красная линия №1 потеряла
      // бы опору в отнесении.
      if (attribution === null) continue;
      const file = clientAccountFile(account);
      const asText = (ref: FundsRef): string =>
        isClientRef(ref) ? ref.clientKey : `${ref.dealId}:${ref.trancheId}`;
      const matches =
        file !== null &&
        (isClientRef(file)
          ? isClientRef(attribution) && attribution.clientKey === file.clientKey
          : !isClientRef(attribution) &&
            attribution.dealId === file.dealId &&
            attribution.trancheId === file.trancheId);
      if (!matches) {
        // Два разных отнесения к траншу — расхождение файла транша; всё
        // остальное — расхождение файла клиента. Коды разные, потому что
        // разбирать их дежурному приходится по-разному.
        const bothTranches = file !== null && !isClientRef(file) && !isClientRef(attribution);
        throw new LedgerError(
          bothTranches
            ? LedgerErrorCode.postingAttributionMismatch
            : LedgerErrorCode.postingClientAttributionMismatch,
          {
            account: accountCode(account),
            attribution: asText(attribution),
            file: file === null ? '' : asText(file),
          },
        );
      }
      continue;
    }

    if (scope === 'pooled') {
      // У пула файла нет по объявлению — это его определение. Отнесение на
      // пуловой проводке означало бы, что деньги одновременно и в файле, и вне
      // файлов, и пофайловая сверка считала бы их дважды.
      if (attribution !== null) {
        throw new LedgerError(LedgerErrorCode.postingClientAttributionMismatch, {
          account: accountCode(account),
          attribution: isClientRef(attribution)
            ? attribution.clientKey
            : `${attribution.dealId}:${attribution.trancheId}`,
        });
      }
      continue;
    }

    // Счёт, объявивший «файл приносит отнесение», без отнесения файла не имеет:
    // пофайловая сверка (CORE.md Ф10) по такой проводке не построится.
    if (attribution === null && !hasIntakePool) {
      throw new LedgerError(LedgerErrorCode.postingCustodyWithoutAttribution, {
        account: accountCode(account),
      });
    }
  }
}

/**
 * Комиссия связывается со сделкой **только отнесением** — значит отнесение
 * обязательно.
 *
 * У счетов комиссии файла в коде нет и быть не может: `fee:receivable` один на
 * всю платформу (`accounts.ts`), в отличие от `client:{c}:tranche:{d}:{t}`, где
 * файл записан в самом коде. Поэтому «по какой сделке начислено» знает
 * исключительно отнесение проводки — и до этой проверки отнесение на счетах
 * комиссии было **необязательным**: `assertAttribution` смотрит только счета
 * клиентских средств и мимо `fee:receivable` проходит молча.
 *
 * **Что через это проходило** (проба в `test/fee-ceiling.test.ts`). Запись
 * `Дт fee:receivable / Кт fee:income` без отнесения собиралась
 * `createJournalEntry` и ложилась в журнал. Дальше она:
 *
 *  · не попадала в `openFeeReceivables` и `feePositions` — оба отбрасывают
 *    проводку без отнесения к траншу, то есть требование на балансе есть, а в
 *    отчётах его нет;
 *  · не попадала в `feeAccrualTranches`, а значит идемпотентность
 *    (`journalFeeAccruedTwice`) её не видела: следом законно проходило второе,
 *    уже отнесённое начисление по тому же траншу. `fee:receivable` вдвое, доход
 *    признан дважды, инварианты пусты.
 *
 * Отнесение к **файлу клиента** отвергается тем же правилом и по той же
 * причине: требование по комиссии — не деньги клиента, файл клиента для него не
 * файл, а все три отчёта ключуются парой «сделка, транш». Отнесение к клиенту
 * для них неотличимо от его отсутствия.
 *
 * Правило стоит на `fee:receivable`, а не на «любом счёте комиссии»: `fee:income`
 * — обычный счёт дохода, и признание дохода помимо тарифного начисления законно
 * (см. `assertPlatformIncomeSweptToOperating`). Но как только в записи есть
 * требование по комиссии, признание в ней — начисление, и его доходная нога
 * обязана назвать тот же файл: иначе `feePositions` показала бы «не удержано
 * 500» при «начислено 0».
 */
function assertFeeAccrualAttributed(postings: readonly Posting[]): void {
  const touchesReceivable = postings.some((posting) => posting.account.kind === 'fee_receivable');
  const needsTranche = (account: Account): boolean =>
    account.kind === 'fee_receivable' || (account.kind === 'fee_income' && touchesReceivable);
  for (const posting of postings) {
    if (!needsTranche(posting.account)) continue;
    const attribution = posting.attribution;
    if (attribution !== null && !isClientRef(attribution)) continue;
    throw new LedgerError(LedgerErrorCode.postingFeeWithoutTrancheAttribution, {
      account: accountCode(posting.account),
      attribution: attribution === null ? '' : attribution.clientKey,
    });
  }
}

function assertFeeNeverLandsOnClientFunds(
  kind: JournalEntryKind,
  postings: readonly Posting[],
): void {
  // Красная линия №2: комиссия платформы не может иметь конечным счётом
  // клиентские средства. Признак — доход платформы по дебету (уходит с дохода)
  // и клиентские средства по кредиту (приходят на них) в одной записи.
  // Обратная проводка при исправлении — законный случай: возврат ошибочно
  // удержанной комиссии клиенту. Поэтому он разрешён только записью типа
  // `correction`, у которой обязана быть ссылка на исправляемую запись.
  if (kind === 'correction') {
    return;
  }
  const debitsIncome = postings.some(
    (posting) => posting.direction === 'debit' && isPlatformIncomeAccount(posting.account),
  );
  if (!debitsIncome) {
    return;
  }
  const creditsClientFunds = postings.find(
    (posting) => posting.direction === 'credit' && isClientFundsAccount(posting.account),
  );
  if (creditsClientFunds !== undefined) {
    throw new LedgerError(LedgerErrorCode.entryFeeIntoClientFunds, {
      account: accountCode(creditsClientFunds.account),
    });
  }
}

/**
 * Ключ источника средств: транш, клиент вне сделки, а для непознанного
 * поступления — сам факт того, что сделки нет. Валюта входит в ключ:
 * обязательство в долларах не гасится долями лари, пересчёт — это отдельная
 * проводка.
 */
function fundsSourceKey(currency: CurrencyCode, ref: FundsRef | null): string {
  if (ref === null) return `${currency}|suspense`;
  // Префикс обязателен: без него сделка с идентификатором `client` попадала бы
  // в файл клиента с тем же именем. Идентификаторы не могут содержать `|`
  // (`assertIdentifier`), поэтому разбор ключа однозначен.
  return isClientRef(ref)
    ? `${currency}|client|${ref.clientKey}`
    : `${currency}|tranche|${ref.dealId}|${ref.trancheId}`;
}

/** Читаемое имя файла для сообщения об ошибке. Пустая строка — файла нет. */
export function fundsRefText(ref: FundsRef | null): string {
  if (ref === null) return '';
  return isClientRef(ref) ? ref.clientKey : `${ref.dealId}:${ref.trancheId}`;
}

/**
 * Файл, которого проводка касается **на самом деле**.
 *
 * Одна модель на весь пакет, а не три похожие: у счёта с владельцем в коде файл
 * читается из кода (отнесение там либо отсутствует, либо обязано совпасть —
 * `assertAttribution`), у пула файла нет по объявлению, у всех прочих файл
 * приносит отнесение. Разойтись этим трём случаям нельзя: пофайловая сверка
 * (`clientFileGains`) и сверка исправления с целью (`journal.ts`) обязаны
 * называть один и тот же файл одним и тем же именем, иначе «то же самое» в
 * одном месте окажется «другим» в другом.
 */
export function postingFile(posting: Posting): FundsRef | null {
  const scope = clientFundsFile(posting.account);
  if (scope === 'owner_in_code') return clientAccountFile(posting.account);
  if (scope === 'pooled') return null;
  return posting.attribution;
}

/**
 * Ключ движения: счёт, валюта и файл вместе.
 *
 * Валюта и файл входят в ключ по той же причине, по которой они входят в
 * `fundsSourceKey`: сто лари в файле транша A и сто лари в файле постороннего
 * лица — это не одно движение, разошедшееся по строкам, а два разных движения.
 * Код счёта и идентификаторы `|` не содержат (`assertAccountIdentifier`),
 * поэтому ключ разбирается однозначно.
 */
export function postingMovementKey(posting: Posting): string {
  return `${accountCode(posting.account)}|${fundsSourceKey(
    posting.amount.currency,
    postingFile(posting),
  )}`;
}

function assertNoClientCrossSubsidy(postings: readonly Posting[]): void {
  // Красная линия №1 и FUNCTIONAL.md §3.1: «проводка „дебет клиентского
  // обязательства, кредит номинального счёта“ без встречной выплаты этому же
  // клиенту отвергается при построении записи». Дыру по одной сделке нельзя
  // закрывать деньгами другой, и это архитектурный запрет, а не дисциплина.
  //
  // Отличить выплату от списания за чужой счёт можно ровно по отнесению: в
  // выплате деньги уходят с номинального счёта, отнесённые к тому же траншу,
  // чьё обязательство гасится. Любое другое отнесение — и любое отсутствие
  // отнесения — означает, что уходят средства, собранные под другую сделку.
  //
  // Проверка применяется и к исправлениям: у обратной проводки (дебет
  // номинального, кредит обязательства) эта форма не возникает, поэтому
  // законному исправлению исключение не нужно.
  const settledObligations = new Set<string>();
  for (const posting of postings) {
    if (posting.direction === 'debit' && isClientObligationAccount(posting.account)) {
      settledObligations.add(
        fundsSourceKey(posting.amount.currency, clientAccountFile(posting.account)),
      );
    }
  }
  if (settledObligations.size === 0) {
    return;
  }
  for (const posting of postings) {
    if (posting.direction !== 'credit' || !isClientCustodyAccount(posting.account)) {
      continue;
    }
    if (!settledObligations.has(fundsSourceKey(posting.amount.currency, posting.attribution))) {
      throw new LedgerError(LedgerErrorCode.entryClientFundsCrossSubsidy, {
        account: accountCode(posting.account),
        currency: posting.amount.currency,
        attribution:
          posting.attribution === null
            ? ''
            : isClientRef(posting.attribution)
              ? posting.attribution.clientKey
              : `${posting.attribution.dealId}:${posting.attribution.trancheId}`,
      });
    }
  }
}

/**
 * Второй контур красной линии №1 для счёта клиента: перенос из запертой части
 * одной сделки в запертую часть другой одной записью.
 *
 * Первый контур — словарь записей (`entries.ts`): у него просто нет
 * конструктора, принимающего два транша, поэтому такой перенос там невыразим.
 * Но `createJournalEntry` остаётся низкоуровневой дверью, и через неё форму
 * собрать можно, поэтому запрет стоит и здесь.
 *
 * Запрет действует и при совпадении владельца. FUNCTIONAL.md §2.1, «Граница,
 * которая здесь проходит»: причина не в личности владельца — сделка А может
 * откатиться, и тогда деньги обязаны вернуться. Законный путь один и он в два
 * шага: отвязка в свободную часть (событие автомата сделки А) и только потом
 * привязка к сделке Б.
 */
function assertNoLockedToLocked(postings: readonly Posting[]): void {
  const debited = postings.filter(
    (posting) => posting.direction === 'debit' && posting.account.kind === 'client_locked',
  );
  const credited = postings.filter(
    (posting) => posting.direction === 'credit' && posting.account.kind === 'client_locked',
  );
  for (const from of debited) {
    for (const to of credited) {
      const fromCode = accountCode(from.account);
      const toCode = accountCode(to.account);
      if (fromCode !== toCode) {
        throw new LedgerError(LedgerErrorCode.entryLockedToLocked, { from: fromCode, to: toCode });
      }
    }
  }
}

/**
 * Обязательство перед одним клиентом не превращается в обязательство перед
 * другим иначе как объявленным расчётом по траншу.
 *
 * FUNCTIONAL.md §2.1: одно лицо в двух ролях — законный случай, но это одно
 * лицо. Любое движение «дебет обязательства перед X, кредит обязательства перед
 * Y» — это перевод между людьми, и деньгами X финансировалось бы обязательство
 * перед Y (красная линия №1).
 *
 * **Исправленный дефект.** Прежняя редакция запрещала только одну из двух форм —
 * дебет **свободной** части X, — а обратную (дебет **запертой** части X, кредит
 * свободной части Y) намеренно пропускала как «расчёт по сделке, условие
 * которого проверяет автомат». Пропускала при этом для любого Y: расчёт по
 * сделке А принимался в пользу лица, к сделке А отношения не имеющего, после
 * чего `lockForTranche(Y, сделка Б)` законно запирал эти деньги под чужую
 * сделку. Ни покрытие, ни пофайловая сверка нарушения не видели, потому что по
 * форме проводок его и не было.
 *
 * Теперь исключение существует, но оно **именное**: расчёт разрешён ровно тогда,
 * когда запись несёт объявление (`settles`), и только между счетами, которые это
 * объявление называет. Ledger не проверяет, что Y действительно получатель по
 * сделке А — этого знания у журнала нет; он делает утверждение об этом
 * обязательным, единственным и записанным.
 */
function assertClientOwnerMoveOnlySettles(
  kind: JournalEntryKind,
  postings: readonly Posting[],
  settles: TrancheSettlement | undefined,
): void {
  const debitedOwners = new Set<ClientKey>();
  const creditedOwners = new Set<ClientKey>();
  for (const posting of postings) {
    if (!isClientObligationAccount(posting.account)) continue;
    const owner = clientAccountOwner(posting.account);
    // У непознанного поступления владельца нет — это его определение, а не
    // лазейка: обязательство без владельца никому не переходит.
    if (owner === null) continue;
    (posting.direction === 'debit' ? debitedOwners : creditedOwners).add(owner);
  }
  let crossesOwners = false;
  for (const from of debitedOwners) {
    for (const to of creditedOwners) {
      if (from !== to) crossesOwners = true;
    }
  }

  if (settles === undefined) {
    if (crossesOwners) {
      throw new LedgerError(LedgerErrorCode.entryClientOwnerMismatch, {
        debited: [...debitedOwners].sort().join(','),
        credited: [...creditedOwners].sort().join(','),
      });
    }
    return;
  }

  assertSettlementShape(kind, postings, settles);
}

/**
 * Постройка расчёта сверяется с объявлением — иначе объявление было бы
 * украшением, а не опорой.
 *
 * Правила ровно три, и каждое закрывает свой способ увести деньги транша:
 *
 * 1. **Ни одного постороннего счёта клиента.** Обязательства в записи — только
 *    запертая часть плательщика по объявленному траншу и свободная часть
 *    получателя. Иначе расчёт по сделке А заодно гасил бы обязательство по Б.
 * 2. **Объявление обязано быть применено.** Запись, в которой запертая часть
 *    плательщика по объявленному траншу не участвует вовсе, расчётом не
 *    является, и объявление на ней — попытка получить право на
 *    межвладельческое движение задаром.
 * 3. **Направление задано.** В расчёте деньги идут от плательщика получателю.
 *    Обратное движение — деньги получателя запираются под сделку плательщика —
 *    это финансирование чужой сделки, и оно допустимо только исправлением
 *    (красная линия №11), у которого есть ссылка на исправляемую запись.
 *
 * Отнесение проводок кастодиана тоже сверяется: деньги расчёта переезжают из
 * файла объявленного транша в файл объявленного получателя и никуда больше.
 */
function assertSettlementShape(
  kind: JournalEntryKind,
  postings: readonly Posting[],
  settles: TrancheSettlement,
): void {
  const lockedCode = accountCode(
    clientLockedAccount(settles.payer, settles.deal.dealId, settles.deal.trancheId),
  );
  const freeCode = accountCode(clientFreeAccount(settles.recipient));
  const fail = (details: Readonly<Record<string, string>>): never => {
    throw new LedgerError(LedgerErrorCode.entrySettlementShapeMismatch, {
      dealId: settles.deal.dealId,
      trancheId: settles.deal.trancheId,
      ...details,
    });
  };

  // Применено — значит запертая часть плательщика в записи участвует. У расчёта
  // она дебетуется, у исправления кредитуется обратно; направление задаёт
  // отдельное правило ниже, здесь важен сам факт участия.
  let touchesLocked = false;
  for (const posting of postings) {
    const account = posting.account;
    if (isClientObligationAccount(account)) {
      const code = accountCode(account);
      if (code !== lockedCode && code !== freeCode) {
        fail({ account: code });
      }
      if (code === lockedCode) {
        touchesLocked = true;
        if (posting.direction === 'credit' && kind !== 'correction') {
          fail({ account: code, direction: posting.direction });
        }
      }
      if (code === freeCode && posting.direction === 'debit' && kind !== 'correction') {
        fail({ account: code, direction: posting.direction });
      }
      continue;
    }
    if (isClientCustodyAccount(account) && posting.attribution !== null) {
      const attribution = posting.attribution;
      const matchesFile = isClientRef(attribution)
        ? attribution.clientKey === settles.recipient
        : attribution.dealId === settles.deal.dealId &&
          attribution.trancheId === settles.deal.trancheId;
      if (!matchesFile) {
        fail({
          account: accountCode(account),
          attribution: isClientRef(attribution)
            ? attribution.clientKey
            : `${attribution.dealId}:${attribution.trancheId}`,
        });
      }
    }
  }
  if (!touchesLocked) {
    fail({ account: lockedCode, reason: 'not_applied' });
  }
  assertSettlementCeiling(postings, settles, lockedCode, freeCode);
}

/**
 * Потолок удержания стоит **здесь** — на записи расчёта (`fee-ceiling.ts`,
 * эпик E16).
 *
 * **Что было.** Предел был написан в `@sdelka/domain` (`tariff.ts`) и не
 * запрещал ничего: домен клал его в намерение расчёта полем `maxWithholding`,
 * `packages/app` (`projectSettlementIntent`) это поле не читал, а учёт о нём не
 * знал вовсе. Удержание 99 000 из 100 000 собиралось `accrueFee` +
 * `settleTrancheToClientAccount`, сходилось повалютно, не роняло покрытие и не
 * поднимало ни одного инварианта. Правило существовало там, где его некому
 * нарушить, и отсутствовало там, где нарушение и происходит.
 *
 * **Почему проверка именно такая.** Удержание считается **вычитанием**: сколько
 * ушло с запертой части плательщика минус сколько дошло до свободной части
 * получателя. Не «сумма проводок по `fee:receivable`» — тогда правило
 * обходилось бы сменой счёта назначения (`service:income`, любой будущий счёт
 * дохода), ровно как отмывка однажды прошла через `unclaimed:liability` мимо
 * перечня счетов. И не «по строке» — тогда оно обходилось бы добавлением
 * строки. Разница брутто и нетто не зависит ни от числа строк, ни от их имён.
 *
 * Поэтому обойти его нельзя и низкоуровневой дверью: `createJournalEntry` зовёт
 * эту проверку у **любой** записи с объявлением расчёта, а без объявления
 * расчёта не бывает вовсе — межвладельческое движение обязательства без
 * `settles` отвергает `assertClientOwnerMoveOnlySettles`.
 *
 * **Тип записи правило не спрашивает — только направление.** Исправление
 * двигает те же счета в обратную сторону: запертая часть кредитуется, разность
 * выходит отрицательной, и мерить её потолком нечем — такая запись пропускается
 * по знаку, а не по типу. Ровно поэтому исправление, двигающее деньги **вперёд**
 * (дебет запертой части, кредит получателя), под правило попадает наравне с
 * расчётом: у `correction` нет послаблений на направление в
 * `assertSettlementShape`, и освобождение по типу открывало бы второй расчёт под
 * видом исправления.
 *
 * ⚠ **[открыто]** Правило накрывает удержание из расчёта по траншу. Списание
 * комиссии прямо со свободной части счёта клиента (вне расчёта) под него не
 * попадает: у такого движения нет брутто, от которого считается доля, и в
 * словаре такой формы сегодня нет. Появится — предел ей нужен свой.
 */
function assertSettlementCeiling(
  postings: readonly Posting[],
  settles: TrancheSettlement,
  lockedCode: string,
  freeCode: string,
): void {
  // Объявление может только сужать: строжайший из объявленного и жёсткого
  // предела учёта. Запись, принёсшая с собой потолок в единицу, ничего себе не
  // разрешает.
  const ceiling = strictestFeeCeiling(settles.ceiling ?? DEFAULT_FEE_CEILING, DEFAULT_FEE_CEILING);
  const gross = new Map<CurrencyCode, bigint>();
  const paidOut = new Map<CurrencyCode, bigint>();
  for (const posting of postings) {
    if (!isClientObligationAccount(posting.account)) continue;
    const code = accountCode(posting.account);
    const currency = posting.amount.currency;
    const signed = posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor;
    if (code === lockedCode) {
      gross.set(currency, (gross.get(currency) ?? 0n) + signed);
    } else if (code === freeCode) {
      paidOut.set(currency, (paidOut.get(currency) ?? 0n) - signed);
    }
  }
  for (const [currency, taken] of gross) {
    if (taken <= 0n) continue;
    const withheld = taken - (paidOut.get(currency) ?? 0n);
    if (withheld <= 0n) continue;
    const cap = feeCeilingCap(money(currency, taken), ceiling);
    if (withheld > cap.minor) {
      throw new LedgerError(LedgerErrorCode.entryFeeExceedsCeiling, {
        dealId: settles.deal.dealId,
        trancheId: settles.deal.trancheId,
        currency,
        gross: taken.toString(),
        withheld: withheld.toString(),
        cap: cap.minor.toString(),
        maxShare: `${ceiling.maxShare.numerator}/${ceiling.maxShare.denominator}`,
      });
    }
  }
}

/**
 * Признанный доход платформы уходит на операционный счёт **в той же записи**.
 *
 * Красная линия №2 буквально: «комиссия платформы не хранится на номинальном
 * счёте — выводится на операционный в момент расчёта, в том же журнале».
 * FUNCTIONAL.md §3.3 шаг 5 описывает вывод отдельным движением, и ровно этим
 * зазором дефект и жил: расчёт признавал комиссию доходом, денег с номинального
 * счёта не двигал, а конструктора вывода в словаре не было вовсе — он был
 * написан вручную в приложении. Забыть вывод не запрещалось ничем: в файле
 * транша оставался профицит, а профицит покрытием не считается.
 *
 * Поэтому вывод перестал быть отдельным шагом. Признание дохода без встречного
 * дебета операционного счёта в той же валюте и на ту же сумму — не запись.
 * Забыть его теперь нельзя: запись просто не собирается.
 *
 * **Исключение ровно одно, и оно именное: доход против требования платформы.**
 * Прежняя редакция этого комментария обещала его на будущее («когда появится
 * счёт требований»), и счёт появился: `fee:receivable` — начисленная, но ещё
 * не удержанная комиссия (FUNCTIONAL.md §4.6, CORE.md Ф16). Начисление
 * `Дт fee:receivable / Кт fee:income` денег не двигает вовсе, поэтому вывода
 * на операционный счёт у него нет и быть не может.
 *
 * Исключение сформулировано **условием, а не перечнем счетов**: доход
 * засчитывается против дебета счёта платформы с ролью `receivable` в той же
 * валюте, и только если запись **не кредитует клиентские средства**. Второе
 * условие держит красную линию №2: как только в записи появляется кредит
 * клиентского счёта, послабление исчезает и доход обязан уйти на операционный
 * счёт живыми деньгами. Перечень счетов вместо условия пропустил бы следующий
 * счёт требований мимо правила — ровно так уже прошла отмывка через
 * `unclaimed:liability` (см. `assertNoOwnedObligationIntoIntakePool`).
 */
function assertPlatformIncomeSweptToOperating(postings: readonly Posting[]): void {
  const income = new Map<CurrencyCode, bigint>();
  const swept = new Map<CurrencyCode, bigint>();
  const claimed = new Map<CurrencyCode, bigint>();
  // Кредит клиентских средств в записи снимает послабление целиком: признать
  // доход «против требования» и одновременно зачислить что-то на клиентский
  // счёт — это и есть комиссия, оставленная в клиентских деньгах.
  const touchesClientFunds = postings.some(
    (posting) => posting.direction === 'credit' && isClientFundsAccount(posting.account),
  );
  for (const posting of postings) {
    const currency = posting.amount.currency;
    if (posting.direction === 'credit' && isPlatformIncomeAccount(posting.account)) {
      income.set(currency, (income.get(currency) ?? 0n) + posting.amount.minor);
    }
    if (!touchesClientFunds && isPlatformReceivableAccount(posting.account)) {
      // Чистое движение, как и у операционного счёта: требование, начисленное
      // и тут же списанное в той же записи, требованием не является.
      claimed.set(
        currency,
        (claimed.get(currency) ?? 0n) +
          (posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor),
      );
    }
    if (posting.account.kind === 'bank_operating') {
      // **Чистое движение, а не валовый дебет.** Прежняя редакция складывала
      // только дебеты операционного счёта, и запись, где комиссия «выведена»
      // дебетом 300 и тут же возвращена кредитом 300, собиралась: на
      // операционном счёте ноль, комиссия осталась на номинальном, а проверка
      // рапортовала о выводе. Утверждение в комментарии было ложным.
      swept.set(
        currency,
        (swept.get(currency) ?? 0n) +
          (posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor),
      );
    }
  }
  for (const [currency, recognised] of income) {
    const moved = (swept.get(currency) ?? 0n) + (claimed.get(currency) ?? 0n);
    if (moved < recognised) {
      throw new LedgerError(LedgerErrorCode.entryPlatformIncomeNotSwept, {
        account: accountCode(bankOperating(currency)),
        currency,
        recognised: recognised.toString(),
        swept: (swept.get(currency) ?? 0n).toString(),
        claimed: (claimed.get(currency) ?? 0n).toString(),
      });
    }
  }
}

/**
 * Обязательство перед известным клиентом не уходит обратно в пул-вход.
 *
 * Пул-вход (`pool: 'intake'`, сегодня — `suspense:unidentified`) — это вход в
 * учёт, а не выход из него: у поступления ещё нет владельца (FUNCTIONAL.md
 * §3.3, шаг 1), и опознание одностороннее. Обратное движение — «дебет
 * обязательства перед клиентом, кредит пула» — переводит деньги в пул без
 * владельца и без файла, и это ровно первый шаг двухзаписной отмывки:
 * обязательство по траншу А гасится в пул, а вторая запись опознаёт его на
 * постороннее лицо.
 *
 * **Правило больше не знает имени счёта.** Прежняя редакция сравнивала
 * `kind === 'suspense_unidentified'`, поэтому та же самая атака прошла через
 * `unclaimed:liability`, которого в сравнении не было. Теперь условие — это
 * объявленное направление пула, и любой будущий пул-вход попадает под запрет
 * в момент своего объявления, без правки этой функции.
 *
 * Исправление ошибочного опознания — законный случай (не тот плательщик), и оно
 * остаётся возможным записью типа `correction`: у неё есть ссылка на
 * исправляемую запись, то есть след (красная линия №11).
 */
function assertNoOwnedObligationIntoIntakePool(
  kind: JournalEntryKind,
  postings: readonly Posting[],
): void {
  if (kind === 'correction') {
    return;
  }
  const intoPool = postings.some(
    (posting) => posting.direction === 'credit' && poolDirection(posting.account) === 'intake',
  );
  if (!intoPool) {
    return;
  }
  const drained = postings.find(
    (posting) =>
      posting.direction === 'debit' &&
      isClientObligationAccount(posting.account) &&
      clientAccountOwner(posting.account) !== null,
  );
  if (drained !== undefined) {
    throw new LedgerError(LedgerErrorCode.entryObligationIntoIntakePool, {
      account: accountCode(drained.account),
    });
  }
}

/**
 * Из пула-выхода деньги обратно к клиенту не выходят.
 *
 * `unclaimed:liability` — терминальный пул: сюда обязательство закрывается,
 * когда клиент не найден, возврат невозможен и сделка мертва (§3.1, случай Б).
 * Обратный ход — «дебет пула, кредит обязательства перед клиентом» — это
 * выдача невостребованных средств лицу, и учёт не может проверить, тому ли:
 * §3.1 прямо помечает порядок обращения с невостребованными средствами как
 * **[открыто]**, вопрос юристу.
 *
 * Без этого запрета законное списание превращается в отмывочный конвейер:
 * запись 1 списывает обязательство перед X в пул по всем правилам, запись 2
 * выдаёт содержимое пула постороннему Z, и обе записи по отдельности выглядят
 * безупречно — файлы сходятся, обеспечение на месте.
 *
 * Когда порядок будет установлен, у выдачи появится своё объявление —
 * подтверждение домена о том, кто и на каком основании заявил права, — по
 * образцу `DealPartiesAttestation`. До тех пор форма не выразима записью типа
 * `settlement`, а ошибочное списание отменяется `correction` со ссылкой.
 *
 * **Послабление для исправления держится не на виде записи, а на зеркальности.**
 * Само по себе оно было дырой: с `kind: 'correction'` та же выдача проходила
 * молча, потому что ссылку никто не сверял с содержанием
 * (проба — `test/correction-mirror.test.ts`). Теперь исправление обязано быть
 * обратным движением **своей цели** по тем же счетам и файлам
 * (`journal.ts`, `assertCorrectionMirrorsTarget`), поэтому опустошить пул можно
 * ровно в ту сторону, откуда деньги в него пришли, и ровно в тот файл. Ранний
 * выход остаётся здесь: конструктор записи журнала не видит, а без журнала
 * отличить отмену списания от выдачи постороннему нечем.
 */
function assertNoPayoutFromTerminalPool(
  kind: JournalEntryKind,
  postings: readonly Posting[],
): void {
  if (kind === 'correction') {
    return;
  }
  const drained = postings.find(
    (posting) =>
      posting.direction === 'debit' &&
      isClientObligationAccount(posting.account) &&
      poolDirection(posting.account) === 'terminal',
  );
  if (drained !== undefined) {
    throw new LedgerError(LedgerErrorCode.entryTerminalPoolPayout, {
      account: accountCode(drained.account),
    });
  }
}

/**
 * Прирост обеспечения одного файла в одной записи: сколько в него пришло
 * клиентских активов минус сколько в нём прибавилось обязательств.
 *
 * `source === null` — «вне файлов»: пулы, у которых владельца нет по
 * объявлению.
 */
export interface ClientFileGain {
  readonly source: FundsRef | null;
  readonly currency: CurrencyCode;
  readonly minor: bigint;
}

/**
 * Пофайловый прирост обеспечения в одной записи.
 *
 * Экспортируется, потому что то же вычисление нужно журнальному инварианту
 * `shortfallOverfunded`: «сколько денег платформы легло в файл этого клиента»
 * — это ровно сумма приростов его файла по всем записям. Повторить вычисление
 * во втором месте значило бы завести вторую модель проводок, а расхождение
 * двух моделей в этом проекте уже случалось.
 */
export function clientFileGains(postings: readonly Posting[]): readonly ClientFileGain[] {
  const custody = new Map<string, bigint>();
  const obligations = new Map<string, bigint>();
  const sources = new Map<string, FundsRef | null>();

  const bump = (target: Map<string, bigint>, key: string, value: bigint): void => {
    target.set(key, (target.get(key) ?? 0n) + value);
  };

  for (const posting of postings) {
    const account = posting.account;
    const currency = posting.amount.currency;
    if (clientFundsFile(account) === null) continue;
    // Файл: из кода счёта, из отнесения, либо «вне файлов» у пулов — одной
    // моделью на весь пакет (`postingFile`).
    const ref = postingFile(posting);
    const key = fundsSourceKey(currency, ref);
    sources.set(key, ref);
    const signed = posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor;
    if (accountType(account) === 'asset') {
      bump(custody, key, signed);
    } else {
      bump(obligations, key, -signed);
    }
  }

  return [...sources.entries()].map(([key, source]) => ({
    source,
    currency: key.slice(0, key.indexOf('|')) as CurrencyCode,
    minor: (custody.get(key) ?? 0n) - (obligations.get(key) ?? 0n),
  }));
}

/**
 * Деньги платформы, ушедшие с её банковского счёта в этой записи. В записи типа
 * `correction` сюда же входит снятое признание расхода — см.
 * `assertNoUnfundedClientFileGain`.
 */
export function platformFunding(
  kind: JournalEntryKind,
  postings: readonly Posting[],
): ReadonlyMap<CurrencyCode, bigint> {
  const funding = new Map<CurrencyCode, bigint>();
  for (const posting of postings) {
    const account = posting.account;
    if (clientFundsFile(account) !== null) continue;
    // Реальные деньги платформы, ушедшие с её собственного **банковского**
    // счёта. Признание расхода сюда не входит: обещание доплатить — не
    // перевод (§3.1).
    //
    // Роль счёта, а не «актив платформы»: с появлением требования по
    // начисленной комиссии (`fee:receivable`) и транзита комиссии
    // (`transit:fee`) прежнее условие пустило бы в финансирование клиентского
    // файла списанное требование и деньги, до нас ещё не дошедшие. Ни то ни
    // другое со счёта платформы не уходило.
    const isReversedExpense = kind === 'correction' && accountType(account) === 'expense';
    if (isPlatformBankAccount(account) || isReversedExpense) {
      const currency = posting.amount.currency;
      funding.set(
        currency,
        (funding.get(currency) ?? 0n) +
          (posting.direction === 'credit' ? posting.amount.minor : -posting.amount.minor),
      );
    }
  }
  return funding;
}

/**
 * Файл клиентских средств не наращивает обеспечение за чужой счёт.
 *
 * Это красная линия №1, высказанная **без единого имени счёта**. Файл — либо
 * транш, либо клиент вне сделки, либо «вне файлов» (пулы). Для каждого файла в
 * записи считается прирост обеспечения: сколько в него пришло клиентских
 * активов минус сколько в нём прибавилось обязательств. Прирост означает, что
 * файл стал обеспечен лучше, чем был, — и у такого прироста есть ровно один
 * законный источник: **собственные деньги платформы, ушедшие с её собственного
 * счёта в этой же записи** (довнесение недостачи, §3.1, случай А, момент 2).
 *
 * Всё остальное — перелив: обеспечение одного файла выросло за счёт другого,
 * или обязательство исчезло, а деньги остались. Обе известные атаки ломаются
 * именно здесь:
 *
 * - `Дт client:X:tranche:A / Кт <пул> / Кт bank:nominal(файл A) / Дт bank:nominal(файл Z)` —
 *   файл Z прирос на всю сумму, платформа не потратила ничего;
 * - `Дт <пул> / Кт client:Z:free` — обязательство пула исчезло, деньги пула не
 *   двинулись: прирост «вне файлов» на всю сумму.
 *
 * **Исправления не исключены.** Соблазн был: у `correction` есть ссылка на
 * исправляемую запись, и все прочие запреты её пропускают. Но именно поэтому
 * она мгновенно становится обходным путём — обе атаки выше проходят целиком,
 * если пометить их записи исправлениями. Поэтому правило действует и здесь, а
 * законному исправлению даётся ровно одна поблажка: **отменённое признание
 * расхода платформы тоже считается финансированием**. Исправление отматывает
 * назад уже записанное обещание доплатить (§3.1, случай А), и прирост файла в
 * нём — не прирост, а снятие прежней недостачи. В обычной записи такой
 * поблажки нет: там кредит расхода означал бы, что обязательство перед
 * клиентом погашено «за счёт уменьшения нашего убытка», то есть отобрано.
 *
 * Ограничения названы честно. Проверка смотрит одну запись, поэтому:
 *
 * - перелив, размазанный по двум записям через **реальный** операционный счёт
 *   платформы, ею не ловится: платформа вправе двигать свои деньги, и такой
 *   маршрут обязан оставить след на настоящем банковском счёте, где его найдёт
 *   сверка с выпиской;
 * - исправление, в котором прирост чужого файла подпёрт встречным кредитом
 *   расхода платформы, конструктор пропускает — ценой признанного убытка и
 *   ссылки на конкретную исправляемую запись. **Здесь** это закрыть нечем:
 *   сверка исправления с целью — знание журнала, которого у конструктора
 *   записи нет. Она появилась этажом выше (`journal.ts`,
 *   `assertCorrectionMirrorsTarget`): в журнал такая запись больше не ложится,
 *   потому что чужого файла её цель не трогала.
 */
function assertNoUnfundedClientFileGain(
  kind: JournalEntryKind,
  postings: readonly Posting[],
): void {
  const funding = platformFunding(kind, postings);
  const gained = new Map<CurrencyCode, bigint>();
  for (const gain of clientFileGains(postings)) {
    if (gain.minor <= 0n) continue;
    gained.set(gain.currency, (gained.get(gain.currency) ?? 0n) + gain.minor);
  }
  for (const [currency, gain] of gained) {
    const funded = funding.get(currency) ?? 0n;
    if (gain > funded) {
      throw new LedgerError(LedgerErrorCode.entryClientFileGainUnfunded, {
        currency,
        gained: gain.toString(),
        funded: funded.toString(),
      });
    }
  }
}

export function createJournalEntry(input: JournalEntryInput): JournalEntry {
  if (input.postings.length < 2) {
    throw new LedgerError(LedgerErrorCode.entryTooFewPostings, {
      postings: String(input.postings.length),
    });
  }
  for (const posting of input.postings) {
    if (posting.amount.minor <= 0n) {
      // Знак несёт направление (Дт/Кт), а не сумма: иначе одна и та же операция
      // записывается двумя способами и сверка перестаёт быть однозначной.
      throw new LedgerError(LedgerErrorCode.postingNonPositiveAmount, {
        account: accountCode(posting.account),
        amount: posting.amount.minor.toString(),
      });
    }
  }
  assertBalanced(input.postings);
  assertAttribution(input.postings);
  assertNoLockedToLocked(input.postings);
  assertClientOwnerMoveOnlySettles(input.kind, input.postings, input.settles);
  assertFeeNeverLandsOnClientFunds(input.kind, input.postings);
  assertFeeAccrualAttributed(input.postings);
  assertPlatformIncomeSweptToOperating(input.postings);
  assertNoClientCrossSubsidy(input.postings);
  assertNoOwnedObligationIntoIntakePool(input.kind, input.postings);
  assertNoPayoutFromTerminalPool(input.kind, input.postings);
  assertNoUnfundedClientFileGain(input.kind, input.postings);
  assertConversionDeclared(input.postings, input.converts);
  assertFeeAccrualDeclared(input.kind, input.postings, input.accrues);
  assertShortfallFundingDeclared(input.kind, input.postings, input.funds);
  if (input.kind === 'correction' && input.correctsEntryId === undefined) {
    throw new LedgerError(LedgerErrorCode.entryCorrectionWithoutReference, { id: input.id });
  }
  if (input.kind === 'settlement' && input.correctsEntryId !== undefined) {
    throw new LedgerError(LedgerErrorCode.entrySettlementWithReference, { id: input.id });
  }
  return Object.freeze({
    id: input.id,
    occurredAt: input.occurredAt,
    kind: input.kind,
    postings: Object.freeze([...input.postings]),
    memoKey: input.memoKey,
    correctsEntryId: input.correctsEntryId ?? null,
    // Объявление расчёта остаётся в записи: без него утверждение «получатель Y
    // связан со сделкой A» нечем предъявить ни аудиту, ни сверке.
    settles: input.settles ?? null,
    // Курс остаётся в записи по той же причине, что и объявление расчёта: без
    // него утверждение «эти лари получены по такому-то курсу» нечем предъявить
    // ни выписке по сделке (И14.2), ни сверке.
    converts: input.converts ?? null,
    // Версия тарифного плана остаётся в журнале: §4.2, «иначе через год нельзя
    // воспроизвести, почему списали именно столько».
    accrues: input.accrues ?? null,
    // Ссылка на признание остаётся в журнале: без неё «это довнесение по вот
    // этой недостаче» — утверждение, которое негде проверить, и повторное
    // довнесение по тому же признанию неотличимо от первого.
    funds: input.funds ?? null,
  });
}

export function debit(
  account: Account,
  amount: Money<CurrencyCode>,
  attribution: FundsRef | null = null,
): Posting {
  return Object.freeze({ account, direction: 'debit', amount, attribution });
}

export function credit(
  account: Account,
  amount: Money<CurrencyCode>,
  attribution: FundsRef | null = null,
): Posting {
  return Object.freeze({ account, direction: 'credit', amount, attribution });
}
