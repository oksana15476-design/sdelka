import { describe, expect, it } from 'vitest';
import { DEFAULT_ESCALATION_POLICY, dueTrancheEvent } from '@sdelka/domain';
import { accountBalance, clientFreeAccount, clientLockedAccount } from '@sdelka/ledger';
import {
  advance,
  tick,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  applyTrancheEvent,
} from './support/acting';
import { DAY_MS, GEL, POLICY_VERSION } from './support/fixtures';
import { toCollected, toReserved } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION);

/**
 * Сценарий — **у часов появился вызывающий**.
 *
 * `dueTrancheEvent` был написан, задокументирован и покрыт тестами — и не
 * звался ниоткуда, кроме этих тестов. Семь из девяти остывших статусов получали
 * дедлайн, который никто не превращал в событие: обещание `CABINETS.md` §3.2
 * блок 6 «резерв будет снят автоматически» исполнять было некому, и дыра
 * «дедлайн лежит, его никто не читает» просто переехала из домена в приложение.
 *
 * Здесь проверяется тик как целое: обход живых траншей, подача наступивших
 * событий в ту же дверь, куда ходит человек, и разведение двух отметок времени
 * — дедлайн двигает деньги, возраст поднимает дежурного (`STATE-MACHINES.md`
 * §5).
 */
describe('планировщик: тик по живым траншам', () => {
  it('снимает резерв и уводит несобранный транш в возврат за один проход', async () => {
    // Два транша одного мира в разных состояниях: у одного часы дают
    // `reserve_expired`, у другого — `deadline_reached`, и это разные события,
    // а не одно «время вышло».
    const reserved = await toReserved({ dealId: 'deal-tick-a', trancheId: 'tranche-tick-a' });
    const collected = await toCollected({
      dealId: 'deal-tick-b',
      trancheId: 'tranche-tick-b',
      world: reserved.world,
    });
    let world = collected.world;
    const buyerFile = clientLockedAccount(reserved.buyerKey, 'deal-tick-a', 'tranche-tick-a');

    // --- Срок не настал: тик не делает ничего ---
    const quiet = tick(world, OPTIONS);
    expect(quiet.fired).toEqual([]);
    expect(quiet.world.journal.entries).toHaveLength(world.journal.entries.length);

    world = advance(world, DAY_MS + 1);

    // --- Срок настал: один проход, два разных события ---
    const fired = tick(world, OPTIONS);
    world = fired.world;
    expect(fired.fired.map((item) => [item.trancheId, item.event.type, item.to])).toEqual([
      ['tranche-tick-a', 'reserve_expired', 'collected'],
      ['tranche-tick-b', 'deadline_reached', 'refund_pending'],
    ]);

    // «Деньги останутся у вас»: расфиксация — намерение автомата, и тик её не
    // выбирает и не пропускает. У теста больше нет двери, чтобы её забыть.
    expect(accountBalance(world.journal, buyerFile, GEL).minor).toBe(0n);
    // Сорок миллионов, а не двадцать: счёт клиента один на все его сделки в
    // любых ролях (`FUNCTIONAL.md` §2.1), и в свободной части лежат и
    // расфиксированные деньги первого транша, и деньги второго, который до
    // резерва не дошёл. Оба покупателя здесь — одно лицо.
    expect(accountBalance(world.journal, clientFreeAccount(reserved.buyerKey), GEL).minor).toBe(
      40_000_000n,
    );

    // --- Второй проход подряд не двигает ничего ---
    // Транш, только что вошедший в новое состояние, несёт новый дедлайн, и
    // повторный тик по нему молчит: иначе планировщик раз в пятнадцать минут
    // гонял бы транш по кругу.
    const again = tick(world, OPTIONS);
    expect(again.fired).toEqual([]);
    expect(again.world.journal.entries).toHaveLength(world.journal.entries.length);
    expect(trancheStatusOf(again.world, 'tranche-tick-a')).toBe('collected');
    expect(trancheStatusOf(again.world, 'tranche-tick-b')).toBe('refund_pending');
  });

  it('не трогает замороженный транш и не проверяет этого флагом', async () => {
    const reserved = await toReserved({ dealId: 'deal-tick-frozen', trancheId: 'tranche-tick-frozen' });
    let world = applyTrancheEvent(
      reserved.world,
      'tranche-tick-frozen',
      { type: 'compliance_hold', reason: 'sanctions', frozenBy: 'analyst-1' },
      OPTIONS,
    ).world;
    world = advance(world, 30 * DAY_MS);

    const result = tick(world, OPTIONS);
    // У замороженного состояния поля дедлайна нет вовсе, сравнивать нечего, и
    // ветка невыразима (`CORE.md` Ф17). Тик не спрашивает «а не заморожен ли» —
    // такой проверки здесь нет, и забыть её поэтому нельзя.
    expect(result.fired).toEqual([]);
    expect(trancheStatusOf(result.world, 'tranche-tick-frozen')).toBe('frozen');
    // Возраст у замороженного идёт как обычно — это и есть его «обязательный
    // срок разбора» (§5): часы молчат, дежурный вызван.
    expect(result.escalated.map((item) => item.trancheId)).toEqual(['tranche-tick-frozen']);
    expect(result.escalated[0]?.status).toBe('frozen');
  });

  it('поднимает дежурного возрастом там, где часы молчат, и не двигает транш', async () => {
    const reserved = await toReserved({ dealId: 'deal-tick-blocked', trancheId: 'tranche-tick-blocked' });
    let world = applyTrancheEvent(
      reserved.world,
      'tranche-tick-blocked',
      { type: 'mismatch_detected', field: 'share' },
      OPTIONS,
    ).world;

    // `release_blocked` — единственное состояние, выход из которого зависит от
    // человека, и автоматического события у него нет **намеренно**: авто-выход
    // отсюда есть тот самый дефект, ради запрета которого состояние
    // существует. Часы здесь обязаны молчать даже когда дедлайн прошёл.
    world = advance(world, DAY_MS + 1);
    expect(dueTrancheEvent(trancheOf(world, 'tranche-tick-blocked').state, world.now)).toBeNull();

    const result = tick(world, OPTIONS);
    expect(result.fired).toEqual([]);
    expect(trancheStatusOf(result.world, 'tranche-tick-blocked')).toBe('release_blocked');
    // Зато возраст превысил норматив в четыре часа — и это вторая отметка
    // времени, а не та же самая: дедлайн двигает деньги, возраст поднимает
    // человека.
    const escalated = result.escalated.find((item) => item.trancheId === 'tranche-tick-blocked');
    expect(escalated?.status).toBe('release_blocked');
    expect(escalated?.ageMs).toBeGreaterThanOrEqual(
      DEFAULT_ESCALATION_POLICY.release_blocked,
    );
  });
});
