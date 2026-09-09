import { describe, expect, it } from 'vitest';
import {
  type AuditMinted,
  AuditErrorCode,
  MINT_SCHEMES,
  MINT_SCHEME_IDS,
  appendRecord,
  assertNoRawIdentifiers,
  auditAmount,
  auditMinted,
  auditRef,
  isMintScheme,
  mintIsAuthentic,
  mintNamespace,
  recordDigest,
  verifyChain,
} from '../src/index';
import {
  APPROVER,
  BENEFICIARY,
  DEAL,
  PAYOUT_POLICY,
  SYSTEM,
  TRANCHE,
  at,
  expectAuditError,
  newChain,
  source,
} from './support/fixtures';

/**
 * Каждая тридцать вторая выплата не попадала в вечный журнал.
 *
 * ## Дефект
 *
 * Ключ идемпотентности выплаты — UUID версии 5 (`domain/src/ids.ts`), то есть
 * отформатированный отпечаток SHA-1. Последняя группа канонической записи —
 * двенадцать шестнадцатеричных знаков; если девять из них подряд оказались
 * цифрами, правило `digit_run` из `values.ts` считает значение сырым
 * идентификатором человека и отвергает запись с `audit.value.raw_identifier`.
 *
 * Замер на 200 000 ключей `payoutIdempotencyKey('tranche-N')`: 6 233 попадания,
 * **3,1 %** [установлено]. Ровно поэтому дефект не ловился тестами: он зависит
 * от имени транша, и на именах вроде `tranche-happy` его нет.
 *
 * ## Почему константы, а не случайные имена
 *
 * Тест на случайном входе воспроизводил бы дефект в трёх процентах прогонов —
 * то есть был бы ровно тем же дефектом, только в тестах. Поэтому входы ниже
 * **подобраны и закреплены**, а рядом с каждым стоит утверждение, что он
 * действительно даёт девять цифр подряд. Утверждение обязательно: без него
 * подмена константы превратила бы весь файл в проверку счастливого пути.
 */

/**
 * Транш, ключ расчёта по которому гарантированно попадает под `digit_run`.
 *
 * Подобран перебором `tranche-digit-run-N` при N от 1: первое попадание — 12.
 * Ключ: `2771ece7-3630-58e0-92c0-cbb284210542`, последняя группа `cbb284210542`
 * содержит `284210542` — девять цифр подряд.
 */
const TRANCHE_WITH_RUN = 'tranche-digit-run-12';
const PAYOUT_KEY_WITH_RUN = '2771ece7-3630-58e0-92c0-cbb284210542';

/**
 * То же для возврата: у него своё пространство имён, и попадание своё.
 * Подобран перебором `tranche-refund-run-N`, первое попадание — 146.
 * Ключ `275c2a87-383e-5dd4-9360-79a614021311`, группа `79a614021311` содержит
 * `614021311`.
 */
const TRANCHE_WITH_REFUND_RUN = 'tranche-refund-run-146';
const REFUND_KEY_WITH_RUN = '275c2a87-383e-5dd4-9360-79a614021311';

/**
 * Заявка на вывод со счёта клиента: `withdrawal-run-N`, первое попадание — 30.
 * Ключ `b1943cef-93e6-558c-8987-710601089173`, последняя группа целиком из
 * цифр — двенадцать подряд.
 */
const WITHDRAWAL_WITH_RUN = 'withdrawal-run-30';
const WITHDRAWAL_KEY_WITH_RUN = 'b1943cef-93e6-558c-8987-710601089173';

const DIGIT_RUN = /\d{9,}/u;

/** Настоящие сырые идентификаторы. Ни один из них не должен пройти — никогда. */
const RAW_DOCUMENT_NUMBER = '01019049170';
const RAW_ACCOUNT_IBAN = 'GE29NB0000000101904917';
/**
 * Телефон **внутри** строки, которая по форме ключом быть могла бы. Восемь
 * цифр, а не двенадцать: с двенадцатью первым сработало бы правило `digit_run`,
 * и снятие правила о телефоне осталось бы незамеченным — та же оговорка, что в
 * `values.test.ts`.
 */
const RAW_PHONE = 'call+99532200';

function orderedPayout(key: string, minted: readonly AuditMinted[] | null) {
  const chain = newChain();
  return appendRecord(chain, {
    recordId: `${chain.chainId}:r1`,
    recordedAt: at(1),
    actor: APPROVER,
    subject: auditRef('payout', key),
    related: [TRANCHE, DEAL],
    ...(minted === null ? {} : { minted }),
    body: {
      kind: 'payout_ordered',
      idempotencyKey: key,
      amount: auditAmount('GEL', 1_250_00n),
      beneficiary: BENEFICIARY,
      policy: PAYOUT_POLICY,
      evidencePackage: [source(1, 'condition_act', 'cabinet'), source(3)],
    },
  });
}

describe('константы теста действительно воспроизводят дефект', () => {
  it('подобранные входы дают ключи с девятью цифрами подряд', () => {
    expect(auditMinted('payout_idempotency', TRANCHE_WITH_RUN).value).toBe(PAYOUT_KEY_WITH_RUN);
    expect(auditMinted('refund_idempotency', TRANCHE_WITH_REFUND_RUN).value).toBe(
      REFUND_KEY_WITH_RUN,
    );
    expect(auditMinted('withdrawal_idempotency', WITHDRAWAL_WITH_RUN).value).toBe(
      WITHDRAWAL_KEY_WITH_RUN,
    );
    for (const key of [PAYOUT_KEY_WITH_RUN, REFUND_KEY_WITH_RUN, WITHDRAWAL_KEY_WITH_RUN]) {
      expect(DIGIT_RUN.test(key)).toBe(true);
    }
  });

  it('без заявки о чеканке такой ключ в журнал не проходит — это и был дефект', () => {
    // Утверждение о **старом** поведении, оставленное намеренно: заявка не
    // «включает послабление для поля», она доказывает конкретное значение.
    // Убери её — и запись перестанет собираться, как и до правки.
    const error = expectAuditError(
      () => orderedPayout(PAYOUT_KEY_WITH_RUN, null),
      AuditErrorCode.rawIdentifier,
    );
    expect(error.details['rule']).toBe('digit_run');
  });
});

describe('собственный детерминированный ключ отличается от сырого идентификатора', () => {
  it('поручение на выплату с таким ключом записывается', () => {
    const chain = orderedPayout(PAYOUT_KEY_WITH_RUN, [
      auditMinted('payout_idempotency', TRANCHE_WITH_RUN),
    ]);
    expect(chain.records).toHaveLength(2);
    expect(chain.records[1]?.subject.id).toBe(PAYOUT_KEY_WITH_RUN);
    expect(verifyChain(chain).intact).toBe(true);
  });

  it('заявка доказывает **значение**, а не поле: чужая схема не спасает', () => {
    // Ключ расчёта, объявленный ключом возврата, — это другое значение, и
    // пересчёт его не даёт. Подставить схему наугад нельзя.
    expectAuditError(
      () =>
        orderedPayout(PAYOUT_KEY_WITH_RUN, [
          auditMinted('refund_idempotency', TRANCHE_WITH_RUN),
        ]),
      AuditErrorCode.rawIdentifier,
    );
  });

  it('послабление действует на строку целиком, а не на её часть', () => {
    const minted = [auditMinted('payout_idempotency', TRANCHE_WITH_RUN)];
    // Строка, в которую отчеканенный ключ вложен, отчеканенной не становится:
    // иначе к ней можно было бы приписать что угодно.
    expectAuditError(
      () => assertNoRawIdentifiers({ note: `${PAYOUT_KEY_WITH_RUN}~tail` }, '$', minted),
      AuditErrorCode.rawIdentifier,
    );
  });
});

describe('обратное направление: сырой идентификатор по-прежнему не проходит', () => {
  it('номер документа, счёт и телефон отвергаются и при предъявленной заявке', () => {
    // Заявка настоящая и сошлась — и всё равно не открывает дорогу ничему,
    // кроме собственного значения. Иначе починка была бы тем самым
    // ослаблением правила, которого делать нельзя.
    const minted = [auditMinted('payout_idempotency', TRANCHE_WITH_RUN)];
    const document = expectAuditError(
      () => assertNoRawIdentifiers({ document: RAW_DOCUMENT_NUMBER }, '$', minted),
      AuditErrorCode.rawIdentifier,
    );
    expect(document.details['rule']).toBe('digit_run');
    const account = expectAuditError(
      () => assertNoRawIdentifiers({ account: RAW_ACCOUNT_IBAN }, '$', minted),
      AuditErrorCode.rawIdentifier,
    );
    expect(account.details['rule']).toBe('iban');
    const phone = expectAuditError(
      () => assertNoRawIdentifiers({ contact: RAW_PHONE }, '$', minted),
      AuditErrorCode.rawIdentifier,
    );
    expect(phone.details['rule']).toBe('phone');
    // Значение в отказ не попадает ни в одном из трёх случаев.
    for (const error of [document, account, phone]) {
      expect(JSON.stringify(error.details)).not.toContain('0101904917');
    }
  });

  it('запись с сырым номером не собирается и при верной заявке о чеканке', () => {
    const chain = newChain();
    expectAuditError(
      () =>
        appendRecord(chain, {
          recordId: `${chain.chainId}:r1`,
          recordedAt: at(1),
          actor: APPROVER,
          subject: auditRef('payout', PAYOUT_KEY_WITH_RUN),
          related: [TRANCHE, DEAL],
          minted: [auditMinted('payout_idempotency', TRANCHE_WITH_RUN)],
          body: {
            kind: 'payout_ordered',
            idempotencyKey: PAYOUT_KEY_WITH_RUN,
            amount: auditAmount('GEL', 1_250_00n),
            beneficiary: BENEFICIARY,
            policy: PAYOUT_POLICY,
            evidencePackage: [
              source(1, 'condition_act', 'cabinet'),
              // Сырой номер, спрятанный в поле сырого источника.
              { ...source(3), provider: RAW_DOCUMENT_NUMBER },
            ],
          },
        }),
      AuditErrorCode.rawIdentifier,
    );
  });
});

describe('объявить своим произвольную строку нельзя', () => {
  it('заявка с подставленным значением отвергается пересчётом', () => {
    // Так выглядела бы попытка «объявить своим» паспортный номер: собрать
    // объект руками, минуя `auditMinted`. Пересчёт не сходится.
    const forged = {
      kind: 'minted',
      scheme: 'payout_idempotency',
      source: TRANCHE_WITH_RUN,
      value: RAW_DOCUMENT_NUMBER,
    } as unknown as AuditMinted;
    expect(mintIsAuthentic(forged)).toBe(false);
    const error = expectAuditError(
      () => assertNoRawIdentifiers({ document: RAW_DOCUMENT_NUMBER }, '$', [forged]),
      AuditErrorCode.mintNotDerived,
    );
    // В отказ попадает схема из закрытого перечня — и ничего больше.
    expect(error.details).toEqual({ scheme: 'payout_idempotency' });
    expect(JSON.stringify(error.details)).not.toContain(RAW_DOCUMENT_NUMBER);
  });

  it('схема вне закрытого перечня не чеканит ничего', () => {
    expectAuditError(
      () => auditMinted('anything' as never, TRANCHE_WITH_RUN),
      AuditErrorCode.mintSchemeUnknown,
    );
    expect(isMintScheme('anything')).toBe(false);
    expect(isMintScheme('payout_idempotency')).toBe(true);
    // Перечень закрыт: три схемы, и новая появляется правкой кода.
    expect(MINT_SCHEME_IDS).toEqual([
      'payout_idempotency',
      'refund_idempotency',
      'withdrawal_idempotency',
    ]);
  });

  it('значение не принимается аргументом: наружу выходит образ, а не вход', () => {
    // Единственный способ пополнить множество доказанных значений — назвать
    // вход. Паспортный номер, поданный входом, выходит отпечатком.
    const minted = auditMinted('payout_idempotency', RAW_DOCUMENT_NUMBER);
    expect(minted.value).not.toBe(RAW_DOCUMENT_NUMBER);
    expect(minted.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-/u);
    // И даже он не открывает дорогу самому номеру.
    expectAuditError(
      () => assertNoRawIdentifiers({ document: RAW_DOCUMENT_NUMBER }, '$', [minted]),
      AuditErrorCode.rawIdentifier,
    );
  });

  it('пространство имён схемы — то, из которого чеканит домен', () => {
    for (const scheme of MINT_SCHEME_IDS) {
      expect(mintNamespace(scheme)).toBe(MINT_SCHEMES[scheme]);
      expect(mintNamespace(scheme)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    }
  });
});

/**
 * Соседи по семейству: что ещё мы чеканим сами и кладём в журнал.
 *
 * Проверено поимённо, а не «на глаз»:
 *
 * - **идентификатор записи журнала аудита** (`app/src/ids.ts`,
 *   `auditRecordId`) — `{цепочка}:r{номер}`. В теле записи он появляется у
 *   исправления (`correctsRecordId`) и у метки времени (`coversRecordId`), то
 *   есть под правило попадает. Цифры цепочки от цифр номера отделяет
 *   двоеточие, поэтому девять подряд возможны **только** из номера — начиная со
 *   сотого миллиона записей одной цепочки. Граница закреплена ниже;
 * - **идентификатор записи журнала учёта** (`journalEntryId`) в журнал аудита
 *   не попадает вовсе: `assertNoRawIdentifiers` зовётся только из `chain.ts`;
 * - **ключ конверсии** приезжает снаружи (`flow.ts`, `convertBalance`), уходит
 *   в код счёта учёта и в журнал аудита не попадает. Своим он не является и
 *   послаблений не получает — так и должно быть;
 * - **ссылка на версию настройки** (`PolicyRef`) имеет вид
 *   `домен/ГГГГ-ММ-ДД.N`: длиннее четырёх цифр подряд в ней только `N`.
 */
describe('соседи по семейству: остальное, что мы чеканим сами', () => {
  it('идентификатор записи журнала под правило не подпадает до сотого миллиона', () => {
    const chainId = 'chain:deal-1';
    // Цифры цепочки и номера разделены двоеточием: подряд они не идут.
    expect(() =>
      assertNoRawIdentifiers({ correctsRecordId: `${chainId}:r99999999` }),
    ).not.toThrow();
    // Граница названа, а не подразумевается: сотый миллион записей одной
    // цепочки — та же беда того же семейства, и она **не** починена.
    expectAuditError(
      () => assertNoRawIdentifiers({ correctsRecordId: `${chainId}:r100000000` }),
      AuditErrorCode.rawIdentifier,
    );
  });

  it('идентификатор цепочки с длинной цифровой серией отвергается на генезисе', () => {
    // Поведение прежнее и намеренно прежнее: имя цепочки задаём не мы одни, и
    // послабления оно не получает.
    expectAuditError(() => newChain('chain:100000000'), AuditErrorCode.rawIdentifier);
  });

  it('ссылка на версию настройки правилу не мешает', () => {
    expect(() => assertNoRawIdentifiers({ policy: 'fx/2026-09-04.1' })).not.toThrow();
  });
});

describe('красная линия №11: записанное не переписывается', () => {
  it('заявка о чеканке в запись не попадает и хеша не меняет', () => {
    // Пропуск на входе — не поле журнала. Запись с заявкой и без неё
    // совпадает до последнего поля, а значит и до хеша: прочтение уже
    // записанного правка не двигает.
    const key = 'payout-plain-1';
    const withClaim = orderedPayout(key, [auditMinted('payout_idempotency', 'tranche-1')]);
    const withoutClaim = orderedPayout(key, null);
    expect(withClaim.records[1]).toEqual(withoutClaim.records[1]);
    expect(withClaim.records[1]?.recordHash).toBe(withoutClaim.records[1]?.recordHash);
    expect(Object.keys(withClaim.records[1] ?? {})).not.toContain('minted');
  });

  it('цепочка, записанная до правки, читается и сходится после неё', () => {
    // Записи собраны без единой заявки — как их собирал прежний код, — и
    // проверяются нынешним: хеш каждой пересчитывается по её же полям.
    let chain = newChain();
    chain = appendRecord(chain, {
      recordId: `${chain.chainId}:r1`,
      recordedAt: at(1),
      actor: SYSTEM,
      subject: TRANCHE,
      related: [DEAL],
      body: {
        kind: 'state_transition',
        machine: 'tranche',
        from: 'collecting',
        to: 'collected',
        eventKey: 'funds_received',
        failedGuards: [],
      },
    });
    chain = appendRecord(chain, {
      recordId: `${chain.chainId}:r2`,
      recordedAt: at(2),
      actor: APPROVER,
      subject: auditRef('payout', 'payout-legacy-1'),
      related: [TRANCHE, DEAL],
      body: {
        kind: 'payout_ordered',
        idempotencyKey: 'payout-legacy-1',
        amount: auditAmount('GEL', 1_250_00n),
        beneficiary: BENEFICIARY,
        policy: PAYOUT_POLICY,
        evidencePackage: [source(1, 'condition_act', 'cabinet')],
      },
    });
    expect(verifyChain(chain).intact).toBe(true);
    for (const record of chain.records) {
      const { recordHash, ...envelope } = record;
      expect(recordDigest(envelope)).toBe(recordHash);
    }
  });
});
