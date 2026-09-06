import { WITHDRAWAL_STATUSES, withdrawalArrivals } from '@sdelka/domain';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/i18n/locales';
import { dictionaryOf } from '@/i18n/translate';
import {
  type WithdrawArrival,
  withdrawArrivalOf,
  withdrawRepeatBlockedKey,
  withdrawStateKey,
  withdrawStateTone,
} from './withdraw-state';

/**
 * Красная линия №8 на экране клиента.
 *
 * Проверяется не «есть ли строка», а **различает ли экран положения**: до этого
 * захода «поручение отправлено», «ответа банка нет», «остановила наша проверка»
 * и «банк не исполнил» читались одинаково, потому что ключ собирался из одного
 * статуса. Снимок такого не ловит: экран выглядит целым и говорит неправду.
 */

/** Все положения, которые машина считает возможными, плюс «исход не записан». */
function situations(): readonly (readonly [(typeof WITHDRAWAL_STATUSES)[number], WithdrawArrival])[] {
  const list: (readonly [(typeof WITHDRAWAL_STATUSES)[number], WithdrawArrival])[] = [];
  for (const status of WITHDRAWAL_STATUSES) {
    for (const arrival of [...withdrawalArrivals(status), undefined]) {
      list.push([status, arrival]);
    }
  }
  return list;
}

describe('исход поручения на экране вывода', () => {
  it('различает четыре положения, которые статус сливает в одно', () => {
    expect(withdrawStateKey('paying_out', null)).toBe('withdraw.state.paying_out');
    expect(withdrawStateKey('paying_out', 'unknown')).toBe('withdraw.state.paying_out.unknown');
    expect(withdrawStateKey('blocked', null)).toBe('withdraw.state.blocked.review');
    expect(withdrawStateKey('blocked', 'rejected')).toBe('withdraw.state.blocked.rejected');
    const keys = new Set([
      withdrawStateKey('paying_out', null),
      withdrawStateKey('paying_out', 'unknown'),
      withdrawStateKey('blocked', null),
      withdrawStateKey('blocked', 'rejected'),
    ]);
    expect(keys.size).toBe(4);
  });

  it('не записанный исход не выдаётся за известный', () => {
    // Состояние, прочитанное из хранилища, не помнит, каким ребром в него
    // вошли. Общая формулировка здесь честнее точной: «причину назовём, когда
    // разбор закончится» — это то, что мы действительно знаем.
    expect(withdrawStateKey('blocked', undefined)).toBe('withdraw.state.blocked');
    expect(withdrawStateKey('paying_out', undefined)).toBe('withdraw.state.paying_out');
  });

  it('каждое положение названо строками, которые есть на трёх языках', () => {
    // Проекция не вправе назвать ключ, которого нет в словаре: на экране это
    // непереведённый ключ вместо состояния денег.
    for (const [status, arrival] of situations()) {
      const key = withdrawStateKey(status, arrival);
      for (const locale of LOCALES) {
        const dict = dictionaryOf(locale);
        for (const part of ['badge', 'title', 'body']) {
          expect(typeof dict[`${key}.${part}`], `${locale}: нет ${key}.${part}`).toBe('string');
        }
      }
      const repeat = withdrawRepeatBlockedKey(status, arrival);
      for (const locale of LOCALES) {
        expect(typeof dictionaryOf(locale)[repeat], `${locale}: нет ${repeat}`).toBe('string');
      }
    }
  });

  it('запрет повтора из «неизвестно» назван своей причиной', () => {
    // Вторая половина красной линии №8. Общая строка описывает очередь («пока
    // идёт этот вывод»), и в «неизвестно» она читается как «подождите» — а
    // ждать нечего: повтор открывает только сверка с выпиской.
    expect(withdrawRepeatBlockedKey('paying_out', 'unknown')).toBe(
      'withdraw.repeat.blocked.unknown',
    );
    expect(withdrawRepeatBlockedKey('paying_out', null)).toBe('withdraw.repeat.blocked');
    expect(withdrawRepeatBlockedKey('blocked', 'rejected')).toBe('withdraw.repeat.blocked');
  });

  it('«исход неизвестен» отличается от «идёт как обычно» не только словами', () => {
    // Цветом состояние не передаётся ни разу, но и цвет не вправе говорить
    // «всё идёт своим ходом» там, где ответа банка нет.
    expect(withdrawStateTone('paying_out', 'unknown')).toBe('warn');
    expect(withdrawStateTone('paying_out', null)).toBe('info');
    expect(withdrawStateTone('blocked', 'rejected')).toBe('warn');
  });

  it('приёмочный ключ адреса не создаёт положений, которых машина не знает', () => {
    expect(withdrawArrivalOf('paying_out', 'unknown')).toBe('unknown');
    expect(withdrawArrivalOf('paying_out', 'none')).toBeNull();
    expect(withdrawArrivalOf('paid_out', 'settled')).toBe('settled');
    // Ребра нет — значит и положения нет: «отменено после подтверждения банка»
    // и «неизвестно» у приостановленной заявки не показываются вовсе.
    expect(withdrawArrivalOf('cancelled', 'settled')).toBeUndefined();
    expect(withdrawArrivalOf('blocked', 'unknown')).toBeUndefined();
    expect(withdrawArrivalOf('paid_out', 'none')).toBeUndefined();
    // Мусор в параметре — не положение заявки.
    expect(withdrawArrivalOf('paying_out', 'whatever')).toBeUndefined();
    expect(withdrawArrivalOf('paying_out', '')).toBeUndefined();
    expect(withdrawArrivalOf('paying_out', undefined)).toBeUndefined();
  });
});
