import { describe, expect, it } from 'vitest';
import {
  MINT_SCHEMES,
  auditMinted,
  verifyChain,
} from '@sdelka/audit';
import {
  PAYOUT_NAMESPACE,
  REFUND_NAMESPACE,
  WITHDRAWAL_NAMESPACE,
  payoutIdempotencyKey,
  refundIdempotencyKey,
  withdrawalIdempotencyKey,
} from '@sdelka/domain';
import { money } from '@sdelka/money';
import {
  type World,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
  withWithdrawals,
  withdrawalStatusOf,
} from '@sdelka/app';
import type { WithdrawalStepOptions } from '@sdelka/app';
import { STAFF } from './support/actors';
import {
  applyTrancheEvent,
  applyWithdrawalEvent,
  approveWithdrawal,
  receiveExternalPayment,
  requestWithdrawal,
} from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  BUYER,
  GEL,
  POLICY_VERSION,
  STATEMENT_SOURCE,
  WITHDRAWAL_CLOCK,
  partyRef,
} from './support/fixtures';
import { toCollected, toPayingOut } from './support/paths';

/**
 * Ключ идемпотентности и вечный журнал — сквозная проверка.
 *
 * ## Что здесь закрывается
 *
 * Ключ выплаты — UUID версии 5. У примерно каждого тридцать второго ключа
 * девять цифр последней группы идут подряд, и правило `digit_run`
 * (`audit/src/values.ts`) считало такое значение сырым идентификатором
 * человека. Запись `payout_ordered` не собиралась, поручение в вечный журнал не
 * попадало — при том, что деньги уходили. Замер: 200 000 ключей, 3,1 %
 * попаданий [установлено].
 *
 * Правило не ослаблено: собственный ключ **доказывается пересчётом** из схемы и
 * входа (`audit/src/minted.ts`). Ниже — оба следствия этого решения:
 *
 * 1. **Сверка двух реализаций.** Пакет аудита не берёт зависимостей и держит
 *    своё зеркало пространств имён. Расходиться зеркалу нечем только пока его
 *    сверяют; сверка — здесь, потому что только `@sdelka/e2e` видит оба пакета.
 * 2. **Настоящий прогон.** Тест на самом правиле доказывает правило, а не
 *    продукт: приложение может забыть предъявить заявку. Поэтому транши и
 *    заявка на вывод ниже названы **именами, которые гарантированно дают девять
 *    цифр подряд**, и путь проходится целиком.
 */

const ANSWERED = trancheOptions(POLICY_VERSION, { payoutResponse: BANK_RESPONSE_SOURCE });
const PLAIN = trancheOptions(POLICY_VERSION);

const STEP: WithdrawalStepOptions = { policy: POLICY_VERSION, evidence: [STATEMENT_SOURCE] };
const SETTLED: WithdrawalStepOptions = { ...STEP, response: BANK_RESPONSE_SOURCE };

const DIGIT_RUN = /\d{9,}/u;

/**
 * Имена подобраны перебором и закреплены — не выбраны наугад.
 *
 * `tranche-digit-run-N`: первое N, дающее девять цифр подряд в ключе расчёта, —
 * 12. `tranche-refund-run-N` для ключа возврата — 146. `withdrawal-run-N` для
 * ключа вывода — 30. Каждое утверждается ниже прямо в тесте: без этого подмена
 * имени превратила бы сквозной прогон в проверку счастливого пути.
 */
const TRANCHE_RELEASE_RUN = 'tranche-digit-run-12';
const TRANCHE_REFUND_RUN = 'tranche-refund-run-146';
const WITHDRAWAL_RUN = 'withdrawal-run-30';

/** Своя часть клиента, не обещанная сделке. */
const SPARE = money(GEL, 10_000_000n);
const PART = money(GEL, 5_000_000n);

function orderedKeys(world: World): readonly string[] {
  return world.chain.records
    .filter((record) => record.body.kind === 'payout_ordered')
    .map((record) => record.subject.id);
}

describe('зеркало схем чеканки не разошлось с доменом', () => {
  it('пространства имён совпадают до знака', () => {
    expect(MINT_SCHEMES.payout_idempotency).toBe(PAYOUT_NAMESPACE);
    expect(MINT_SCHEMES.refund_idempotency).toBe(REFUND_NAMESPACE);
    expect(MINT_SCHEMES.withdrawal_idempotency).toBe(WITHDRAWAL_NAMESPACE);
  });

  it('обе реализации UUID5 дают один и тот же ключ на общих входах', () => {
    // Пакет аудита считает UUID5 по шестнадцатеричной записи, домен — по
    // байтам. Разойтись им негде только пока это проверяют.
    for (let index = 0; index < 200; index += 1) {
      const tranche = `tranche-mirror-${index}`;
      expect(auditMinted('payout_idempotency', tranche).value).toBe(payoutIdempotencyKey(tranche));
      expect(auditMinted('refund_idempotency', tranche).value).toBe(refundIdempotencyKey(tranche));
      const withdrawal = `withdrawal-mirror-${index}`;
      expect(auditMinted('withdrawal_idempotency', withdrawal).value).toBe(
        withdrawalIdempotencyKey(withdrawal),
      );
    }
  });

  it('подобранные имена действительно дают девять цифр подряд', () => {
    expect(DIGIT_RUN.test(payoutIdempotencyKey(TRANCHE_RELEASE_RUN))).toBe(true);
    expect(DIGIT_RUN.test(refundIdempotencyKey(TRANCHE_REFUND_RUN))).toBe(true);
    expect(DIGIT_RUN.test(withdrawalIdempotencyKey(WITHDRAWAL_RUN))).toBe(true);
  });
});

describe('выплата с таким ключом попадает в вечный журнал', () => {
  it('расчёт получателю: поручение и исход записаны', async () => {
    // До правки этот прогон падал на `audit.value.raw_identifier` ещё на входе
    // в `paying_out` — то есть деньги уходили, а поручения в журнале не было.
    const path = await toPayingOut({
      dealId: 'deal-digit-run',
      trancheId: TRANCHE_RELEASE_RUN,
    });
    let world = path.world;
    expect(trancheStatusOf(world, TRANCHE_RELEASE_RUN)).toBe('paying_out');
    expect(orderedKeys(world)).toEqual([payoutIdempotencyKey(TRANCHE_RELEASE_RUN)]);

    world = applyTrancheEvent(
      world,
      TRANCHE_RELEASE_RUN,
      { type: 'payout_result', outcome: 'settled' },
      ANSWERED,
    ).world;
    expect(trancheStatusOf(world, TRANCHE_RELEASE_RUN)).toBe('paid_out');

    const results = world.chain.records.filter((record) => record.body.kind === 'payout_result');
    expect(results.map((record) => record.subject.id)).toEqual([
      payoutIdempotencyKey(TRANCHE_RELEASE_RUN),
    ]);
    expect(verifyChain(world.chain).intact).toBe(true);
  });

  it('возврат покупателю: своя схема, свой ключ, своя запись', async () => {
    const path = await toPayingOut({
      dealId: 'deal-refund-run',
      trancheId: TRANCHE_REFUND_RUN,
    });
    let world = path.world;
    world = applyTrancheEvent(
      world,
      TRANCHE_REFUND_RUN,
      { type: 'payout_result', outcome: 'rejected' },
      ANSWERED,
    ).world;
    world = applyTrancheEvent(
      world,
      TRANCHE_REFUND_RUN,
      { type: 'refund_requested', reason: 'bank.rejected_payout' },
      PLAIN,
    ).world;
    world = applyTrancheEvent(world, TRANCHE_REFUND_RUN, { type: 'refund_initiated' }, PLAIN).world;
    expect(trancheStatusOf(world, TRANCHE_REFUND_RUN)).toBe('refunding');
    expect(trancheOf(world, TRANCHE_REFUND_RUN).payouts.at(-1)?.idempotencyKey).toBe(
      refundIdempotencyKey(TRANCHE_REFUND_RUN),
    );

    // Исход возврата адресован ключу возврата: схема выбирается ногой
    // поручения, и подставить чужую нельзя — пересчёт не сойдётся.
    world = applyTrancheEvent(
      world,
      TRANCHE_REFUND_RUN,
      { type: 'payout_result', outcome: 'settled' },
      ANSWERED,
    ).world;
    expect(trancheStatusOf(world, TRANCHE_REFUND_RUN)).toBe('refunded');
    const results = world.chain.records.filter((record) => record.body.kind === 'payout_result');
    expect(results.map((record) => record.subject.id)).toEqual([
      payoutIdempotencyKey(TRANCHE_REFUND_RUN),
      refundIdempotencyKey(TRANCHE_REFUND_RUN),
    ]);
    expect(verifyChain(world.chain).intact).toBe(true);
  });

  it('вывод со счёта клиента: тот же ключ, та же беда, та же починка', async () => {
    const collected = await toCollected({
      dealId: 'deal-wd-run',
      trancheId: 'tranche-wd-run',
    });
    const funded = receiveExternalPayment(collected.world, collected.buyerKey, SPARE);
    let scene = withWithdrawals(funded, WITHDRAWAL_CLOCK);
    scene = requestWithdrawal(scene, {
      withdrawalId: WITHDRAWAL_RUN,
      party: partyRef(BUYER),
      amount: PART,
    });
    scene = approveWithdrawal(scene, WITHDRAWAL_RUN, STAFF.controller);
    scene = approveWithdrawal(scene, WITHDRAWAL_RUN, STAFF.head);
    scene = applyWithdrawalEvent(scene, WITHDRAWAL_RUN, { type: 'withdrawal_approved' }, STEP);
    scene = applyWithdrawalEvent(scene, WITHDRAWAL_RUN, { type: 'withdrawal_dispatched' }, STEP);
    expect(withdrawalStatusOf(scene, WITHDRAWAL_RUN)).toBe('paying_out');
    expect(orderedKeys(scene.world)).toEqual([withdrawalIdempotencyKey(WITHDRAWAL_RUN)]);

    scene = applyWithdrawalEvent(
      scene,
      WITHDRAWAL_RUN,
      { type: 'payout_result', outcome: 'settled' },
      SETTLED,
    );
    expect(withdrawalStatusOf(scene, WITHDRAWAL_RUN)).toBe('paid_out');
    expect(verifyChain(scene.world.chain).intact).toBe(true);
  });
});

describe('транш без попадания под правило проходит ровно как раньше', () => {
  it('обычное имя транша ничего не меняет', async () => {
    // Контрольный прогон: правка касается только тех значений, которые под
    // правило подпадали. Остальные идут прежней дорогой.
    const path = await toPayingOut({ dealId: 'deal-no-run', trancheId: 'tranche-no-run' });
    expect(DIGIT_RUN.test(payoutIdempotencyKey('tranche-no-run'))).toBe(false);
    expect(trancheStatusOf(path.world, 'tranche-no-run')).toBe('paying_out');
    expect(orderedKeys(path.world)).toEqual([payoutIdempotencyKey('tranche-no-run')]);
    expect(verifyChain(path.world.chain).intact).toBe(true);
  });
});

describe('журнал остаётся закрыт для сырых идентификаторов', () => {
  it('ключ, который чеканит продукт, — это ровно то, что доказывает журнал', () => {
    // Утверждение о границе: доказывается **значение**, а не поле и не форма.
    // Проверки самого правила — в `@sdelka/audit` (`minted.test.ts`), здесь
    // сверяется, что доказываемое совпадает с тем, что уходит в банк.
    const minted = auditMinted('payout_idempotency', TRANCHE_RELEASE_RUN);
    expect(minted.value).toBe(payoutIdempotencyKey(TRANCHE_RELEASE_RUN));
    expect(minted.source).toBe(TRANCHE_RELEASE_RUN);
    expect(minted.value).not.toBe(TRANCHE_RELEASE_RUN);
  });
});
