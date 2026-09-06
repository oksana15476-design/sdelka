import { describe, expect, it } from 'vitest';
import {
  type BeneficiaryConfirmation,
  type Intent,
  type TrancheContext,
  type TrancheEvent,
  RejectionCode,
  beneficiaryConfirmation,
  participationKey,
  participationKeysEqual,
} from '../src/index';
import {
  AMOUNT,
  BUYER,
  DEAL_ID,
  PAYER_CLIENT_KEY,
  RECIPIENT,
  RECIPIENT_CLIENT_KEY,
  beneficiary,
  context,
} from './support/facts';
import { accept, reject, stateAt } from './support/drive';

/**
 * E13-2, вторая половина — `ROADMAP.md` И13.1: «реквизиты висят на **участии**,
 * а не на личности: подтверждение по одной сделке не переносится на другую».
 *
 * Почему это не косметика. Пока подтверждение было одним значением на транш
 * (`{ status, locked, lastChangedAt }`), сторона, один раз прошедшая тестовый
 * перевод, получала подтверждённый канал вывода **по любой будущей сделке**:
 * приложению достаточно было подать тот же факт другому траншу, и ни один guard
 * этого не видел. Комплаенс реквизитов был закрыт ровно наполовину — на той
 * половине, где различены `verified` и `name_consistent`, и открыт на той, где
 * различены участия.
 */

const CONDITION_ESTABLISHED: TrancheEvent = {
  type: 'condition_established',
  evidenceBundleId: 'evidence-1',
  conditionType: 'registration_transfer',
};

/** Другая сделка того же получателя — типовой случай, а не экзотика (§2.1). */
const OTHER_DEAL = 'deal-2';

/** Подтверждение по сделке А: то же лицо, тот же счёт, другое участие. */
const CONFIRMED_ELSEWHERE: BeneficiaryConfirmation = beneficiaryConfirmation({
  participation: participationKey(OTHER_DEAL, RECIPIENT, 'recipient'),
  status: 'verified',
  locked: true,
  lastChangedAt: null,
});

/** Контекст сделки Б с подтверждением, полученным по сделке А. */
function borrowedContext(): TrancheContext {
  return context({ beneficiary: CONFIRMED_ELSEWHERE });
}

function intentsOf(intents: readonly Intent[], type: Intent['type']): readonly Intent[] {
  return intents.filter((intent) => intent.type === type);
}

describe('подтверждение реквизитов принадлежит участию, а не лицу', () => {
  it('does not let a confirmation from another deal open the payout path', () => {
    const error = reject(stateAt('reserved'), CONDITION_ESTABLISHED, borrowedContext());
    expect(error.code).toBe(RejectionCode.guardFailed);
    // Оба guard'а реквизитов, а не один: подтверждения **этого** участия нет
    // вовсе, а не «есть, но недостаточное». Отказ тот же, что при пустом поле, —
    // и это правильно: подтверждения по этой сделке у стороны нет, сколько бы
    // их ни было по другим.
    expect([...error.failedGuards].sort()).toEqual([
      'g_beneficiary_locked',
      'g_beneficiary_verified',
    ]);
  });

  it('closes the release_blocked door on a confirmation from another deal too', () => {
    // Путь `collecting → release_blocked → release_pending → paying_out`
    // обходит guard'ы, стоящие только на одном входе (§1.4, §4). Проверка
    // участия обязана стоять на обеих дверях, как и остальные guard'ы
    // доказательств.
    const ctx = borrowedContext();
    const blocked = accept(
      stateAt('collecting'),
      {
        type: 'funds_received',
        amount: ctx.facts.requiredAmount,
        sender: 'not-the-buyer',
        reference: 'r',
      },
      ctx,
    );
    expect(blocked.state.status).toBe('release_blocked');
    const releasePending = accept(blocked.state, { type: 'approval_added', userId: 'op-2' }, ctx);
    const error = reject(releasePending.state, { type: 'release_authorized' }, ctx);
    expect([...error.failedGuards]).toContain('g_beneficiary_verified');
    expect([...error.failedGuards]).toContain('g_beneficiary_locked');
  });

  it('requires a fresh confirmation for the same person in a second deal', () => {
    // Второе участие того же лица — законный и типовой случай (человек продаёт
    // одну квартиру и получает деньги по двум сделкам). Разрешает его не
    // послабление, а **новое подтверждение по этому участию**: те же реквизиты,
    // но проверенные ещё раз и записанные под ключом этой сделки.
    const fresh = beneficiaryConfirmation({
      participation: participationKey(DEAL_ID, RECIPIENT, 'recipient'),
      status: 'verified',
      locked: true,
      lastChangedAt: null,
    });
    const moved = accept(
      stateAt('reserved'),
      CONDITION_ESTABLISHED,
      context({ beneficiary: fresh }),
    );
    expect(moved.state.status).toBe('release_pending');
  });

  it('does not treat the same person in another role as the same participation', () => {
    // Роль — часть ключа. Одно лицо бывает покупателем в одной сделке и
    // получателем в другой (§2.1), и склейка ролей вернула бы перенос
    // подтверждения через роль: «реквизиты плательщика» открывали бы выплату.
    const asBuyer = beneficiaryConfirmation({
      participation: participationKey(DEAL_ID, RECIPIENT, 'buyer'),
      status: 'verified',
      locked: true,
      lastChangedAt: null,
    });
    const error = reject(
      stateAt('reserved'),
      CONDITION_ESTABLISHED,
      context({ beneficiary: asBuyer }),
    );
    expect([...error.failedGuards].sort()).toEqual([
      'g_beneficiary_locked',
      'g_beneficiary_verified',
    ]);
  });

  it('does not accept a confirmation issued for another person in the same deal', () => {
    // Ключ участия — сделка **и** сторона. Подтверждение покупателя по этой же
    // сделке не открывает выплату получателю: иначе реквизиты можно было бы
    // подтвердить «за другого» внутри одной сделки.
    const otherParty = beneficiaryConfirmation({
      participation: participationKey(DEAL_ID, BUYER, 'recipient'),
      status: 'verified',
      locked: true,
      lastChangedAt: null,
    });
    const error = reject(
      stateAt('reserved'),
      CONDITION_ESTABLISHED,
      context({ beneficiary: otherParty }),
    );
    expect([...error.failedGuards].sort()).toEqual([
      'g_beneficiary_locked',
      'g_beneficiary_verified',
    ]);
  });

  it('treats a missing confirmation and an empty participation the same way — closed', () => {
    // Поднятый из снимка мир кладёт участие с пустой стороной: реквизитов у
    // него нет вовсе (`packages/app/src/resume.ts`). Две пустоты не совпадают —
    // «сверять не с чем» это отказ, а не равенство.
    const empty = beneficiaryConfirmation({
      participation: participationKey('', { partyId: '', accountKey: '' }, 'recipient'),
      status: 'verified',
      locked: true,
      lastChangedAt: null,
    });
    for (const confirmation of [null, empty]) {
      const error = reject(
        stateAt('reserved'),
        CONDITION_ESTABLISHED,
        context({ beneficiary: confirmation }),
      );
      expect([...error.failedGuards].sort()).toEqual([
        'g_beneficiary_locked',
        'g_beneficiary_verified',
      ]);
    }
  });
});

describe('блокировка реквизитов действует на участие, а не на лицо', () => {
  /**
   * Почему именно так, а не наоборот.
   *
   * **Блокировка (`locked`) — свойство участия.** Она наступает при
   * финансировании **сделки** (`CORE.md` Ф15): деньги внесены по этой сделке, и
   * запирается канал вывода по ней. Запирать заодно реквизиты по другой сделке
   * того же лица не за что — там ещё ничего не внесено, и запрет менять счёт
   * был бы наказанием без основания.
   *
   * **Отказ (`blocked` в статусе) переносится на лицо — но не этим кодом, а
   * тем, из чего он выводится.** Статус `blocked` означает расхождение имени
   * владельца счёта с профилем стороны либо отсутствие латинской формы
   * (`packages/compliance/src/beneficiary.ts`): это материал о **личности и
   * счёте**, а не о сделке, и `verifyBeneficiaryHolder`, вызванный для второго
   * участия с тем же профилем и тем же счётом, вернёт `blocked` снова. То есть
   * положительный вывод не переносится, а отрицательный воспроизводится сам —
   * безопасная сторона у обеих ошибок.
   *
   * Держать «чёрный список лиц» здесь, в фактах транша, было бы хуже:
   * подтверждений чужих участий домен не видит и видеть не должен, а список,
   * который приложение забыло наполнить, читался бы как «блокировок нет».
   */
  it('locks the payout channel of the funded deal only', () => {
    const lockedElsewhere = beneficiaryConfirmation({
      participation: participationKey(OTHER_DEAL, RECIPIENT, 'recipient'),
      status: 'verified',
      locked: true,
      lastChangedAt: null,
    });
    // По сделке Б заперто, по этой — нет: guard запертости отказывает.
    expect(
      reject(stateAt('reserved'), CONDITION_ESTABLISHED, context({ beneficiary: lockedElsewhere }))
        .failedGuards,
    ).toContain('g_beneficiary_locked');

    // А по своему участию — запирает, и это то же самое значение `locked`.
    const here = beneficiary({ locked: true });
    expect(
      accept(stateAt('reserved'), CONDITION_ESTABLISHED, context({ beneficiary: here })).state
        .status,
    ).toBe('release_pending');
  });

  it('keeps the blackout window attached to the participation as well', () => {
    // Изменение реквизитов внутри 72 часов запирает выплату **по этой сделке**
    // (`FUNCTIONAL.md` инвариант 18). Отметка изменения приезжает вместе с
    // подтверждением, то есть тоже принадлежит участию: смена счёта по сделке Б
    // не может ни запереть, ни разблокировать сделку А.
    const justChanged = beneficiary({ lastChangedAt: context().now });
    expect(
      reject(stateAt('reserved'), CONDITION_ESTABLISHED, context({ beneficiary: justChanged }))
        .failedGuards,
    ).toEqual(['g_beneficiary_locked']);
  });
});

describe('участие не открывает обхода красных линий', () => {
  it('keeps the refund on the payer account and does not look at the beneficiary at all', () => {
    // Красная линия №9: возврат только на счёт-источник, на имя плательщика.
    // Реквизиты выплаты к возврату отношения не имеют, и участие получателя
    // не должно давать к нему никакого доступа — ни разрешающего, ни
    // запрещающего. Подтверждения нет вовсе, возврат идёт.
    const ctx = context({ beneficiary: null });
    const refunding = accept(stateAt('refund_pending'), { type: 'refund_initiated' }, ctx);
    expect(refunding.state.status).toBe('refunding');
    const refunded = accept(
      refunding.state,
      { type: 'payout_result', outcome: 'settled' },
      ctx,
    );
    expect(refunded.state.status).toBe('refunded');

    const entries = intentsOf(refunded.intents, 'post_journal_entry');
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      if (entry.type !== 'post_journal_entry') continue;
      // Деньги двигаются со счёта плательщика и ничьего больше.
      expect(entry.clientKey).toBe(PAYER_CLIENT_KEY);
      expect(entry.clientKey).not.toBe(RECIPIENT_CLIENT_KEY);
    }
    // Расчётной записи на этом пути нет вовсе: возврат — не выплата.
    expect(intentsOf(refunded.intents, 'post_settlement_entry')).toEqual([]);
  });

  it('points the evidence reference at the confirmation of this very participation', () => {
    // Красная линия №5: выплата невозможна без ссылки на пакет доказательств, а
    // подтверждение реквизитов — часть этого пакета. Проверяется, что ссылка и
    // подтверждение говорят об одном участии: сделка и получатель в
    // подтверждении сторон (`attestation`) — те же, из которых guard'ы строят
    // ключ участия. Разъехаться им негде: обе половины берутся из контекста и
    // акта, а не из аргументов вызывающего.
    const paidOut = accept(
      stateAt('paying_out'),
      { type: 'payout_result', outcome: 'settled' },
      context(),
    );
    const settlement = paidOut.intents.find((intent) => intent.type === 'post_settlement_entry');
    if (settlement === undefined || settlement.type !== 'post_settlement_entry') {
      throw new Error('no settlement intent');
    }
    const confirmed = context().facts.beneficiary;
    if (confirmed === null) throw new Error('no confirmation');
    expect(settlement.attestation.evidenceRef).toBe('evidence-1');
    expect(settlement.attestation.dealId).toBe(confirmed.participation.dealId);
    expect(settlement.recipientClientKey).toBe(RECIPIENT_CLIENT_KEY);
    expect(confirmed.participation.partyId).toBe(RECIPIENT.partyId);
    expect(confirmed.participation.role).toBe('recipient');
    expect(settlement.amount).toEqual(AMOUNT);
  });

  it('never reaches the payout order with a borrowed confirmation', () => {
    // Обратная половина того же утверждения: с чужим подтверждением поручения
    // не возникает вовсе, то есть ссылки на доказательства «в никуда» не
    // бывает — транш стоит в `reserved`.
    const ctx = borrowedContext();
    reject(stateAt('reserved'), CONDITION_ESTABLISHED, ctx);
    const error = reject(stateAt('release_pending'), { type: 'release_authorized' }, ctx);
    expect(error.code).toBe(RejectionCode.guardFailed);
  });
});

describe('ключ участия', () => {
  it('separates deals, parties and roles', () => {
    const base = participationKey(DEAL_ID, RECIPIENT, 'recipient');
    expect(participationKeysEqual(base, participationKey(DEAL_ID, RECIPIENT, 'recipient'))).toBe(
      true,
    );
    expect(participationKeysEqual(base, participationKey(OTHER_DEAL, RECIPIENT, 'recipient'))).toBe(
      false,
    );
    expect(participationKeysEqual(base, participationKey(DEAL_ID, BUYER, 'recipient'))).toBe(false);
    expect(participationKeysEqual(base, participationKey(DEAL_ID, RECIPIENT, 'buyer'))).toBe(false);
  });

  it('cannot be re-stamped onto another participation — checked by the compiler', () => {
    // ⚠ Этот тест проверяет **компилятор**, а не поведение: `@ts-expect-error`
    // сам становится ошибкой, если строка ниже начнёт собираться. Именно она —
    // тот перенос, который И13.1 запрещает: взять готовое подтверждение по
    // сделке А и надеть на него ключ сделки Б.
    //
    // Форма номинальности — приватное поле класса (`beneficiary.ts`). Обычный
    // бренд ambient-символом здесь не годится: спред символ копирует, и подмена
    // одного поля проходит компиляцию.
    const source = beneficiary();
    // @ts-expect-error — подтверждение участия А не превращается в подтверждение участия Б
    const forged: BeneficiaryConfirmation = {
      ...source,
      participation: participationKey(OTHER_DEAL, RECIPIENT, 'recipient'),
    };
    // Значение всё-таки построено (в рантайме спред работает) — и именно оно
    // отвергается доменом: тип и поведение говорят одно и то же.
    expect(
      reject(
        stateAt('reserved'),
        CONDITION_ESTABLISHED,
        context({ beneficiary: forged as BeneficiaryConfirmation }),
      ).failedGuards,
    ).toContain('g_beneficiary_verified');
  });
});
