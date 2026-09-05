import {
  type Money,
  convert,
  fxRates,
  isoDate,
  money,
  platformSpread,
  rationalFromDecimalString,
} from '@sdelka/money';
import {
  type ClientKey,
  type DealPartiesAttestation,
  type Journal,
  type JournalEntry,
  type TrancheRef,
  absorbShortfall,
  accrueFee,
  appendEntries,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  clientTopUp,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  executeConversion,
  fundShortfall,
  fxExecution,
  identifySuspense,
  lockForTranche,
  receiveConversion,
  receiveFee,
  refundToSourceAccount,
  sendForConversion,
  settleTrancheToClientAccount,
  trancheSettlement,
  unlockToClientAccount,
  writeOffTransitArrived,
  writeOffUnclaimed,
} from '@sdelka/ledger';
import { expect, it } from 'vitest';
import { dbSuite, withRollback } from './support/pg.ts';
import { readViolations, writeJournal } from './support/write.ts';

/**
 * Центральный тест батча: **база и код видят одни и те же расхождения**.
 *
 * На каждом сценарии журнал строится существующими конструкторами
 * `packages/ledger`, заливается в базу, и `v_ledger_invariant_violation`
 * сравнивается с `checkLedgerInvariants` посимвольно. Расхождение здесь
 * означает, что один из двух контуров врёт, и неважно который: инвариант,
 * который база и код понимают по-разному, — это не инвариант.
 */
const suite = await dbSuite('база видит то же, что checkLedgerInvariants');

const buyer = clientKey('buyer-1');
const seller = clientKey('seller-1');
const deal: TrancheRef = { dealId: 'deal-1', trancheId: 'tranche-1' };

function at(id: string, minute = 0): { id: string; occurredAt: string } {
  return { id, occurredAt: `2026-09-03T10:${String(minute).padStart(2, '0')}:00Z` };
}

/**
 * Момент через трое суток. Возраст открытой позиции и застрявшего транзита
 * считается от **последнего известного факта журнала**, а не от системных
 * часов (`InvariantOptions.asOf`), поэтому «прошло трое суток» выражается
 * поздней записью, а не подкруткой времени в тесте.
 */
function threeDaysLater(id: string): { id: string; occurredAt: string } {
  return { id, occurredAt: '2026-09-06T10:00:00Z' };
}

/** Посторонняя запись — она нужна только затем, чтобы сдвинуть «сейчас». */
function unrelatedLater(id: string): JournalEntry {
  return clientTopUp(threeDaysLater(id), clientKey('bystander-1'), gel(1_000n));
}

/**
 * Подтверждение сторон — работа домена. Построить его кодом нельзя: у него
 * ambient-ключ. Приведение стоит здесь по той же причине, по которой оно стоит
 * в `packages/ledger/test/support`: тестам нужно предъявить то, что учёт по
 * построению изготовить не может.
 */
function attest(
  ref: TrancheRef,
  payer: ClientKey,
  recipient: ClientKey,
): DealPartiesAttestation {
  return {
    dealId: ref.dealId,
    trancheId: ref.trancheId,
    payer,
    recipient,
    evidenceRef: 'evidence-1',
  } as unknown as DealPartiesAttestation;
}

const gel = (minor: bigint): Money => money('GEL', minor);

const rates = fxRates('USD', 'GEL', {
  client: rationalFromDecimalString('2.6686875'),
  reference: rationalFromDecimalString('2.6875'),
  official: rationalFromDecimalString('2.7000'),
});
const usd = money('USD', 8_000_000n);
const converted = convert(usd, rates, isoDate('2026-09-03'), 'trunc');
const spread = platformSpread(converted, 'trunc');
const exchange = fxExecution('x1', converted);

/**
 * Запись в обход словаря — по образцу `packages/ledger/test/support/unchecked-entry.ts`.
 * Нужна ровно там, где проверяется **обнаружение уже существующего**
 * расхождения: собрать его конструктором нельзя, а из базы такое приезжает —
 * в том числе сделанное до появления проверки.
 */
function uncheckedEntry(input: Parameters<typeof createJournalEntry>[0]): JournalEntry {
  return Object.freeze({
    id: input.id,
    occurredAt: input.occurredAt,
    kind: input.kind,
    postings: Object.freeze([...input.postings]),
    memoKey: input.memoKey,
    correctsEntryId: input.correctsEntryId ?? null,
    settles: input.settles ?? null,
    converts: input.converts ?? null,
    accrues: input.accrues ?? null,
    funds: input.funds ?? null,
  });
}

interface Scenario {
  readonly name: string;
  readonly journal: Journal;
  /**
   * Сценарий обязан дать хотя бы одно расхождение.
   *
   * Без этой пометки тест «база видит то же, что код» проходит и тогда, когда
   * оба не видят ничего: сравнение двух пустых списков зелёное. Пометка
   * превращает сценарий-нарушитель в проверку обнаружения, а не только
   * согласия.
   */
  readonly violating?: true;
  /**
   * Какие именно коды обязан дать сценарий.
   *
   * «Хотя бы одно расхождение» — слабое условие: сценарий, задуманный про
   * пофайловую недостачу, может пройти на постороннем `custody_surplus` и
   * выглядеть проверяющим то, чего он не проверяет.
   */
  readonly expectCodes?: readonly string[];
}

function scenarios(): readonly Scenario[] {
  const list: Scenario[] = [];

  list.push({
    name: 'пустой журнал',
    journal: emptyJournal,
  });

  list.push({
    name: 'зачисление на счёт клиента',
    journal: appendEntries(emptyJournal, [clientTopUp(at('t1'), buyer, gel(100_000n))]),
  });

  list.push({
    name: 'опознание непознанного поступления',
    journal: appendEntries(emptyJournal, [
      uncheckedEntry({
        id: 's1',
        occurredAt: at('s1').occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.suspense_arrived',
        postings: [
          debit(bankNominal('GEL'), gel(100_000n)),
          credit({ kind: 'suspense_unidentified' }, gel(100_000n)),
        ],
      }),
      identifySuspense(at('s2', 5), buyer, gel(100_000n)),
    ]),
  });

  list.push({
    name: 'привязка к сделке и расчёт получателю',
    journal: appendEntries(emptyJournal, [
      clientTopUp(at('t1'), buyer, gel(100_000n)),
      lockForTranche(at('t2', 5), buyer, deal, gel(100_000n)),
      settleTrancheToClientAccount(
        at('t3', 10),
        trancheSettlement(deal, buyer, seller, attest(deal, buyer, seller)),
        gel(100_000n),
      ),
    ]),
  });

  list.push({
    name: 'отвязка и возврат на счёт-источник',
    journal: appendEntries(emptyJournal, [
      clientTopUp(at('t1'), buyer, gel(100_000n)),
      lockForTranche(at('t2', 5), buyer, deal, gel(100_000n)),
      unlockToClientAccount(at('t3', 10), buyer, deal, gel(100_000n)),
      refundToSourceAccount(at('t4', 15), buyer, gel(100_000n)),
    ]),
  });

  list.push({
    name: 'списание невостребованного через транзит',
    journal: appendEntries(emptyJournal, [
      clientTopUp(at('t1'), buyer, gel(100_000n)),
      lockForTranche(at('t2', 5), buyer, deal, gel(100_000n)),
      writeOffUnclaimed(at('t3', 10), buyer, deal, gel(100_000n)),
      writeOffTransitArrived(at('t4', 15), gel(100_000n)),
    ]),
  });

  list.push({
    name: 'списание невостребованного, транзит ещё в пути',
    violating: true,
    expectCodes: ['ledger.invariant.transit_stale'],
    journal: appendEntries(emptyJournal, [
      clientTopUp(at('t1'), buyer, gel(100_000n)),
      lockForTranche(at('t2', 5), buyer, deal, gel(100_000n)),
      writeOffUnclaimed(at('t3', 10), buyer, deal, gel(100_000n)),
      unrelatedLater('t4'),
    ]),
  });

  const recognised = absorbShortfall(at('sh1'), buyer, gel(99_900n), gel(100n));
  list.push({
    name: 'недостача признана, но не покрыта — покрытие ниже единицы',
    violating: true,
    expectCodes: ['ledger.invariant.coverage_below_one', 'ledger.invariant.client_account_uncovered'],
    journal: appendEntries(emptyJournal, [recognised]),
  });
  list.push({
    name: 'недостача признана и покрыта деньгами платформы',
    journal: appendEntries(emptyJournal, [
      // Операционный счёт сначала пополняется: иначе довнесение уводит его в
      // минус, и это отдельное расхождение (`negativeBankBalance`).
      uncheckedEntry({
        id: 'op1',
        occurredAt: at('op1').occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.operating_funded',
        postings: [
          debit(bankOperating('GEL'), gel(1_000n)),
          credit({ kind: 'service_income' }, gel(1_000n)),
        ],
      }),
      recognised,
      fundShortfall(at('sh2', 5), recognised),
    ]),
  });

  const accrual = accrueFee(at('f1'), deal, gel(2_000n), 'tariff-v1');
  list.push({
    name: 'комиссия начислена, удержана и получена',
    journal: appendEntries(emptyJournal, [
      clientTopUp(at('t1'), buyer, gel(100_000n)),
      lockForTranche(at('t2', 5), buyer, deal, gel(100_000n)),
      accrual,
      settleTrancheToClientAccount(
        at('t3', 10),
        trancheSettlement(deal, buyer, seller, attest(deal, buyer, seller)),
        gel(100_000n),
        accrual,
      ),
      receiveFee(at('t4', 15), deal, gel(2_000n)),
    ]),
  });

  // Начислено и удерживать уже не из чего: расчёт прошёл, деньги транша ушли,
  // требование осталось. Прямой случай — двойное начисление, но собрать его
  // конструктором нельзя (`journalFeeAccruedTwice`), поэтому здесь тот же
  // результат достигается расчётом **без удержания**: удержание — отдельный
  // аргумент, и `null` в нём законен.
  const strandedAccrual = accrueFee(at('sf1'), deal, gel(2_000n), 'tariff-v1');
  list.push({
    name: 'комиссия начислена, транш рассчитан без удержания',
    violating: true,
    expectCodes: ['ledger.invariant.fee_not_withheld'],
    journal: appendEntries(emptyJournal, [
      clientTopUp(at('t1'), buyer, gel(100_000n)),
      lockForTranche(at('t2', 5), buyer, deal, gel(100_000n)),
      strandedAccrual,
      settleTrancheToClientAccount(
        at('t3', 10),
        trancheSettlement(deal, buyer, seller, attest(deal, buyer, seller)),
        gel(100_000n),
        null,
      ),
    ]),
  });

  // Начислено, транш ещё заперт — состояние законное, — но требование висит
  // дольше окна. Окно у комиссии своё (`feeStaleAfterMs`), умолчание то же, что
  // у транзита, и «прошло трое суток» выражается поздней записью.
  list.push({
    name: 'комиссия начислена и висит требованием третьи сутки',
    violating: true,
    expectCodes: ['ledger.invariant.fee_receivable_stale'],
    journal: appendEntries(emptyJournal, [
      clientTopUp(at('t1'), buyer, gel(100_000n)),
      lockForTranche(at('t2', 5), buyer, deal, gel(100_000n)),
      accrueFee(at('f1', 10), deal, gel(2_000n), 'tariff-v1'),
      unrelatedLater('later'),
    ]),
  });

  list.push({
    name: 'обмен: все три момента',
    journal: appendEntries(emptyJournal, [
      clientTopUp(at('t1'), buyer, usd),
      sendForConversion(at('c1', 5), buyer, exchange),
      executeConversion(at('c2', 10), buyer, exchange),
      receiveConversion(at('c3', 15), buyer, exchange, spread),
    ]),
  });

  list.push({
    name: 'обмен: встречная валюта не поставлена, позиция открыта',
    violating: true,
    expectCodes: ['ledger.invariant.fx_position_open'],
    journal: appendEntries(emptyJournal, [
      clientTopUp(at('t1'), buyer, usd),
      sendForConversion(at('c1', 5), buyer, exchange),
      executeConversion(at('c2', 10), buyer, exchange),
      unrelatedLater('c3'),
    ]),
  });

  // --- Сценарии-нарушители: собраны в обход словаря -------------------------

  list.push({
    name: 'несбалансированная запись',
    violating: true,
    expectCodes: ['ledger.invariant.entry_unbalanced'],
    journal: appendEntries(emptyJournal, [
      uncheckedEntry({
        id: 'bad1',
        occurredAt: at('bad1').occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.client_top_up',
        postings: [
          debit(bankNominal('GEL'), gel(100_000n), { clientKey: buyer }),
          credit(clientFreeAccount(buyer), gel(99_999n), { clientKey: buyer }),
        ],
      }),
    ]),
  });

  list.push({
    name: 'отмывка через непознанное поступление (две записи)',
    violating: true,
    expectCodes: ['ledger.invariant.custody_surplus'],
    journal: appendEntries(emptyJournal, [
      clientTopUp(at('t1'), buyer, gel(100_000n)),
      lockForTranche(at('t2', 5), buyer, deal, gel(100_000n)),
      uncheckedEntry({
        id: 'wash1',
        occurredAt: at('wash1', 10).occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.laundering',
        postings: [
          debit(clientLockedAccount(buyer, deal.dealId, deal.trancheId), gel(100_000n), {
            dealId: deal.dealId,
            trancheId: deal.trancheId,
          }),
          credit({ kind: 'suspense_unidentified' }, gel(100_000n)),
        ],
      }),
      uncheckedEntry({
        id: 'wash2',
        occurredAt: at('wash2', 15).occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.laundering',
        postings: [
          debit({ kind: 'suspense_unidentified' }, gel(100_000n)),
          credit(clientFreeAccount(seller), gel(100_000n), { clientKey: seller }),
        ],
      }),
    ]),
  });

  list.push({
    name: 'отмывка через невостребованное (две записи)',
    violating: true,
    expectCodes: ['ledger.invariant.custody_surplus'],
    journal: appendEntries(emptyJournal, [
      clientTopUp(at('t1'), buyer, gel(100_000n)),
      lockForTranche(at('t2', 5), buyer, deal, gel(100_000n)),
      uncheckedEntry({
        id: 'wash3',
        occurredAt: at('wash3', 10).occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.laundering',
        postings: [
          debit(clientLockedAccount(buyer, deal.dealId, deal.trancheId), gel(100_000n), {
            dealId: deal.dealId,
            trancheId: deal.trancheId,
          }),
          credit({ kind: 'unclaimed_liability' }, gel(100_000n)),
        ],
      }),
      uncheckedEntry({
        id: 'wash4',
        occurredAt: at('wash4', 15).occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.laundering',
        postings: [
          debit({ kind: 'unclaimed_liability' }, gel(100_000n)),
          credit(clientFreeAccount(seller), gel(100_000n), { clientKey: seller }),
        ],
      }),
    ]),
  });

  list.push({
    name: 'удержание комиссии без начисления — требование в минусе',
    violating: true,
    expectCodes: ['ledger.invariant.platform_asset_negative'],
    journal: appendEntries(emptyJournal, [
      uncheckedEntry({
        id: 'fee-bad',
        occurredAt: at('fee-bad').occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.fee_withheld',
        postings: [
          credit({ kind: 'fee_receivable' }, gel(2_000n), {
            dealId: deal.dealId,
            trancheId: deal.trancheId,
          }),
          debit({ kind: 'transit_fee' }, gel(2_000n), {
            dealId: deal.dealId,
            trancheId: deal.trancheId,
          }),
        ],
      }),
    ]),
  });

  list.push({
    name: 'довнесение сверх признанного',
    violating: true,
    expectCodes: ['ledger.invariant.shortfall_overfunded'],
    journal: appendEntries(emptyJournal, [
      uncheckedEntry({
        id: 'op1',
        occurredAt: at('op1').occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.operating_funded',
        postings: [
          debit(bankOperating('GEL'), gel(10_000n)),
          credit({ kind: 'service_income' }, gel(10_000n)),
        ],
      }),
      recognised,
      fundShortfall(at('sh2', 5), recognised),
      // Второе довнесение без второго признания: подарок, а не покрытие.
      uncheckedEntry({
        id: 'gift',
        occurredAt: at('gift', 10).occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.shortfall_funded',
        postings: [
          debit(bankNominal('GEL'), gel(500n), { clientKey: buyer }),
          credit(bankOperating('GEL'), gel(500n)),
        ],
      }),
    ]),
  });

  list.push({
    name: 'кастодиан уведён из файла транша, обязательства по нему не было',
    violating: true,
    expectCodes: ['ledger.invariant.tranche_uncovered'],
    journal: appendEntries(emptyJournal, [
      clientTopUp(at('t1'), seller, gel(100_000n)),
      // Кредит номинального счёта, отнесённый к траншу, по которому
      // обязательства не заводилось: файл транша уходит в минус, хотя
      // `client_locked` по нему нет ни одной проводки. Пофайловая сверка обязана
      // это видеть — отбор «только файлы с обязательством» прятал бы ровно этот
      // случай.
      uncheckedEntry({
        id: 'drain',
        occurredAt: at('drain', 5).occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.drain',
        postings: [
          debit(clientFreeAccount(seller), gel(50_000n), { clientKey: seller }),
          credit(bankNominal('GEL'), gel(50_000n), {
            dealId: deal.dealId,
            trancheId: deal.trancheId,
          }),
        ],
      }),
    ]),
  });

  return list;
}

suite.run(suite.title, () => {
  const pool = suite.pool;

  for (const scenario of scenarios()) {
    it(scenario.name, async () => {
      if (pool === null) return;
      const expected = [...checkLedgerInvariants(scenario.journal)]
        .map((item) => ({
          code: item.code as string,
          currency: item.currency as string | null,
          subject: item.subject,
          amountMinor: item.amountMinor,
        }))
        .sort(compare);
      if (scenario.violating === true) {
        expect(expected.length, 'сценарий-нарушитель обязан дать расхождение').toBeGreaterThan(0);
      }
      for (const code of scenario.expectCodes ?? []) {
        expect(expected.map((item) => item.code), code).toContain(code);
      }

      const actual = await withRollback(pool, async (client) => {
        await writeJournal(client, scenario.journal);
        if (scenario.violating !== true) {
          // Законный журнал обязан проходить **все** ограничения базы, а не
          // только те, что успевают сработать на вставке. Отложенные
          // (нулевая сумма записи, отрицательный остаток, зеркальность
          // исправления, одно начисление на транш, ключ конверсии)
          // срабатывают на `COMMIT`, а коммита здесь нет и не будет: тесты
          // ничего за собой не удаляют, потому что журнал только дополняется.
          // `SET CONSTRAINTS ALL IMMEDIATE` проверяет их в том же месте, но
          // оставляет базу чистой — тот же приём, что в `ledger.int.test.ts` и
          // `balance.int.test.ts`.
          //
          // Прежняя редакция выполняла здесь `ALL DEFERRED` — то есть ровно
          // противоположное тому, что обещал комментарий над ней, и при этом
          // пустую операцию: все constraint-триггеры схемы объявлены
          // `INITIALLY DEFERRED`. Ни одно отложенное правило на этом наборе не
          // проверялось вовсе.
          await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        }
        // Сценарий-нарушитель остаётся с отложенными проверками намеренно:
        // половина расхождений сводки (несбалансированная запись,
        // требование в минусе, отмывка исправлением) — это ровно то, что
        // ограничения базы не пускают. Такой журнал приезжает из истории и из
        // импорта, и сводка обязана уметь его **назвать**, а не отказаться
        // читать. Проверять здесь надо именно выдачу представления.
        return readViolations(client);
      });

      expect([...actual].sort(compare)).toEqual(expected);
    });
  }
});

function compare(
  left: { code: string; currency: string | null; subject: string; amountMinor: bigint },
  right: { code: string; currency: string | null; subject: string; amountMinor: bigint },
): number {
  const key = (item: typeof left): string =>
    `${item.code}|${item.currency ?? ''}|${item.subject}|${item.amountMinor}`;
  return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
}
