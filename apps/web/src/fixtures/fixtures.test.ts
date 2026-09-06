import { describe, expect, it } from 'vitest';
import { isFullyCovered } from '@sdelka/ledger';
import { MONEY_STATES } from '@/view/money-state';
import { SCENARIOS } from './scenarios';
import {
  TASK_TYPES,
  getAccount,
  getDeal,
  getOpsQueue,
  listDeals,
  now as fixtureNow,
  reviewKindOf,
  worldJournal,
} from './store';
import { closingRuleOf, decidesAnything, evidenceOf, outcomesOf } from '@/ui/ops-work';

/**
 * Фикстуры проверяются автоматом, а не глазами: если событие не проходит
 * guard'ы домена, `runScenario` бросает, и тест краснеет здесь, а не рисует
 * экран в положении, недостижимом в жизни.
 */
describe('фикстуры', () => {
  it('каждая приводит домен ровно в то положение денег, которое обещает', async () => {
    for (const scenario of SCENARIOS) {
      const snapshot = await getDeal(scenario.id);
      expect(snapshot, scenario.id).not.toBeNull();
      expect(`${scenario.id}:${snapshot?.moneyState}`).toBe(`${scenario.id}:${scenario.expect}`);
    }
  });

  it('покрывают все восемнадцать положений денег', async () => {
    const deals = await listDeals();
    const covered = new Set(deals.map((deal) => deal.moneyState));
    expect([...MONEY_STATES].filter((state) => !covered.has(state))).toEqual([]);
  });

  it('нетерминальный транш всегда имеет видимый дедлайн, кроме замороженного', async () => {
    for (const deal of await listDeals()) {
      const terminal = ['paid_out', 'refunded', 'written_off'].includes(deal.trancheStatus);
      const frozen = deal.trancheStatus === 'frozen';
      if (terminal || frozen) continue;
      expect(deal.deadline, deal.id).not.toBeNull();
    }
  });

  it('покрытие клиентских средств не нарушено', () => {
    expect(isFullyCovered(worldJournal())).toBe(true);
  });

  it('счёт клиента разделён на свободную и запертую части', async () => {
    const account = await getAccount();
    expect(account.lockedParts.length).toBeGreaterThan(0);
    for (const part of account.lockedParts) {
      // По каждой запертой сумме видно, под какой сделкой и до какого момента.
      expect(part.dealRef.length).toBeGreaterThan(0);
      expect(part.deadline).not.toBeNull();
    }
  });

  it('запирание средств делает автомат, а не фикстура', async () => {
    // Пока запирание было шагом приложения, момент его выбирала фикстура, и
    // три проекции запирали деньги в трёх разных статусах. Проверяется тот
    // конец, который видит клиент: в `reserved` свободного остатка по сделке
    // нет, а файл транша покрывает требуемое (`STATE-MACHINES.md` §1.5).
    const held = await getDeal('m09');
    expect(held?.trancheStatus).toBe('reserved');
    expect(held?.locked.minor).toBe(held?.required.minor);
    expect(held?.credited.minor).toBe(0n);
  });

  it('снятие резерва по сроку оставляет деньги свободными, а не запертыми', async () => {
    // `CABINETS.md` §3.2 блок 6: «резерв будет снят автоматически и деньги
    // останутся у вас». До того как расфиксация стала намерением автомата,
    // обещание было ложным в учёте, и запись сходилась в ноль с обеих сторон —
    // то есть ни один инвариант её не ловил.
    const rolled = await getDeal('m19');
    expect(rolled?.trancheStatus).toBe('collected');
    expect(rolled?.moneyStateCode).toBe('M-06');
    expect(rolled?.locked.minor).toBe(0n);
    expect(rolled?.credited.minor).toBe(rolled?.required.minor);
    const account = await getAccount();
    // Снятый резерв исчезает из запертых частей: экран «Мой счёт» перестаёт
    // показывать сделку среди причин, по которым остаток недоступен.
    expect(account.lockedParts.some((part) => part.dealId === 'm19')).toBe(false);
  });

  it('«возвращено на ваш счёт» подтверждается журналом, а не флагом приложения', async () => {
    // `M-15` — единственное положение, где клиент выбирает: вывести или
    // провести заново. Раньше оно держалось на том, что приложение не
    // исполняло намерение внешнего вывода; теперь у него есть вторая опора,
    // проверяемая учётом, — деньги действительно лежат в свободной части счёта
    // покупателя и действительно отвязаны от транша.
    const returned = await getDeal('m15');
    expect(returned?.moneyStateCode).toBe('M-15');
    expect(returned?.locked.minor).toBe(0n);
    expect(returned?.credited.minor).toBe(returned?.required.minor);
    const account = await getAccount();
    expect(account.free.minor > 0n).toBe(true);
    // Кнопка вывода доступна: `W-04` — «выводить нечего».
    expect(account.withdrawState).not.toBe('W-04');
  });

  it('расчёт по сделке, где клиент получает, приходит на счёт со знаком плюс', async () => {
    const account = await getAccount();
    const settlement = account.records.find(
      (record) => record.memoKey === 'account.op.settle' && record.dealRef === 'SD-8A13',
    );
    // Раньше здесь брался первый клиентский счёт записи — запертая часть
    // плательщика, — и получатель видел собственное поступление как списание.
    expect(settlement?.amount.minor).toBeGreaterThan(0n);
  });

  it('очередь работы отсортирована по сроку и показывает каждый вид задачи', async () => {
    const ops = await getOpsQueue();
    const types = new Set(ops.tasks.map((task) => task.type));
    // Вид задачи, которого нет в очереди, оператор не увидит никогда — а
    // ровно так девять видов разбора и прожили: объявлены в коде, невидимы на
    // экране. Проверяется присутствие каждого, а не их количество.
    expect(TASK_TYPES.filter((type) => !types.has(type))).toEqual([]);
    const deadlines = ops.tasks.map((task) => task.deadline?.at ?? Number.MAX_SAFE_INTEGER);
    expect([...deadlines].sort((left, right) => left - right)).toEqual(deadlines);
  });

  it('каждому виду разбора из кода отвечает вид задачи консоли', async () => {
    // `EVERY_REVIEW_KIND_HAS_A_PLACE` проверяет это сборкой; здесь — вторая
    // опора, читаемая человеком: соответствие не пустое и не выдумано.
    const placed = TASK_TYPES.map((type) => reviewKindOf(type)).filter((kind) => kind !== null);
    expect(new Set(placed).size).toBe(placed.length);
    expect(placed).toContain('intake_underpayment');
    expect(placed).toContain('sanctions_unavailable');
  });

  it('недоплата приходит в очередь из учёта, а не из таблицы фикстур', async () => {
    // `INTAKE.md` И2.1, критерий 3: «оператор видит задачу». Задача выводится
    // из положения денег, поэтому её нельзя потерять, поправив таблицу.
    const ops = await getOpsQueue();
    const task = ops.tasks.find((item) => item.type === 'intakeUnderpayment');
    expect(task).toBeDefined();
    const deal = await getDeal(task?.subject.kind === 'deal' ? task.subject.dealId : '');
    expect(deal?.moneyState).toBe('partiallyFunded');
    // Недостача в карточке — та же величина, что в учёте, и в той же валюте.
    const shortfall = task?.facts.find((fact) => fact.labelKey === 'ops.fact.shortfall');
    expect(shortfall?.kind).toBe('money');
    expect(shortfall?.kind === 'money' ? shortfall.value.minor : 0n).toBe(deal?.shortfall?.minor);
    expect(shortfall?.kind === 'money' ? shortfall.value.currency : null).toBe(
      deal?.required.currency,
    );
  });

  it('простой заявки на вывод не выдумывает ни сделки, ни суммы', async () => {
    // Три отсутствия из `ReviewTask`: сделки у вывода нет вовсе, лица нет (у
    // заявки известен ключ счёта, а не идентификатор лица), суммы ранжирования
    // нет — пересчёт требует официального курса. Проверяется типом предмета:
    // подставить сюда чужую сделку нельзя, не поменяв объединение.
    const ops = await getOpsQueue();
    const task = ops.tasks.find((item) => item.type === 'withdrawalStalled');
    expect(task).toBeDefined();
    expect(task?.subject.kind).toBe('withdrawal');
    expect(task?.claimedBy).toBeNull();
    // Возраст идёт от входа в состояние, срок — своей дорогой. Именно поэтому
    // задача существует: по сроку она **не просрочена** и без возраста
    // выглядела бы свежей.
    const now = fixtureNow();
    expect(task?.ageMs ?? 0).toBeGreaterThan(48 * 3_600_000);
    expect(task?.deadline?.at ?? 0).toBeGreaterThan(now);
  });

  it('на карточке простоя заявки нет ни одного исхода — и это значение', async () => {
    // Красная линия №8: повтор из «неизвестно» запрещён без сверки. У машины
    // вывода нет ни одного события по сроку, значит, и ребра, которое человек
    // выбрал бы здесь. Кнопка появится только вместе с исходом — поэтому
    // проверяется перечень, а не разметка.
    expect(outcomesOf('withdrawalStalled')).toEqual([]);
    expect(decidesAnything('withdrawalStalled')).toBe(false);
    expect(evidenceOf('withdrawalStalled')).toBeNull();
    expect(closingRuleOf('withdrawalStalled')).toBeNull();
    // У остальных семнадцати решение есть, и все три ответа сходятся.
    for (const type of TASK_TYPES.filter((item) => item !== 'withdrawalStalled')) {
      expect(decidesAnything(type), type).toBe(true);
      expect(evidenceOf(type), type).not.toBeNull();
      expect(closingRuleOf(type), type).not.toBeNull();
    }
  });

  it('суммы в фактах разбора не смешивают валюты с суммой ранжирования', async () => {
    const ops = await getOpsQueue();
    for (const task of ops.tasks) {
      for (const fact of task.facts) {
        if (fact.kind !== 'money' && fact.kind !== 'delta') continue;
        // Валюта у каждой суммы своя и складывать их не с чем: единой суммы
        // «всего по задаче» не существует.
        expect(fact.value.currency.length, `${task.id}:${fact.labelKey}`).toBe(3);
      }
    }
  });
});
