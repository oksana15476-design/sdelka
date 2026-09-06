import {
  type WithdrawalStepOptions,
  type WorldStore,
  restoreWorld,
  restoredViolations,
  resumeWorld,
  stepWorld,
  toClientKey,
  withdrawalStatusOf,
} from '@sdelka/app';
import { DbErrorCode, pgWorldStore } from '@sdelka/db';
import { RejectionCode, instant } from '@sdelka/domain';
import { freeBalance } from '@sdelka/ledger';
import { money } from '@sdelka/money';
import { expect, it } from 'vitest';
import { dbSuite } from '../../../db/test/int/support/pg';
import { applyWithdrawalEvent, requestWithdrawal } from '../support/acting';
import {
  BANK_RESPONSE_SOURCE,
  BUYER,
  GEL,
  POLICY_VERSION,
  STATEMENT_SOURCE,
  partyRef,
} from '../support/fixtures';
import {
  WITHDRAWAL_SCOPE,
  withdrawalPath,
  withdrawalStep,
} from '../support/store-path';
import { INT_CHAINS, assertNoForeignWorld, resetWithdrawals } from './support/reset';

/**
 * Заявка на вывод против **живого** Postgres: круг «шаг мира → база → подъём →
 * шаг мира» на той реализации порта, которая пойдёт в продукт, и под той ролью.
 *
 * **Что здесь закрывается.** До этого батча заявка в базу не попадала вовсе:
 * порт умел `saveWithdrawal`/`loadWithdrawals`, таблица и часы у неё были, а
 * пути записи не было — карта выводов лежала сбоку от мира, и дельта шага её не
 * видела. Проверялось это ровно так же, как проверяется любой инвариант, к
 * которому никто не обращается: никак.
 *
 * **Почему без сделки.** У вывода её нет: `sdelka.withdrawal` ссылается только
 * на сторону. Путь поэтому начинается зачислением на свободную часть счёта
 * клиента, а текст пути — общий с прогоном в памяти
 * (`../support/store-path.ts`, `withdrawalPath`): два текста сравнивали бы не
 * хранилища, а два сценария.
 *
 * **Роль — `sdelka_app`**, умолчание `pgWorldStore`: прогон под владельцем схемы
 * обошёл бы гранты, и «приложение заявок не удаляет» перестало бы проверяться.
 *
 * ⚠ **Повторный прогон.** Заявки снимаются перед первым шагом
 * (`./support/reset.ts`, `resetWithdrawals`, роль владельца, мимо хранилища):
 * набор ведёт свой мир от первого шага, а в базе после прошлого прогона лежит та
 * же заявка в терминальном состоянии. Журналы не снимаются и сниматься не могут
 * (красная линия №11), поэтому второй прогон встречает свои же строки и
 * опознаёт их повтором — отсюда форма утверждений ниже: `written + repeated`, а
 * не `written`.
 *
 * Отсюда же и ответ банка в последнем сценарии — **отказ**: снять заявку можно,
 * а журнал нельзя, и подтверждённый вывод во втором прогоне двигал бы деньги
 * второй раз. Разобрано там же, у сценария.
 */
const { run, title, pool } = await dbSuite('заявка на вывод против живого Postgres');

const SCOPE = Object.freeze({
  ...WITHDRAWAL_SCOPE,
  chainId: 'chain-int-withdrawal',
  withdrawalId: 'wd-int-1',
});
const SECOND = `${SCOPE.withdrawalId}-second`;
const CLIENT = toClientKey(BUYER.document);
const STEP: WithdrawalStepOptions = { policy: POLICY_VERSION, evidence: [STATEMENT_SOURCE] };
/** Ответ банка: у `settled` и `rejected` сырой источник обязателен по типу записи. */
const ANSWERED: WithdrawalStepOptions = { ...STEP, response: BANK_RESPONSE_SOURCE };

const REQUEST = {
  chainId: SCOPE.chainId,
  // Сделки у вывода нет вовсе — поднимать по ней нечего.
  deals: [],
  parties: [BUYER.partyId],
};

if (pool !== null) {
  await assertNoForeignWorld(pool, INT_CHAINS);
  await resetWithdrawals(pool, [SCOPE.withdrawalId, SECOND]);
}

function store(): WorldStore {
  if (pool === null) {
    // Недостижимо: при `pool === null` набор пропущен целиком. Броском, а не
    // `!`, потому что «недостижимо» обязано падать по имени.
    throw new Error('e2e.int.no_pool');
  }
  return pgWorldStore(pool);
}

run(title, () => {
  it('заявка доходит до банка через базу и поднимается из неё вместе с часами', async () => {
    const { world, log } = await withdrawalPath(store(), SCOPE);

    expect(withdrawalStatusOf({ world, clock: SCOPE.clock }, SCOPE.withdrawalId)).toBe(
      'paying_out',
    );
    // Деньги ещё на счёте клиента: они уходят на подтверждении банка, а не на
    // отправке поручения.
    expect(freeBalance(world.journal, CLIENT, GEL).minor).toBe(SCOPE.amount.minor);
    /*
     * Две подписи под заявкой в базе следа не оставляют вовсе: колонок под
     * подписи нет, и шаг, не оставивший следа, **называет** это, а не молчит.
     * Числа строк здесь не сверяются: журналы переживают прогон, и второй раз
     * те же строки приезжают повтором, а не записью.
     */
    const reasons = log.flatMap((item) => item.unmapped.map((part) => part.reasonKey));
    expect(reasons.filter((key) => key === 'withdrawal.facts_not_storable')).toHaveLength(2);

    const restored = await restoreWorld(store(), REQUEST);
    expect(restoredViolations(restored)).toEqual([]);
    const snapshot = restored.withdrawals.find(
      (item) => item.state.withdrawalId === SCOPE.withdrawalId,
    );
    const live = world.withdrawals.get(SCOPE.withdrawalId);
    /*
     * Состояние **вместе с часами**: срок операции и момент входа в состояние
     * прошли через `timestamptz` и вернулись тем же значением домена. Это и есть
     * то, ради чего заводилась `0022`: до неё колонок не было, а ограничение
     * `withdrawal_state_shape` не давало бы такой строке появиться вовсе.
     */
    expect(snapshot?.state).toEqual(live?.state);
    expect(snapshot?.party).toEqual(partyRef(BUYER));
    expect(snapshot?.amount).toEqual(SCOPE.amount);
    expect(snapshot?.sourceAccountFingerprint).toBe(live?.sourceAccount?.accountRef);
  });

  it('вторая незавершённая заявка того же клиента отказывает именем guard’а', async () => {
    const restored = await restoreWorld(store(), REQUEST);
    // Часы приносит новый процесс: времени в хранилище нет — оно не состояние.
    const resumption = resumeWorld(restored, { now: instant(Date.now()), declared: [] });
    if (resumption.kind !== 'resumed') {
      throw new Error(`подъём отказал: ${JSON.stringify(resumption.violations)}`);
    }

    /*
     * Правило «одна незавершённая заявка на сторону» держит частичный уникальный
     * индекс `withdrawal_one_active_per_party`, и второй проверки в коде у него
     * нет. Проверяется здесь не индекс, а **перевод**: наверх приезжает отказ
     * автомата с именем guard'а, а не безымянная ошибка драйвера.
     */
    await expect(
      stepWorld(
        store(),
        resumption.world,
        withdrawalStep(SCOPE.clock, (scene) =>
          requestWithdrawal(scene, {
            withdrawalId: SECOND,
            party: partyRef(BUYER),
            amount: money(GEL, 1_000n),
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: RejectionCode.guardFailed,
      message: 'g_no_active_withdrawal',
    });

    const after = await restoreWorld(store(), REQUEST);
    expect(after.withdrawals.map((item) => item.state.withdrawalId)).toEqual([
      SCOPE.withdrawalId,
    ]);
  });

  /**
   * ⚠ **Ответ банка здесь — отказ, и это выбор ради повторного прогона, а не
   * ради удобства.**
   *
   * Журнал учёта не снимается и сниматься не может (красная линия №11), а
   * заявка перед прогоном снимается — снять её больше нечем, номера у неё
   * естественные. Значит после подтверждённого вывода второй прогон встретил бы
   * заявку в `paying_out` и журнал, где деньги **уже ушли**, и повторный уход
   * той же суммы обязан был бы уронить инвариант отрицательного остатка. Он его
   * и роняет: `negative_client_balance` — проверено, а не предположено.
   *
   * Отказ банка проверяет ту же дорогу, ничего не двигая: заявка идёт
   * `paying_out → blocked → cancelled`, деньги остаются у клиента, а колонки
   * часов проходят оба состояния — нетерминальное и терминальное.
   *
   * Подтверждённый вывод (`settled`) с уходом денег со счёта проверяется на
   * реализации порта в памяти (`test/withdrawal-store.test.ts`), где каждый
   * сценарий берёт своё хранилище.
   */
  it('поднятый мир ведёт заявку дальше, а чужое состояние отказывает с именем', async () => {
    const restored = await restoreWorld(store(), REQUEST);
    const resumption = resumeWorld(restored, { now: instant(Date.now()), declared: [] });
    if (resumption.kind !== 'resumed') throw new Error('подъём отказал');

    const raised = resumption.world.withdrawals.get(SCOPE.withdrawalId);
    // Поднятая заявка беднее живой, и каждое «не знает» — отказ: готовившего
    // нет, подписей нет, совпадение владельца счёта с плательщиком не
    // подтверждено (красная линия №9).
    expect(raised?.preparerRef).toBeNull();
    expect(raised?.approvals).toEqual([]);
    expect(raised?.sourceAccount?.holderIsPayer).toBe(false);

    const answer = withdrawalStep(SCOPE.clock, (scene) =>
      applyWithdrawalEvent(
        scene,
        SCOPE.withdrawalId,
        { type: 'payout_result', outcome: 'rejected' },
        ANSWERED,
      ),
    );
    const refused = await stepWorld(store(), resumption.world, answer);
    expect(
      withdrawalStatusOf({ world: refused.world, clock: SCOPE.clock }, SCOPE.withdrawalId),
    ).toBe('blocked');
    // Банк отказал — деньги остались у клиента, ни одной проводки не появилось.
    expect(freeBalance(refused.world.journal, CLIENT, GEL).minor).toBe(SCOPE.amount.minor);

    // Повтор того же шага из того же мира: те же строки опознаны повтором.
    const again = await stepWorld(store(), resumption.world, answer);
    expect(again.outcome.written).toBe(0);
    expect(again.outcome.repeated).toBe(refused.outcome.written + refused.outcome.repeated);

    /*
     * Другой исход из того же мира: в памяти он проходит, а в базе лежит уже
     * `blocked`. Сверка «из чего уходим» стоит в `WHERE` целиком и превращает
     * потерю чужого шага в отказ с именем и обеими сторонами расхождения.
     */
    await expect(
      stepWorld(
        store(),
        resumption.world,
        withdrawalStep(SCOPE.clock, (scene) =>
          applyWithdrawalEvent(
            scene,
            SCOPE.withdrawalId,
            { type: 'payout_result', outcome: 'settled' },
            ANSWERED,
          ),
        ),
      ),
    ).rejects.toMatchObject({
      code: DbErrorCode.stepStateConflict,
      details: { relation: 'withdrawal', expected: 'paid_out', actual: 'blocked' },
    });

    // Заявка в удержании часы **несёт**: срок операции переставлен, момент входа
    // новый — состояние сменилось, а не повторилось внутренним переходом.
    const held = await restoreWorld(store(), REQUEST);
    const inHold = held.withdrawals.find(
      (item) => item.state.withdrawalId === SCOPE.withdrawalId,
    );
    expect(inHold?.state).toEqual(refused.world.withdrawals.get(SCOPE.withdrawalId)?.state);
    expect(inHold?.state).toHaveProperty('deadline');

    // Терминальная отмена: у закрытой заявки часов нет вовсе, обе колонки
    // пусты — иначе `withdrawal_state_shape` (`0022`) строку не принял бы.
    const cancelled = await stepWorld(
      store(),
      refused.world,
      withdrawalStep(SCOPE.clock, (scene) =>
        applyWithdrawalEvent(scene, SCOPE.withdrawalId, { type: 'withdrawal_cancelled' }, STEP),
      ),
    );
    const after = await restoreWorld(store(), REQUEST);
    const stored = after.withdrawals.find(
      (item) => item.state.withdrawalId === SCOPE.withdrawalId,
    );
    expect(stored?.state.status).toBe('cancelled');
    expect(stored?.state).not.toHaveProperty('deadline');
    expect(stored?.state).not.toHaveProperty('enteredAt');
    // Деньги так и не двинулись: отменённая заявка ничего у клиента не забрала.
    expect(freeBalance(cancelled.world.journal, CLIENT, GEL).minor).toBe(SCOPE.amount.minor);
    expect(restoredViolations(after)).toEqual([]);
  });
});
