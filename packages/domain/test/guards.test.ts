import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type GuardId,
  type TrancheEvent,
  BENEFICIARY_PRE_RELEASE_BLACKOUT_MS,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_OBSERVATION_POLICY,
  GUARD_IDS,
  OWNER_CHECKS,
  RELEASE_CONDITIONS,
  evaluateGuard,
  instant,
} from '../src/index';
import {
  AMOUNT,
  BUYER,
  BUYER_PARTY_ID,
  CONDITION_ACT,
  MATCHING_STATEMENT,
  NOW,
  RECIPIENT_PARTY_ID,
  facts,
  observation,
} from './support/facts';

const fundsReceived: TrancheEvent = {
  type: 'funds_received',
  amount: AMOUNT,
  sender: 'buyer-1',
  reference: 'ref-1',
};

function check(
  guard: GuardId,
  overrides: Parameters<typeof facts>[0],
  event: TrancheEvent = fundsReceived,
  now = NOW,
): boolean {
  return evaluateGuard(guard, { facts: facts(overrides), event, now });
}

describe('каждый guard проходит и не проходит', () => {
  it('covers every guard declared by the document', () => {
    // 12 реализованных из §1.3 плюс два по CORE.md Ф13 (акт получателя на входе
    // в приём средств и приём новой редакции обеими сторонами), плюс два,
    // введённых этим батчем: `g_beneficiary_verified` (E13-2, И13.1 —
    // доказательство владения счётом отдельно от блокировки реквизитов) и
    // `g_unfreeze_approvers_distinct` (E9-9, Ф17 — разморозку утверждают двое).
    // В таблице §1.3 строк четырнадцать: `g_seller_is_owner` (сверка
    // собственника на заведении сделки) и `g_no_stale_break` (незакрытые
    // расхождения сверки) не реализованы — они относятся к заведению сделки и к
    // сверке, эпики E4 и E7.
    //
    // Семнадцатый — `g_funds_collected`: под траншем есть собранные средства.
    // В §1.3 его нет, потому что документ считает его само собой разумеющимся,
    // а путь через `release_blocked` в `collected` не заходит вовсе — и транш
    // без единого лари за ним доходил до `paid_out`, не оставляя в учёте даже
    // записи.
    //
    // Восемнадцатый — `g_funds_locked`: средства **заперты под этим траншем**.
    // Отдельно от собранных, потому что после переноса запирания на вход в
    // `reserved` эти два ответа разошлись: путь `collected → refund_pending →
    // refunding → release_blocked → release_pending → paying_out` в `reserved`
    // не заходит, деньги остаются в свободной части счёта покупателя, а расчёт
    // дебетует пустой файл транша — то есть берёт деньги других сделок.
    //
    // Девятнадцатый — `g_write_off_covers_collected`: списание закрывает ровно
    // то обязательство, которое дебетует. Отдельно от `g_funds_locked`, потому
    // что у списания два законных пустых файла и различать их обязано правило,
    // а не вызывающий: «денег под траншем не было вовсе» — закрывать нечего, а
    // «деньги есть, но в свободной части счёта» — закрывать нельзя.
    //
    // Двадцатый — `g_observation_sufficient` (E3-1, `ORACLE.md` §6.4): годен ли
    // сам документ, на который опирается расчёт. Это не счётчик подрос, а
    // появилось правило, которого не было: `STATE-MACHINES.md` §8 требовал
    // «платная выписка, L3+», а уровня доверия в коде не существовало вовсе.
    // Пять полей выписки и вердикт по собственнику лежали в фактах транша
    // порознь и **без документа** — собрать факты с пятью `true`, не имея ни
    // одной выписки, было законной конструкцией типа, и фикстура интерфейса
    // ровно это и делала. Отдельный guard, а не расширение `g_fields_match`:
    // «документ годен» и «содержимое сошлось» — два утверждения, и §7 требует,
    // чтобы каждое проверялось поимённо.
    expect(GUARD_IDS).toHaveLength(20);
    expect(GUARD_IDS).toContain('g_observation_sufficient');
    expect(GUARD_IDS).not.toContain('g_seller_is_owner');
    expect(GUARD_IDS).not.toContain('g_no_stale_break');
    expect(GUARD_IDS).toContain('g_condition_agreed');
    expect(GUARD_IDS).toContain('g_amendment_accepted_by_both');
    expect(GUARD_IDS).toContain('g_beneficiary_verified');
    expect(GUARD_IDS).toContain('g_unfreeze_approvers_distinct');
    expect(GUARD_IDS).toContain('g_funds_collected');
    expect(GUARD_IDS).toContain('g_funds_locked');
    expect(GUARD_IDS).toContain('g_write_off_covers_collected');
  });

  it('g_funds_locked', () => {
    expect(check('g_funds_locked', {})).toBe(true);
    // Деньги собраны, но под траншем не заперты: путь мимо `reserved`.
    expect(check('g_funds_locked', { lockedAmount: null })).toBe(false);
    expect(check('g_funds_locked', { lockedAmount: money('GEL', 0n) })).toBe(false);
    // Частично запертый файл — не «мало», а расхождение: расчёт увёл бы
    // остаток клиентского счёта в минус на разницу.
    expect(
      check('g_funds_locked', { lockedAmount: money('GEL', AMOUNT.minor - 1n) }),
    ).toBe(false);
    // Больше запертого, чем собрано, — законно: остаток остаётся в файле.
    expect(
      check('g_funds_locked', { lockedAmount: money('GEL', AMOUNT.minor + 1n) }),
    ).toBe(true);
    // Другая валюта — «не те деньги», как и у собранных.
    expect(check('g_funds_locked', { lockedAmount: money('USD', AMOUNT.minor) })).toBe(false);
    // Собранного нет вовсе — сравнивать не с чем, отказ закрытый.
    expect(check('g_funds_locked', { collectedAmount: null })).toBe(false);
  });

  it('g_write_off_covers_collected', () => {
    // Файл транша полон: закрывается ровно то, что дебетуется.
    expect(check('g_write_off_covers_collected', {})).toBe(true);
    // Собирать было нечего — закрывать нечего, списание проходит и не
    // утверждает о деньгах ничего. Это транш, куда деньги не дошли вовсе.
    expect(check('g_write_off_covers_collected', { collectedAmount: null, lockedAmount: null })).toBe(
      true,
    );
    expect(
      check('g_write_off_covers_collected', {
        collectedAmount: money('GEL', 0n),
        lockedAmount: money('GEL', 0n),
      }),
    ).toBe(true);
    // Собрано, но лежит в свободной части счёта клиента: списание закрыло бы
    // транш, не тронув обязательства. Это и есть дефект «бесследного списания».
    expect(check('g_write_off_covers_collected', { lockedAmount: money('GEL', 0n) })).toBe(false);
    expect(check('g_write_off_covers_collected', { lockedAmount: null })).toBe(false);
    // Заперта только часть — расхождение, а не «мало».
    expect(
      check('g_write_off_covers_collected', { lockedAmount: money('GEL', AMOUNT.minor - 1n) }),
    ).toBe(false);
    // Другая валюта — не те деньги, как и у соседних двух guard'ов.
    expect(
      check('g_write_off_covers_collected', { lockedAmount: money('USD', AMOUNT.minor) }),
    ).toBe(false);
  });

  it('g_funds_collected', () => {
    expect(check('g_funds_collected', {})).toBe(true);
    // Денег под траншем нет вовсе — путь через `release_blocked`.
    expect(check('g_funds_collected', { collectedAmount: null })).toBe(false);
    // Ноль — это не «собрано»: проводки на ноль журнал не принимает, и расчёту
    // нечего двигать.
    expect(check('g_funds_collected', { collectedAmount: money('GEL', 0n) })).toBe(false);
    // Другая валюта — не «мало», а «не те деньги»: отказ закрытый.
    expect(check('g_funds_collected', { collectedAmount: money('USD', 9_999_999n) })).toBe(false);
  });

  it('g_condition_agreed', () => {
    expect(check('g_condition_agreed', {})).toBe(true);
    // Акта нет — приём средств не открывается (Ф13).
    expect(check('g_condition_agreed', { conditionAct: null })).toBe(false);
    // Тип из перечня, но помеченный в §8 как [открыто], основанием не является.
    expect(
      check('g_condition_agreed', {
        conditionAct: { ...CONDITION_ACT, conditionType: 'registration_preliminary' },
      }),
    ).toBe(false);
    // Акт без получателя и без редакции текста — не акт. Получатель проверяется
    // обеими половинами: акт, назвавший сторону без счёта, — это акт, из
    // которого получателя расчёта не восстановить, а расчёт собирается из него.
    expect(
      check('g_condition_agreed', {
        conditionAct: { ...CONDITION_ACT, recipient: { partyId: '', accountKey: 'ge.x' } },
      }),
    ).toBe(false);
    expect(
      check('g_condition_agreed', {
        conditionAct: {
          ...CONDITION_ACT,
          recipient: { partyId: RECIPIENT_PARTY_ID, accountKey: '' },
        },
      }),
    ).toBe(false);
    expect(
      check('g_condition_agreed', { conditionAct: { ...CONDITION_ACT, conditionTextVersion: '' } }),
    ).toBe(false);
    // Получатель, назначивший условие сам себе, будучи покупателем: одно лицо
    // по обе стороны сделки (§2.1) и условие, зависящее от воли одной стороны
    // (красная линия №6). Отказ **до денег**, а не при расчёте: раньше эта
    // сверка стояла только на изменении условия, то есть завести таким его
    // изначально было можно.
    expect(check('g_condition_agreed', { conditionAct: { ...CONDITION_ACT, recipient: BUYER } }))
      .toBe(false);
    expect(
      check('g_condition_agreed', {
        conditionAct: {
          ...CONDITION_ACT,
          recipient: { partyId: RECIPIENT_PARTY_ID, accountKey: BUYER.accountKey },
        },
      }),
    ).toBe(false);
    // Акт, датированный будущим, не принимается.
    expect(
      check('g_condition_agreed', {
        conditionAct: { ...CONDITION_ACT, agreedAt: instant(NOW + 1) },
      }),
    ).toBe(false);
  });

  it('g_amendment_accepted_by_both', () => {
    const amended: TrancheEvent = {
      type: 'condition_act_amended',
      act: { ...CONDITION_ACT, conditionTextVersion: 'condition.registration_transfer.v2' },
      acceptedBy: [BUYER_PARTY_ID, RECIPIENT_PARTY_ID],
    };
    expect(check('g_amendment_accepted_by_both', {}, amended)).toBe(true);
    // Одна сторона — это не «обе»: условие переопределялось бы односторонне.
    expect(
      check('g_amendment_accepted_by_both', {}, { ...amended, acceptedBy: [RECIPIENT_PARTY_ID] }),
    ).toBe(false);
    expect(
      check(
        'g_amendment_accepted_by_both',
        {},
        { ...amended, acceptedBy: [BUYER_PARTY_ID, BUYER_PARTY_ID] },
      ),
    ).toBe(false);
    // На другом событии guard не выполняется: он про приём новой редакции.
    expect(check('g_amendment_accepted_by_both', {})).toBe(false);
  });

  it('g_amount_sufficient', () => {
    expect(check('g_amount_sufficient', {})).toBe(true);
    expect(
      check('g_amount_sufficient', {}, { ...fundsReceived, amount: money('GEL', 999_999n) }),
    ).toBe(false);
    // Другая валюта — не «достаточно», а «не сравнимо»: fail-closed.
    expect(
      check('g_amount_sufficient', {}, { ...fundsReceived, amount: money('USD', 9_999_999n) }),
    ).toBe(false);
  });

  it('g_payer_matches', () => {
    expect(check('g_payer_matches', {})).toBe(true);
    expect(check('g_payer_matches', {}, { ...fundsReceived, sender: 'someone-else' })).toBe(false);
  });

  it('g_evidence_present', () => {
    expect(check('g_evidence_present', {})).toBe(true);
    expect(check('g_evidence_present', { evidenceBundleId: null })).toBe(false);
    expect(check('g_evidence_present', { evidenceBundleId: '' })).toBe(false);
  });

  it('g_fields_match: все пять полей', () => {
    expect(check('g_fields_match', {})).toBe(true);
    for (const field of Object.keys(MATCHING_STATEMENT) as (keyof typeof MATCHING_STATEMENT)[]) {
      expect(
        check('g_fields_match', {
          observation: observation({ fields: { ...MATCHING_STATEMENT, [field]: false } }),
        }),
      ).toBe(false);
    }
    // Наблюдения нет — полей нет, и их отсутствие не читается как совпадение
    // (CORE.md Ф7: отсутствие сигнала никогда не значит «всё хорошо»).
    expect(check('g_fields_match', { observation: null })).toBe(false);
  });

  it('g_owner_is_buyer: только established, и «недостаточно» роняет так же, как «опровергнуто»', () => {
    expect(check('g_owner_is_buyer', {})).toBe(true);
    expect(check('g_owner_is_buyer', { observation: observation({ ownerCheck: 'refuted' }) })).toBe(
      false,
    );
    // ⚠ Открытый вопрос CORE.md Ф7: отдаёт ли выписка номер документа
    // иностранного собственника. До ответа `insufficient` роняет guard ровно
    // так же, как `refuted`, — различаются они ключом причины и видом задачи
    // оператора, но не разрешением (ORACLE.md §5.3). Тест держит эти два
    // исхода неразличимыми **по разрешению** и различимыми по значению.
    expect(
      check('g_owner_is_buyer', { observation: observation({ ownerCheck: 'insufficient' }) }),
    ).toBe(false);
    expect(check('g_owner_is_buyer', { observation: null })).toBe(false);
    for (const outcome of OWNER_CHECKS) {
      expect(outcome === 'established').toBe(
        check('g_owner_is_buyer', { observation: observation({ ownerCheck: outcome }) }),
      );
    }
  });

  it('g_observation_sufficient: документ есть, он о нашем условии, нашем объекте и не протух', () => {
    expect(check('g_observation_sufficient', {})).toBe(true);
    // Наблюдения нет вовсе — единственное состояние, в котором транш проводит
    // почти всю жизнь, и денег оно не двигает.
    expect(check('g_observation_sufficient', { observation: null })).toBe(false);
    // Уровень ниже L3: карточка заявления запускает тайминг, но не деньги.
    for (const level of ['L0', 'L1', 'L2'] as const) {
      expect(check('g_observation_sufficient', { observation: observation({ level }) })).toBe(false);
    }
    // L4 и L5 — усиление, а не другое правило.
    for (const level of ['L4', 'L5'] as const) {
      expect(check('g_observation_sufficient', { observation: observation({ level }) })).toBe(true);
    }
    // Наблюдение о другом типе условия: акт транша — `registration_transfer`.
    expect(
      check('g_observation_sufficient', {
        observation: observation({
          conditionType: 'calendar_date',
          sourceKey: RELEASE_CONDITIONS.calendar_date.sourceKey,
        }),
      }),
    ).toBe(false);
    // Нужный тип, но не тот источник: «выписка» из системного времени.
    expect(
      check('g_observation_sufficient', {
        observation: observation({ sourceKey: 'time.independent_timestamp' }),
      }),
    ).toBe(false);
    // Наблюдение о чужом объекте — полноценное, свежее, L3.
    expect(
      check('g_observation_sufficient', { observation: observation({ cadastralCode: '99.99.99.999.999' }) }),
    ).toBe(false);
    expect(check('g_observation_sufficient', { expectedCadastralCode: '' })).toBe(false);
    // Свежесть: на границе политики ещё годится, за границей — нет.
    const stale = instant(NOW - DEFAULT_OBSERVATION_POLICY.maxAge);
    expect(
      check('g_observation_sufficient', { observation: observation({ observedAt: stale }) }),
    ).toBe(true);
    expect(
      check('g_observation_sufficient', {
        observation: observation({ observedAt: instant(stale - 1) }),
      }),
    ).toBe(false);
    // Наблюдение из будущего — рассогласование часов, а не «совсем свежее».
    expect(
      check('g_observation_sufficient', { observation: observation({ observedAt: instant(NOW + 1) }) }),
    ).toBe(false);
    // Акта нет — спрашивать не о чем: тип условия берётся из акта получателя.
    expect(check('g_observation_sufficient', { conditionAct: null })).toBe(false);
  });

  it('g_approvals_sufficient: пороги по сумме и запрет утверждения готовившим', () => {
    // Нулевой ступени нет: выплата без человека невозможна при любой сумме.
    // Прежняя редакция теста утверждала обратное — «до 30 000 ₾ без
    // утверждений» — и это была не проверка, а закрепление бага
    // (CRO-risk.md: автоматический релиз запрещён при любой сумме).
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 1n),
        approvals: [],
      }),
    ).toBe(false);
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 3_000_000n),
        approvals: [],
      }),
    ).toBe(false);
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 3_000_000n),
        approvals: [{ userId: 'approver-1' }],
      }),
    ).toBe(true);
    // 30 000 – 150 000 ₾ — один утверждающий, и не тот, кто готовил.
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 3_000_001n),
        approvals: [],
      }),
    ).toBe(false);
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 3_000_001n),
        approvals: [{ userId: 'operator-1' }],
      }),
    ).toBe(false);
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 3_000_001n),
        approvals: [{ userId: 'operator-2' }],
      }),
    ).toBe(true);
    // 150 000 – 500 000 ₾ — двое, и обязательно разные.
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 20_000_000n),
        approvals: [{ userId: 'operator-2' }, { userId: 'operator-2' }],
      }),
    ).toBe(false);
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 20_000_000n),
        approvals: [{ userId: 'operator-2' }, { userId: 'operator-3' }],
      }),
    ).toBe(true);
    // Свыше 500 000 ₾ на пилоте не берём — сколько бы ни было утверждений.
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 50_000_001n),
        approvals: [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }],
      }),
    ).toBe(false);
    // Валюта, для которой пороги не заданы: fail-closed.
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('USD', 1n),
        approvalPolicy: DEFAULT_APPROVAL_POLICY,
      }),
    ).toBe(false);
  });

  it('g_beneficiary_locked: блокировка и 72 часа без изменений', () => {
    expect(check('g_beneficiary_locked', {})).toBe(true);
    expect(
      check('g_beneficiary_locked', {
        beneficiary: { status: 'verified', locked: false, lastChangedAt: null },
      }),
    ).toBe(false);
    const justChanged = instant(NOW - BENEFICIARY_PRE_RELEASE_BLACKOUT_MS + 1);
    expect(
      check('g_beneficiary_locked', {
        beneficiary: { status: 'verified', locked: true, lastChangedAt: justChanged },
      }),
    ).toBe(false);
    const changedLongAgo = instant(NOW - BENEFICIARY_PRE_RELEASE_BLACKOUT_MS);
    expect(
      check('g_beneficiary_locked', {
        beneficiary: { status: 'verified', locked: true, lastChangedAt: changedLongAgo },
      }),
    ).toBe(true);
    // Guard про запертость и запретное окно, а не про владение: реквизиты,
    // прошедшие только сверку имени, он пропускает — их держит
    // `g_beneficiary_verified`. Два условия, два guard'а: склеенное правило
    // невозможно проверить поимённо, как требует §7.
    expect(
      check('g_beneficiary_locked', {
        beneficiary: { status: 'name_consistent', locked: true, lastChangedAt: null },
      }),
    ).toBe(true);
  });

  it('g_beneficiary_verified: совпадение имени — не доказательство владения', () => {
    expect(check('g_beneficiary_verified', {})).toBe(true);
    // ROADMAP.md И13.1: `name_consistent` — «но не verified: совпадение имени не
    // является достаточным основанием ни для чего».
    for (const status of ['draft', 'name_consistent', 'blocked'] as const) {
      expect(
        check('g_beneficiary_verified', {
          beneficiary: { status, locked: true, lastChangedAt: null },
        }),
      ).toBe(false);
    }
  });

  it('g_unfreeze_approvers_distinct', () => {
    const unfreeze: TrancheEvent = {
      type: 'unfreeze',
      userIds: ['a', 'b'],
      resume: 'suspended_from',
    };
    expect(check('g_unfreeze_approvers_distinct', {}, unfreeze)).toBe(true);
    expect(check('g_unfreeze_approvers_distinct', {}, { ...unfreeze, userIds: ['a', 'a'] })).toBe(
      false,
    );
    // Готовивший операцию утверждающим не считается — форма как у списания.
    expect(
      check(
        'g_unfreeze_approvers_distinct',
        { preparedBy: 'a' },
        { ...unfreeze, userIds: ['a', 'b'] },
      ),
    ).toBe(false);
    expect(check('g_unfreeze_approvers_distinct', {}, fundsReceived)).toBe(false);
  });

  it('g_no_active_payout', () => {
    expect(check('g_no_active_payout', {})).toBe(true);
    expect(check('g_no_active_payout', { activePayouts: 1 })).toBe(false);
  });

  it('g_coverage_ok', () => {
    expect(check('g_coverage_ok', {})).toBe(true);
    expect(check('g_coverage_ok', { coverageOk: false })).toBe(false);
  });

  it('g_source_account_known', () => {
    expect(check('g_source_account_known', {})).toBe(true);
    expect(check('g_source_account_known', { sourceAccountKnown: false })).toBe(false);
  });

  it('g_mismatch_resolved', () => {
    expect(check('g_mismatch_resolved', {})).toBe(true);
    expect(check('g_mismatch_resolved', { mismatchResolved: false })).toBe(false);
  });

  it('g_write_off_approvers_distinct', () => {
    const event: TrancheEvent = { type: 'write_off_approved', userIds: ['a', 'b'] };
    expect(check('g_write_off_approvers_distinct', {}, event)).toBe(true);
    expect(
      check('g_write_off_approvers_distinct', {}, { type: 'write_off_approved', userIds: ['a', 'a'] }),
    ).toBe(false);
    expect(
      check(
        'g_write_off_approvers_distinct',
        { preparedBy: 'a' },
        { type: 'write_off_approved', userIds: ['a', 'b'] },
      ),
    ).toBe(false);
    expect(check('g_write_off_approvers_distinct', {}, fundsReceived)).toBe(false);
  });
});
