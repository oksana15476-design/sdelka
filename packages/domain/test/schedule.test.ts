import { describe, expect, it } from 'vitest';
import {
  type Instant,
  type ThawedTrancheStatus,
  type TrancheEvent,
  DEFAULT_DEADLINE_POLICY,
  DUE_TRANCHE_EVENTS,
  THAWED_TRANCHE_STATUSES,
  TRANCHE_TRANSITIONS,
  dueTrancheEvent,
  instant,
  plus,
  reduceTranche,
} from '../src/index';
import { NOW, context } from './support/facts';
import { frozenStateAt, stateAt } from './support/drive';

/** Момент строго после дедлайна любого остывшего статуса. */
const LATER: Instant = plus(NOW, DEFAULT_DEADLINE_POLICY.collecting);

/**
 * Наступление срока — событие, и порождать его обязан кто-то. Раньше не
 * порождал никто: `Deadline` лежал в состоянии, `isPast` был объявлен и не
 * вызывался, а `CABINETS.md` §3.2 обещал автоматическое снятие резерва.
 *
 * Тест перебирает статусы **рантайм-списком**, а не литералом: новый остывший
 * статус обязан уронить перебор, а не тихо получить `undefined` от таблицы.
 * Это тот же приём, которым `impossible-states.test.ts` держит инвариант 7.
 */
describe('часы транша: селектор события по дедлайну', () => {
  it('даёт определённый ответ каждому остывшему статусу и ни у одного не молчит случайно', () => {
    for (const status of THAWED_TRANCHE_STATUSES) {
      const answer = DUE_TRANCHE_EVENTS[status];
      // `undefined` от таблицы означало бы «статус забыли», и это не то же
      // самое, что `null` — «часы этого статуса деньги не двигают».
      expect(answer === null || typeof answer === 'string').toBe(true);
    }
    expect(Object.keys(DUE_TRANCHE_EVENTS).sort()).toEqual([...THAWED_TRANCHE_STATUSES].sort());
  });

  it('каждое непустое событие принимается таблицей переходов из своего статуса', () => {
    for (const status of THAWED_TRANCHE_STATUSES) {
      const type = DUE_TRANCHE_EVENTS[status];
      if (type === null) continue;
      // Планировщик проходит ту же дверь, что человек: если события нет в
      // таблице для этого статуса, транш встанет намертво, а часы будут
      // «срабатывать» вхолостую каждые пятнадцать минут.
      const edges = TRANCHE_TRANSITIONS.filter(
        (edge) => edge.from === status && edge.event === type,
      );
      expect(edges.length).toBeGreaterThan(0);
    }
  });

  it('до дедлайна молчит у всех статусов', () => {
    for (const status of THAWED_TRANCHE_STATUSES) {
      expect(dueTrancheEvent(stateAt(status), NOW)).toBeNull();
    }
  });

  it('после дедлайна отвечает ровно тем, что написано в таблице', () => {
    for (const status of THAWED_TRANCHE_STATUSES) {
      const expected = DUE_TRANCHE_EVENTS[status];
      const due = dueTrancheEvent(stateAt(status), LATER);
      expect(due === null ? null : due.type).toBe(expected);
    }
  });

  it('резерв снимается событием reserve_expired, а не deadline_reached', () => {
    // CABINETS.md §3.2 блок 6: «резерв будет снят автоматически и деньги
    // останутся у вас. Сделку можно будет провести заново». Это `collected`, а
    // не `refund_pending`, куда увёл бы `deadline_reached`.
    const due = dueTrancheEvent(stateAt('reserved'), LATER);
    expect(due).toEqual({ type: 'reserve_expired' });

    const result = reduceTranche(stateAt('reserved'), due as TrancheEvent, context(undefined, LATER));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state.status).toBe('collected');
    }
  });

  it('pending молчит: §5 обещает ребро, которого в таблице переходов нет', () => {
    // Найдено этой же таблицей. §5 обещает «`pending`, `collecting` → дедлайн →
    // `refund_pending`», а в §1.4 у `pending` есть только `instructions_issued`.
    // Часы не сочиняют рёбер: событие, которого таблица не примет, отвергалось
    // бы каждые пятнадцать минут вхолостую. Тест держит расхождение видимым —
    // если ребро появится, он упадёт и потребует пересмотреть таблицу часов.
    expect(DUE_TRANCHE_EVENTS.pending).toBeNull();
    expect(
      TRANCHE_TRANSITIONS.filter(
        (edge) => edge.from === 'pending' && edge.event === 'deadline_reached',
      ),
    ).toEqual([]);
  });

  it('release_blocked остаётся выходом только через человека', () => {
    // §5: «единственное состояние, выход из которого зависит от человека».
    // Автоматический выход отсюда — это и есть тот дефект, ради запрета
    // которого состояние существует.
    expect(dueTrancheEvent(stateAt('release_blocked'), LATER)).toBeNull();
  });

  it('замороженному траншу часы не отвечают: поля дедлайна у него нет', () => {
    // Приоритет заморозки над возвратом (CORE.md Ф17) держится структурой и
    // здесь: сравнивать нечего, ветка невыразима. Отсутствие строки в таблице
    // переходов — второй контур, и оба остаются.
    const frozen = frozenStateAt('reserved', DEFAULT_DEADLINE_POLICY.reserved);
    expect(dueTrancheEvent(frozen, LATER)).toBeNull();

    const rejected = reduceTranche(frozen, { type: 'deadline_reached' }, context(undefined, LATER));
    expect(rejected.ok).toBe(false);
  });

  it('терминальному траншу часы не отвечают', () => {
    const paidOut = { status: 'paid_out' } as const;
    expect(dueTrancheEvent(paidOut, LATER)).toBeNull();
  });

  it('детерминирована: те же аргументы дают тот же ответ, часов внутри нет', () => {
    const status: ThawedTrancheStatus = 'reserved';
    const first = dueTrancheEvent(stateAt(status), LATER);
    const second = dueTrancheEvent(stateAt(status), LATER);
    expect(first).toEqual(second);

    // Ровно на границе дедлайн считается наступившим: `isPast` — «не позже
    // now», а не «строго раньше». Планировщик ходит раз в пятнадцать минут, и
    // отсечка, пропущенная на равенстве, ждала бы следующего обхода.
    const at = plus(NOW, DEFAULT_DEADLINE_POLICY.reserved);
    expect(dueTrancheEvent(stateAt(status), at)).toEqual({ type: 'reserve_expired' });
    expect(dueTrancheEvent(stateAt(status), instant(at - 1))).toBeNull();
  });
});
