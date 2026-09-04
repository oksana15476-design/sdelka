import { describe, expect, it } from 'vitest';
import {
  type DealContext,
  type DealEvent,
  type DealStatus,
  DEAL_STATUSES,
  DEAL_TRANSITIONS,
  DUE_TRANCHE_EVENTS,
  RejectionCode,
  deadline,
  dealState,
  dueTrancheEvent,
  instant,
  isTerminalDealStatus,
  nonTerminalTrancheState,
  reachableFrom,
  reduceDeal,
  reduceTranche,
} from '../src/index';
import { CONDITION_ACT, NOW, context as trancheContext, dealFacts, filing } from './support/facts';

/**
 * Красная линия №7 в состоянии «подано» — воспроизведение и регрессия.
 *
 * Сделка в `filed`, заявление подтверждено карточкой и не разрешено платной
 * выпиской. Реестр молчит. Вопрос один: есть ли из этого состояния выход к
 * возврату покупателю — автоматический или волевой.
 *
 * До этого батча ответа не было ни одного:
 *
 *  - `deadline_reached` отвергался guard'ом `g_no_open_filing` (E3-2, Ф9);
 *  - ребра `filed --revocation_requested--> …` в таблице нет вовсе — отзыв
 *    выражен только из `funding`;
 *  - оставались `condition_established`, `condition_failed` и заморозка, то
 *    есть **только события извне**, которых молчащий реестр не производит.
 *
 * Деньги при этом лежат: транши сделки в `filed` находятся в `reserved`
 * (вход в `funded` держит `g_all_tranches_reserved`), то есть заперты под
 * сделку. Удержание бессрочное и выйти из него нельзя — а красная линия №7
 * говорит обратное: **состояние по умолчанию при бездействии — возврат
 * покупателю, не удержание**.
 */

const OPEN_FILING: DealContext = {
  dealId: 'deal-1',
  now: NOW,
  facts: dealFacts({ filings: [filing({ source: 'application_card', resolution: null })] }),
};

/**
 * События, которые в принципе могут прийти к сделке в `filed`, — по таблице
 * переходов, а не по памяти. Перечисление руками устаревает в тот же день,
 * когда добавляется событие.
 */
function eventsOutOf(status: DealStatus): readonly string[] {
  return [...new Set(DEAL_TRANSITIONS.filter((item) => item.from === status).map((i) => i.event))];
}

describe('красная линия №7: молчащий реестр и состояние «подано»', () => {
  it('автооткат по отсечке запрещён, пока подача подтверждена и не разрешена', () => {
    // Это правильное поведение Ф9 и оно остаётся: сторона не должна получить
    // деньги обратно в тот же час, когда реестр регистрирует переход права.
    const result = reduceDeal(dealState('filed'), { type: 'deadline_reached' }, OPEN_FILING);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(RejectionCode.guardFailed);
      expect([...result.error.failedGuards]).toEqual(['g_no_open_filing']);
    }
  });

  it('отзыв покупателя из «подано» не принимается: ребра нет вовсе', () => {
    // ⚠ Это не guard и не решение — это отсутствие строки в таблице. Отказ
    // приходит с кодом «переход запрещён», то есть волеизъявлению покупателя
    // здесь не отвечают «нельзя, потому что…», ему не отвечают вообще.
    //
    // Граница отзыва, записанная в §1.4, — событие `condition_established`, и
    // `filed` лежит **до** неё: транши сделки в этот момент в `reserved`, а
    // оттуда автомат транша отзыв принимает. То есть машина денег и машина
    // оркестрации расходятся друг с другом.
    const result = reduceDeal(dealState('filed'), { type: 'revocation_requested' }, OPEN_FILING);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(RejectionCode.transitionNotAllowed);
    }
  });

  it('выход есть, и он проходит через двух разных людей', () => {
    // Разбор человеком — не автооткат, и Ф9 запрещает именно автоматический
    // откат. Одной подписи мало: цена решения — вся сумма сделки.
    const single = reduceDeal(
      dealState('filed'),
      { type: 'unwind_authorized', userIds: ['operator-1'] },
      OPEN_FILING,
    );
    expect(single.ok).toBe(false);
    if (!single.ok) {
      expect([...single.error.failedGuards]).toEqual(['g_unwind_approvers_distinct']);
    }

    // Подписи двух, но одного и того же имени — одна подпись.
    const repeated = reduceDeal(
      dealState('filed'),
      { type: 'unwind_authorized', userIds: ['operator-2', 'operator-2'] },
      OPEN_FILING,
    );
    expect(repeated.ok).toBe(false);

    // Готовивший операцию не считается утверждающим — как у разморозки.
    const preparer: DealContext = {
      ...OPEN_FILING,
      facts: { ...OPEN_FILING.facts, preparedBy: 'operator-2' },
    };
    const byPreparer = reduceDeal(
      dealState('filed'),
      { type: 'unwind_authorized', userIds: ['operator-2', 'operator-3'] },
      preparer,
    );
    expect(byPreparer.ok).toBe(false);

    const authorized = reduceDeal(
      dealState('filed'),
      { type: 'unwind_authorized', userIds: ['operator-2', 'operator-3'] },
      OPEN_FILING,
    );
    expect(authorized.ok).toBe(true);
    if (authorized.ok) {
      expect(authorized.value.state.status).toBe('unwinding');
      // Намерений у отката нет — ни здесь, ни у `condition_failed`: сделка
      // деньгами не двигает, транши откатываются своими событиями.
      expect(authorized.value.intents).toEqual([]);
    }
  });

  it('дверь человека стоит на всех состояниях, где деньги заперты и автооткат закрыт', () => {
    // `funded` — тот же дефект и без всякого прикрытия: до батча из него не
    // вело **ничего**, кроме подачи и заморозки, ни отсечки, ни отзыва, а
    // транши в этот момент уже в `reserved`.
    for (const status of ['funding', 'funded', 'filed'] as const) {
      expect(eventsOutOf(status)).toContain('unwind_authorized');
      const result = reduceDeal(
        dealState(status),
        { type: 'unwind_authorized', userIds: ['operator-2', 'operator-3'] },
        OPEN_FILING,
      );
      expect(result.ok, `${status} не выводит в откат утверждением людей`).toBe(true);
    }

    // После установления условия платёж считается исполненным в пользу
    // продавца: отменять его утверждением двух наших сотрудников нельзя
    // (§1.4, граница отзыва).
    const settling = reduceDeal(
      dealState('settling'),
      { type: 'unwind_authorized', userIds: ['operator-2', 'operator-3'] },
      OPEN_FILING,
    );
    expect(settling.ok).toBe(false);
    if (!settling.ok) {
      expect(settling.error.code).toBe(RejectionCode.transitionNotAllowed);
    }
  });

  it('автооткат остаётся запрещён: дверь человека его не открыла', () => {
    // Проверка, что лечение не отменило лекарство. Событие часов из `filed`
    // по-прежнему отвергается, и отвергается тем же guard'ом.
    const result = reduceDeal(dealState('filed'), { type: 'deadline_reached' }, OPEN_FILING);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect([...result.error.failedGuards]).toEqual(['g_no_open_filing']);
    }
    // И событие разбора не порождается часами: `unwind_authorized` невыразим в
    // таблице `DUE_TRANCHE_EVENTS` — она вообще о транше, а у сделки часов нет.
    expect(Object.values(DUE_TRANCHE_EVENTS)).not.toContain('unwind_authorized');
  });

  it('возврат достижим из «подано» без внешнего факта и без заморозки', () => {
    // Обход графа по тем рёбрам, которые эти факты реально пропускают: guard,
    // отвергающий переход, ребром не является. Перечислять состояния руками
    // нельзя — перечисление устареет на следующем состоянии.
    //
    // Из хода выброшены две группы рёбер, и обе намеренно:
    //
    //  · внешний факт (`condition_established`, `condition_failed`) — его
    //    производит реестр, а вопрос ровно в том, что реестр молчит;
    //  · заморозка — у неё закрытый перечень оснований (санкции, проверка
    //    комплаенса, спор), и «реестр не ответил» не является ни одним из них.
    //    Уводить туда молчание значило бы показывать оператору технический
    //    инцидент как комплаенс-заморозку (`ORACLE.md` §10, тот же довод,
    //    которым `registry_unavailable` не попал в `FREEZE_REASONS`).
    const external = new Set(['condition_established', 'condition_failed']);
    const freeze = new Set(['compliance_hold', 'dispute_raised']);
    const passable = DEAL_TRANSITIONS.filter((item) => {
      if (freeze.has(item.event)) return false;
      if (item.from !== 'filed') return true;
      if (external.has(item.event)) return false;
      // Событие собирается из ребра, а не пишется руками: поля, без которых
      // событие не событие, добавляются здесь по одному разу.
      const event = {
        type: item.event,
        ...(item.resume === null ? {} : { resume: item.resume }),
        userIds: ['operator-2', 'operator-3'],
      };
      return reduceDeal(dealState('filed'), event as unknown as DealEvent, OPEN_FILING).ok;
    }).map((item) => ({ from: item.from, to: item.to }));

    const reachable = reachableFrom(passable, 'filed');
    expect([...reachable]).toContain('unwinding');
    expect([...reachable]).toContain('unwound');
  });

  it('обход графа тупика не видит, и это про сам метод проверки', () => {
    // Второй контур §5 («проверка на тупики») проходит зелёным и до батча, и
    // после: рёбра из `filed` в таблице есть, guard'ы обход не читает. То есть
    // бессрочное удержание было **невидимо для той самой проверки**, которая
    // заведена ради отсутствия тупиков. Тупик, закрытый guard'ом, ловится
    // только прогоном редьюсера на фактах — как в тестах выше.
    const edges = DEAL_TRANSITIONS.map((item) => ({ from: item.from, to: item.to }));
    const stuck = DEAL_STATUSES.filter((status) => !isTerminalDealStatus(status)).filter(
      (status) => ![...reachableFrom(edges, status)].some((s) => isTerminalDealStatus(s as DealStatus)),
    );
    expect(stuck).toEqual([]);
  });
});

/**
 * Найдено при воспроизведении, **не чинится этим батчем** — развилка владельца.
 *
 * `g_no_open_filing` стоит на автомате сделки. Деньги держит автомат транша, и
 * он о заявлениях не знает вовсе: `dueTrancheEvent` читает только статус и
 * момент срабатывания. Транши сделки в `filed` находятся в `reserved`, часы
 * этого статуса дают `reserve_expired` (сутки по умолчанию) — деньги
 * расфиксируются в свободную часть счёта покупателя, ещё через сутки
 * `deadline_reached` уводит их в возврат.
 *
 * То есть при подтверждённой открытой подаче сегодня происходит ровно то, что
 * Ф9 запрещает: деньги уходят обратно покупателю по нашей отсечке, а объект
 * наутро регистрируется на него же. Запрет действует только на записи о
 * сделке, которая денег не держит.
 *
 * Обе стороны развилки стоят денег, поэтому решение — владельца, и тест здесь
 * фиксирует **сегодняшнее поведение**, а не желаемое: подгонять его под свою
 * версию значило бы принять решение от своего имени.
 */
describe('найдено при воспроизведении: часы транша не знают об открытой подаче', () => {
  const EXPIRED = deadline(instant(NOW - 1));

  it('резерв снимается по отсечке независимо от заявления по сделке', () => {
    const reserved = nonTerminalTrancheState('reserved', EXPIRED, NOW, CONDITION_ACT);
    const due = dueTrancheEvent(reserved, NOW);
    expect(due?.type).toBe('reserve_expired');

    const unlocked = reduceTranche(reserved, { type: 'reserve_expired' }, trancheContext());
    expect(unlocked.ok).toBe(true);
    if (!unlocked.ok) return;
    expect(unlocked.value.state.status).toBe('collected');
    // Деньги отвязаны от транша и снова отзывные — красная линия №7 на своей
    // стороне сработала, но она сработала **вопреки** Ф9, а не вместе с ней.
    expect(unlocked.value.intents.map((intent) => intent.type)).toContain('post_journal_entry');
  });

  it('и дальше по отсечке уходит в возврат, тоже ничего не спрашивая', () => {
    const collected = nonTerminalTrancheState('collected', EXPIRED, NOW, CONDITION_ACT);
    expect(dueTrancheEvent(collected, NOW)?.type).toBe('deadline_reached');
    const refunding = reduceTranche(collected, { type: 'deadline_reached' }, trancheContext());
    expect(refunding.ok).toBe(true);
    if (refunding.ok) expect(refunding.value.state.status).toBe('refund_pending');
  });

  it('у транша нет ни одного факта о заявлении: сверять не с чем', () => {
    // Не «guard забыли», а «данных нет по типу». Закрыть эту сторону значит
    // завести у транша факт о подаче по сделке — то есть решить развилку.
    expect(Object.keys(trancheContext().facts)).not.toContain('filings');
  });
});
