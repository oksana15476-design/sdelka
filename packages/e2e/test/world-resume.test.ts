import { describe, expect, it } from 'vitest';
import {
  WITHOUT_STORE,
  advance,
  invariantViolations,
  rejectTrancheEvent,
  restoreWorld,
  restoredViolations,
  resumeWorld,
  stepResult,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import { instant } from '@sdelka/domain';
import { balanceByCurrency } from '@sdelka/ledger';
import { money } from '@sdelka/money';
import { applyTrancheEvent } from './support/acting';
import { DEAL_AMOUNT, GEL, NOW, POLICY_VERSION } from './support/fixtures';
import { REFUND_SCOPE, collectedPath } from './support/store-path';
import { memoryWorldStore } from './support/memory-store';

/**
 * Перезапущенный процесс продолжает мир.
 *
 * **Дефект, который здесь закрыт.** Подъём из хранилища отдавал `RestoredWorld`
 * — снимки, а не мир, — и продолжить его было нечем: ни следующего шага, ни
 * счётчика записей. Новый процесс с той же цепочкой начинал счёт заново и
 * встречал собственные строки. Теперь есть `resumeWorld`, и он **не** дверь
 * мимо запечатывания: поднятое проходит ту же проверку поверхности, что и шаг
 * мира, нарушение возвращается значением, а из фактов приложения подъём
 * принимает ровно один — собранную сумму, — и её немедленно проверяет учёт.
 *
 * **Путь — возвратный** (красная линия №7): состояние по умолчанию при
 * бездействии обязано переживать перезапуск. Расчёт получателю поднятый мир не
 * умеет и уметь не должен — это отдельная проверка ниже.
 */

const OPTIONS = trancheOptions(POLICY_VERSION);
/** Деньги уже на свободной части счёта клиента: откат резерва их не зачисляет заново. */
const ROLLBACK = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });
const DAY_MS = 24 * 60 * 60 * 1000;

const SCOPE = Object.freeze({
  ...REFUND_SCOPE,
  dealId: 'deal-store-resume',
  trancheId: 'tranche-store-resume',
  chainId: 'chain-store-resume',
});
const DEAL = SCOPE.dealId;
const TRANCHE = SCOPE.trancheId;
const CHAIN = SCOPE.chainId;

const REQUEST = {
  chainId: CHAIN,
  deals: [{ dealId: DEAL, trancheIds: [TRANCHE] }],
  // Заявок на вывод в этом сценарии нет: «ничьих» написано словом, а не
  // получается пропуском аргумента. Круг «шаг → база → подъём» по заявке идёт
  // отдельным набором (`withdrawal-store.test.ts`).
  parties: [],
};

/** Мир, доведённый до резерва и целиком лежащий в хранилище. */
async function reservedWorld(store: Parameters<typeof collectedPath>[0]) {
  const collected = await collectedPath(store, SCOPE);
  const reserved = await stepResult(store, collected.world, (world) =>
    applyTrancheEvent(world, TRANCHE, { type: 'reserve_requested' }, OPTIONS),
  );
  return reserved.world;
}

describe('перезапуск: поднятый мир продолжает работу', () => {
  it('сохранили, прочитали, сделали следующий шаг — состояние сошлось', async () => {
    const store = memoryWorldStore();
    const saved = await reservedWorld(store);
    expect(trancheStatusOf(saved, TRANCHE)).toBe('reserved');

    /* --- Новый процесс: о мире в памяти он не знает ничего --- */
    const restored = await restoreWorld(store, REQUEST);
    expect(restoredViolations(restored)).toEqual([]);

    const resumption = resumeWorld(restored, {
      // Часы приносит новый процесс: времени в хранилище нет — оно не состояние.
      now: advance(saved, DAY_MS).now,
      // Единственный факт приложения, который подъём принимает, — и учёт его
      // проверяет: объявить больше обеспеченного не даст.
      declared: [{ trancheId: TRANCHE, collected: DEAL_AMOUNT }],
    });
    if (resumption.kind !== 'resumed') {
      throw new Error(`подъём отказал: ${JSON.stringify(resumption.violations)}`);
    }

    /*
     * Счётчик записей взят **из записанного**, а не начат с нуля: он равен
     * счётчику мира, который эти записи оставил. Без этого первая же запись
     * нового процесса получила бы занятый идентификатор.
     */
    expect(resumption.world.seq).toBe(saved.seq);
    expect(resumption.world.journal.entries).toEqual(saved.journal.entries);
    expect(resumption.world.chain).toEqual(saved.chain);
    expect(trancheOf(resumption.world, TRANCHE).state).toEqual(trancheOf(saved, TRANCHE).state);
    // Инварианты у поднятого мира считаются так же, как у любого другого.
    expect(invariantViolations(resumption.world)).toEqual([]);
    // Чего поднятый мир не знает — названо значением, а не примечанием.
    expect(resumption.gaps.map((gap) => gap.reasonKey)).toContain('beneficiary.not_storable');
    expect(resumption.gaps.map((gap) => gap.reasonKey)).toContain('approvals.not_storable');

    /* --- Следующий шаг: срок резерва истёк, деньги распираются --- */
    const memory = await stepResult(WITHOUT_STORE, advance(saved, DAY_MS), (world) =>
      applyTrancheEvent(world, TRANCHE, { type: 'reserve_expired' }, ROLLBACK),
    );
    const continued = await stepResult(store, resumption.world, (world) =>
      applyTrancheEvent(world, TRANCHE, { type: 'reserve_expired' }, ROLLBACK),
    );

    // Состояние сошлось: тот же статус автомата, тот же журнал учёта, та же
    // цепочка аудита — шаг из поднятого мира неотличим от шага из мира,
    // который процесс не терял.
    expect(trancheStatusOf(continued.world, TRANCHE)).toBe('collected');
    expect(trancheOf(continued.world, TRANCHE).state).toEqual(
      trancheOf(memory.world, TRANCHE).state,
    );
    expect(continued.world.journal.entries).toEqual(memory.world.journal.entries);
    expect(continued.world.chain).toEqual(memory.world.chain);
    expect(invariantViolations(continued.world)).toEqual([]);

    /*
     * Шаг лёг в базу **новыми** строками: ни одна не опозналась повтором и ни
     * одна не столкнулась с чужой. Это и есть проверка восстановленного
     * счётчика — на нулевом счётчике здесь был бы конфликт хранилища.
     */
    expect(continued.outcome.written).toBeGreaterThan(0);
    expect(continued.outcome.repeated).toBe(0);

    // И то же самое со стороны базы: поднятый заново мир несёт распирание.
    const again = await restoreWorld(store, REQUEST);
    expect(again.journal.entries).toEqual(continued.world.journal.entries);
    expect(again.deals[0]?.tranches[0]?.snapshot.state.status).toBe('collected');
    expect(restoredViolations(again)).toEqual([]);
  });

  it('сумма проводок в прочитанном охвате равна нулю', async () => {
    const store = memoryWorldStore();
    await reservedWorld(store);
    const restored = await restoreWorld(store, REQUEST);

    // По записи — инвариант 1 в его исходном виде.
    for (const entry of restored.journal.entries) {
      for (const [, total] of balanceByCurrency(entry.postings)) expect(total).toBe(0n);
    }
    // И по охвату целиком: охват, отдающий половину парной записи, дал бы
    // здесь остаток, а по одной записи всё сходилось бы.
    const postings = restored.journal.entries.flatMap((entry) => entry.postings);
    expect(postings.length).toBeGreaterThan(0);
    for (const [, total] of balanceByCurrency(postings)) expect(total).toBe(0n);
  });
});

describe('перезапуск: поднятый мир, который продолжать нельзя', () => {
  it('объявленное собранное сверх обеспеченного — отказ значением, а не мир', async () => {
    const store = memoryWorldStore();
    await reservedWorld(store);
    const restored = await restoreWorld(store, REQUEST);

    const resumption = resumeWorld(restored, {
      now: NOW,
      // На тысячу лари больше, чем клиент когда-либо вносил. Учёт это видит:
      // притязание живого транша против того, что учёт должен его клиенту.
      declared: [
        { trancheId: TRANCHE, collected: money(GEL, DEAL_AMOUNT.minor + 100_000n) },
      ],
    });

    expect(resumption.kind).toBe('refused');
    if (resumption.kind !== 'refused') throw new Error('подъём обязан был отказать');
    expect(resumption.violations.map((item) => item.invariant)).toContain('collected_not_backed');
    // Мира нет вовсе: продолжить нечем, и это не исключение, а значение —
    // разобрать его обязан вызывающий.
    expect('world' in resumption).toBe(false);
  });

  it('не объявленное собранное — отказ, а не тихое «денег не собрано»', async () => {
    const store = memoryWorldStore();
    await reservedWorld(store);
    const restored = await restoreWorld(store, REQUEST);

    const resumption = resumeWorld(restored, { now: NOW, declared: [] });
    expect(resumption.kind).toBe('refused');
    if (resumption.kind !== 'refused') throw new Error('подъём обязан был отказать');
    /*
     * Молчание означало бы «собранного нет», а возврат тогда считался бы от
     * требуемой суммы (`flow.ts`, `collectedAmount ?? requiredAmount`) — то
     * есть у недоплаченного транша ушли бы чужие деньги.
     */
    expect(resumption.missing.map((part) => part.reasonKey)).toEqual([
      'tranche.collected_not_declared',
    ]);
  });

  it('часы нового процесса позади записанного — отказ с именем, а не мир', async () => {
    const store = memoryWorldStore();
    const saved = await reservedWorld(store);
    const restored = await restoreWorld(store, REQUEST);

    /*
     * Отставшие часы — дефект вызывающего, а не состояние базы: значением
     * возвращается то, что рассказала база, а часы рассказал он сам. Без этой
     * проверки мир собрался бы, а упал бы первый же шаг — отказом журнала
     * аудита о регрессии времени, из которого причину пришлось бы выводить.
     */
    expect(() =>
      resumeWorld(restored, {
        now: instant(saved.now - 1),
        declared: [{ trancheId: TRANCHE, collected: DEAL_AMOUNT }],
      }),
    ).toThrow(/app\.resume\.clock_behind_chain/);
  });

  it('объявление о неизвестном транше не пропускается молча', async () => {
    const store = memoryWorldStore();
    await reservedWorld(store);
    const restored = await restoreWorld(store, REQUEST);

    const resumption = resumeWorld(restored, {
      now: NOW,
      declared: [
        { trancheId: TRANCHE, collected: DEAL_AMOUNT },
        { trancheId: 'tranche-which-is-not-here', collected: DEAL_AMOUNT },
      ],
    });
    expect(resumption.kind).toBe('refused');
    if (resumption.kind !== 'refused') throw new Error('подъём обязан был отказать');
    expect(resumption.missing.map((part) => part.reasonKey)).toEqual([
      'tranche.declaration_unknown',
    ]);
  });
});

describe('перезапуск: поднятый мир беднее живого, а не богаче', () => {
  it('выплатить он не может: подписей, готовившего и реквизитов в схеме нет', async () => {
    const store = memoryWorldStore();
    const saved = await reservedWorld(store);
    const restored = await restoreWorld(store, REQUEST);
    const resumption = resumeWorld(restored, {
      now: saved.now,
      declared: [{ trancheId: TRANCHE, collected: DEAL_AMOUNT }],
    });
    if (resumption.kind !== 'resumed') throw new Error('подъём обязан был пройти');

    /*
     * Выход на расчёт закрыт **автоматом**, а не проверкой в подъёме: у
     * поднятого транша нет ни наблюдения, ни проверенных реквизитов, ни
     * снятого расхождения — и каждый из этих отказов назван поимённо.
     */
    const rejection = rejectTrancheEvent(resumption.world, TRANCHE, {
      type: 'condition_established',
      evidenceBundleId: `evidence-${TRANCHE}`,
      conditionType: 'registration_transfer',
    });
    expect([...rejection.failedGuards]).toContain('g_beneficiary_verified');

    // Подписей у поднятого мира нет, и взяться им неоткуда: аргумента под них
    // у подъёма не существует.
    expect(trancheOf(resumption.world, TRANCHE).approvalRecords).toEqual([]);
    expect(trancheOf(resumption.world, TRANCHE).facts.approvals).toEqual([]);
    // Следов «кто готовил» нет тоже: разделение обязанностей на выплате читает
    // их из мира, и кворум без них не набирается.
    expect(resumption.world.facts).toEqual([]);
    expect(resumption.world.sessions.size).toBe(0);
  });
});
