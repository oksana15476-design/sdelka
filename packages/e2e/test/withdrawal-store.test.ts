import {
  type WithdrawalStepOptions,
  restoreWorld,
  restoredViolations,
  resumeWorld,
  stepWorld,
  toClientKey,
  withdrawalStatusOf,
} from '@sdelka/app';
import { freeBalance } from '@sdelka/ledger';
import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import { applyWithdrawalEvent, requestWithdrawal } from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  BUYER,
  GEL,
  POLICY_VERSION,
  STATEMENT_SOURCE,
  THIRD_PARTY,
  partyRef,
} from './support/fixtures';
import { memoryWorldStore } from './support/memory-store';
import {
  WITHDRAWAL_SCOPE,
  fundedClient,
  withdrawalPath,
  withdrawalStep,
} from './support/store-path';

/**
 * Круг заявки на вывод: **шаг мира → база → подъём → шаг мира**.
 *
 * ## Что этот файл закрывает
 *
 * Заявка на вывод была единственной частью состояния, которая до базы не
 * доезжала вовсе. Порт умел её писать с батча 11 (`saveWithdrawal`,
 * `loadWithdrawals`), таблица и часы у неё были (`0005`, `0022`) — а пути записи
 * не было: `stepDelta` строит разницу **двух `World`**, а карта выводов лежала
 * сбоку от мира, в `WithdrawalWorld`. `store.ts` называл это прямо и называл
 * единственным местом всего подключения, где возможно молчание: заявка не
 * попадала ни в базу, ни в перечень непопавшего.
 *
 * Сегодня заявка — поле мира (`World.withdrawals`), и в базу она идёт тем же
 * способом, что транш: разницей двух запечатанных миров. Никакого «сохранить
 * заявку» мимо шага не появилось и появиться не может — `World` по-прежнему
 * выдают только `sealed`/`recorded`/`resumeWorld`.
 *
 * ## Чего этот файл не доказывает
 *
 * Что то же самое проходит в Postgres: хранилище здесь — реализация порта в
 * памяти. Тот же путь против живого кластера идёт в
 * `test/int/store-withdrawal.int.test.ts`, и текст пути у них **один**
 * (`support/store-path.ts`, `withdrawalPath`).
 */

const SCOPE = WITHDRAWAL_SCOPE;
const CLIENT = toClientKey(BUYER.document);
const STEP: WithdrawalStepOptions = { policy: POLICY_VERSION, evidence: [STATEMENT_SOURCE] };
const SETTLED: WithdrawalStepOptions = { ...STEP, response: BANK_RESPONSE_SOURCE };

/** Подъём заявок этого клиента. Стороны называются: перечисления у порта нет. */
const REQUEST = {
  chainId: SCOPE.chainId,
  // Сделки у вывода нет вовсе: он движение по счёту клиента, а не по сделке.
  deals: [],
  parties: [BUYER.partyId],
};

describe('заявка на вывод проходит через базу и поднимается из неё', () => {
  it('каждый шаг ложится в базу, а состояние и часы поднимаются тем же значением', async () => {
    const store = memoryWorldStore();
    const { world, log } = await withdrawalPath(store, SCOPE);

    expect(withdrawalStatusOf({ world, clock: SCOPE.clock }, SCOPE.withdrawalId)).toBe(
      'paying_out',
    );
    // Деньги ещё на счёте клиента: они уходят на подтверждении банка, а не на
    // отправке поручения.
    expect(freeBalance(world.journal, CLIENT, GEL).minor).toBe(SCOPE.amount.minor);
    expect(store.committed).toBe(log.length);

    /*
     * Две подписи состояния заявки не двигают, и в базе строк не оставляют:
     * колонок под подписи нет. Шаг, не оставивший следа, **называет** это —
     * ровно как шаг, изменивший только факты транша.
     */
    const reasons = log.flatMap((item) => item.unmapped.map((part) => part.reasonKey));
    expect(reasons.filter((key) => key === 'withdrawal.facts_not_storable')).toHaveLength(2);

    /* --- Новый процесс: о мире в памяти он не знает ничего --- */
    const restored = await restoreWorld(store, REQUEST);
    expect(restoredViolations(restored)).toEqual([]);
    expect(restored.withdrawals).toHaveLength(1);
    const snapshot = restored.withdrawals[0];
    const live = world.withdrawals.get(SCOPE.withdrawalId);
    // Автомат и **часы** — то же значение домена, а не похожее: срок операции и
    // момент входа в состояние поднялись оба (`0022`).
    expect(snapshot?.state).toEqual(live?.state);
    expect(snapshot?.party).toEqual(partyRef(BUYER));
    expect(snapshot?.amount).toEqual(SCOPE.amount);
    expect(snapshot?.sourceAccountFingerprint).toBe(live?.sourceAccount?.accountRef);
    // Перечисления заявок у порта нет: поднимаются выводы названных сторон.
    expect(restored.missing.map((part) => part.reasonKey)).toContain('port.no_listing');
  });

  it('поднятая заявка беднее живой, и каждое «не знает» — отказ, а не разрешение', async () => {
    const store = memoryWorldStore();
    const run = await withdrawalPath(store, SCOPE);
    const restored = await restoreWorld(store, REQUEST);
    const resumption = resumeWorld(restored, { now: run.world.now, declared: [] });
    if (resumption.kind !== 'resumed') {
      throw new Error(`подъём отказал: ${JSON.stringify(resumption.violations)}`);
    }

    const raised = resumption.world.withdrawals.get(SCOPE.withdrawalId);
    expect(raised?.state).toEqual(run.world.withdrawals.get(SCOPE.withdrawalId)?.state);
    // Готовивший неизвестен — кворум по такой заявке не набирается вовсе.
    expect(raised?.preparerRef).toBeNull();
    expect(raised?.preparedBy).toBeNull();
    // Подписей нет: `g_approvals_sufficient` не проходит.
    expect(raised?.approvals).toEqual([]);
    expect(raised?.approvalRecords).toEqual([]);
    /*
     * Отпечаток счёта-источника сохранён — он часть тождества строки, — а
     * половина «владелец счёта и есть плательщик» не сохранена и восстановлена
     * **закрыто**: `false`, то есть `g_source_account_known` не проходит и
     * утверждение уводит заявку к человеку (красная линия №9).
     */
    expect(raised?.sourceAccount?.accountRef).toBe(
      run.world.withdrawals.get(SCOPE.withdrawalId)?.sourceAccount?.accountRef,
    );
    expect(raised?.sourceAccount?.holderIsPayer).toBe(false);
    // Кто увёл в удержание и была ли заявка показана дежурному — не знает.
    expect(raised?.blockedBy).toBeNull();
    expect(raised?.stall).toBeNull();

    /*
     * И это не украшение значения, а поведение: заявка, доведённая до
     * удержания, **не может быть утверждена заново** поднятым миром. Отказ
     * приходит раньше и автомата, и кворума — на разрешении: разделение
     * обязанностей читает факт «кто готовил» и получает **неизвестно**
     * (`auth.sod.context_unknown`), а неизвестное не проходит. Подписи,
     * собранные до перезапуска, придётся собирать заново
     * (`DECISIONS-REVIEW.md` §L3).
     */
    const held = applyWithdrawalEvent(
      { world: resumption.world, clock: SCOPE.clock },
      SCOPE.withdrawalId,
      { type: 'payout_result', outcome: 'rejected' },
      SETTLED,
    );
    expect(withdrawalStatusOf(held, SCOPE.withdrawalId)).toBe('blocked');
    expect(() =>
      applyWithdrawalEvent(held, SCOPE.withdrawalId, { type: 'withdrawal_approved' }, STEP),
    ).toThrow('e2e.withdrawal.denied:approve_payout:auth.sod.context_unknown');

    const gaps = resumption.gaps.map((part) => part.subject);
    expect(gaps).toContain('withdrawal.preparer');
    expect(gaps).toContain('withdrawal.approvals');
    expect(gaps).toContain('withdrawal.holder_is_payer');
    expect(gaps).toContain('withdrawal.blocked_by');
    expect(gaps).toContain('withdrawal.stall_mark');
  });

  it('поднятый мир доводит поручение до конца, и деньги уходят со счёта клиента', async () => {
    const store = memoryWorldStore();
    const run = await withdrawalPath(store, SCOPE);
    const restored = await restoreWorld(store, REQUEST);
    const resumption = resumeWorld(restored, { now: run.world.now, declared: [] });
    if (resumption.kind !== 'resumed') throw new Error('подъём отказал');

    /*
     * Ответ банка приходит уже новому процессу. Ни подписей, ни готовившего у
     * поднятой заявки нет — и не нужно: на ребре `paying_out --payout_result-->
     * paid_out` guard'ов нет вовсе, потому что решение принял банк, а не мы.
     */
    const finished = await stepWorld(
      store,
      resumption.world,
      withdrawalStep(SCOPE.clock, (scene) =>
        applyWithdrawalEvent(scene, SCOPE.withdrawalId, {
          type: 'payout_result',
          outcome: 'settled',
        }, SETTLED),
      ),
    );

    expect(withdrawalStatusOf({ world: finished.world, clock: SCOPE.clock }, SCOPE.withdrawalId))
      .toBe('paid_out');
    // Деньги ушли со свободной части счёта клиента ровно один раз.
    expect(freeBalance(finished.world.journal, CLIENT, GEL).minor).toBe(0n);

    const after = await restoreWorld(store, REQUEST);
    const stored = after.withdrawals[0];
    expect(stored?.state.status).toBe('paid_out');
    // У терминальной заявки часов нет вовсе — ни срока, ни возраста (`0022`).
    expect(stored?.state).not.toHaveProperty('deadline');
    expect(restoredViolations(after)).toEqual([]);
  });

  it('повтор того же шага опознаётся повтором, а чужое состояние — отказом с именем', async () => {
    const store = memoryWorldStore();
    const run = await withdrawalPath(store, SCOPE);

    const answer = withdrawalStep(SCOPE.clock, (scene) =>
      applyWithdrawalEvent(scene, SCOPE.withdrawalId, {
        type: 'payout_result',
        outcome: 'settled',
      }, SETTLED),
    );

    const first = await stepWorld(store, run.world, answer);
    expect(first.outcome.written).toBeGreaterThan(0);
    expect(first.outcome.repeated).toBe(0);

    // Тот же шаг из того же мира: идентификаторы записей и хеши детерминированы,
    // поэтому база видит **то же самое**, а не второе.
    const again = await stepWorld(store, run.world, answer);
    expect(again.outcome.written).toBe(0);
    expect(again.outcome.repeated).toBe(first.outcome.written);

    /*
     * Другой исход из того же мира: в памяти он проходит, а в базе лежит уже
     * `paid_out`. Слепая перезапись потеряла бы чужой шаг молча; сверка «из чего
     * уходим» превращает это в отказ с именем и с обеими сторонами расхождения.
     */
    await expect(
      stepWorld(
        store,
        run.world,
        withdrawalStep(SCOPE.clock, (scene) =>
          applyWithdrawalEvent(scene, SCOPE.withdrawalId, {
            type: 'payout_result',
            outcome: 'rejected',
          }, SETTLED),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'db.step.state_conflict',
      details: { relation: 'withdrawal', expected: 'blocked', actual: 'paid_out' },
    });
  });

  it('вторая незавершённая заявка того же клиента отказывает правилом, а не индексом', async () => {
    const store = memoryWorldStore();
    const run = await withdrawalPath(store, SCOPE);

    /*
     * Правило «одна незавершённая заявка на сторону» держит частичный уникальный
     * индекс базы, и второй проверки в коде у него нет. Проверяется здесь не
     * наличие индекса, а то, что его отказ **доезжает как правило**: имя guard'а
     * домена, а не имя ограничения схемы.
     *
     * ⚠ Заодно видно расхождение двух прочтений слова «активная»:
     * `g_no_active_withdrawal` домена считает активными только заявки в
     * `paying_out`, индекс — все нетерминальные. Здесь первая заявка как раз в
     * `paying_out`, то есть отказали бы оба; расхождение названо в
     * `DECISIONS-REVIEW.md` §L и закрывается решением владельца, а не здесь.
     */
    await expect(
      stepWorld(
        store,
        run.world,
        withdrawalStep(SCOPE.clock, (scene) =>
          requestWithdrawal(scene, {
            withdrawalId: `${SCOPE.withdrawalId}-second`,
            party: partyRef(BUYER),
            amount: money(GEL, 1_000n),
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'domain.guard.failed',
      message: 'g_no_active_withdrawal',
    });

    // В базе осталась одна заявка, а не полторы.
    const restored = await restoreWorld(store, REQUEST);
    expect(restored.withdrawals.map((item) => item.state.withdrawalId)).toEqual([
      SCOPE.withdrawalId,
    ]);
  });

  it('заявка с неизвестным счётом-источником в базу не ложится и названа вслух', async () => {
    const store = memoryWorldStore();
    const funded = await fundedClient(store, SCOPE);

    const requested = await stepWorld(
      store,
      funded.world,
      withdrawalStep(SCOPE.clock, (scene) =>
        requestWithdrawal(scene, {
          withdrawalId: 'wd-store-no-source',
          party: partyRef(BUYER),
          amount: SCOPE.amount,
          // Счёт-источник неизвестен: у схемы `source_account_fingerprint NOT
          // NULL` (красная линия №9), и подставить туда нечего.
          sourceAccount: null,
        }),
      ),
    );

    expect(requested.unmapped.map((part) => part.reasonKey)).toContain(
      'withdrawal.source_account_unknown',
    );
    // Заявка в мире есть, в базе её нет — и это сказано значением, а не молчанием.
    expect(requested.world.withdrawals.has('wd-store-no-source')).toBe(true);
    const restored = await restoreWorld(store, REQUEST);
    expect(restored.withdrawals).toEqual([]);
  });

  it('заявка чужого клиента поднимается только тогда, когда его назвали', async () => {
    const store = memoryWorldStore();
    await withdrawalPath(store, SCOPE);
    const other = await restoreWorld(store, {
      chainId: SCOPE.chainId,
      deals: [],
      parties: [THIRD_PARTY.partyId],
    });
    // Чужих заявок подъём не приносит: охват — названные стороны, и только они.
    expect(other.withdrawals).toEqual([]);
  });
});
