import type { DealStatus, PayoutStatus, TrancheStatus } from '@sdelka/domain';

/**
 * «Где деньги» — проекция состояний домена на язык интерфейса
 * (`SCREENS.md` §2.2, восемнадцать кодов `M-01…M-18`).
 *
 * ⚠ Это **проекция, а не второй автомат**. Состояния считает `@sdelka/domain`:
 * сюда приходит уже вычисленный статус транша, статус сделки и статус выплаты,
 * плюс несколько фактов уровня приложения, которых у домена нет и быть не
 * должно (заявлен ли перевод, опознано ли поступление, ждёт ли клиент
 * подтверждения курса). Ни одного правила перехода здесь нет — только ответ на
 * вопрос «как назвать по-человечески то, что уже посчитано».
 *
 * Расхождение, вскрывшееся при сборке: домен знает тринадцать статусов транша,
 * интерфейс обязан различать восемнадцать положений денег. Разница — это не
 * недостача домена, а факты приложения (валюта поступления, референс, заявка на
 * вывод), поэтому проекция и живёт здесь, а не в пакете.
 */
export const MONEY_STATES = [
  'notFunded',
  'transferDeclared',
  'unidentified',
  'heldThirdParty',
  'onAccountFx',
  'onAccount',
  'partiallyFunded',
  'overfunded',
  'reserved',
  'submitted',
  'releasePending',
  'released',
  'payoutUnknown',
  'rollbackInProgress',
  'releasedToAccount',
  'refundInProgress',
  'refunded',
  'frozen',
] as const;

export type MoneyState = (typeof MONEY_STATES)[number];

/** Код из документа. Показывается как данные, а не как текст интерфейса. */
export const MONEY_STATE_CODE: Readonly<Record<MoneyState, string>> = Object.freeze({
  notFunded: 'M-01',
  transferDeclared: 'M-02',
  unidentified: 'M-03',
  heldThirdParty: 'M-04',
  onAccountFx: 'M-05',
  onAccount: 'M-06',
  partiallyFunded: 'M-07',
  overfunded: 'M-08',
  reserved: 'M-09',
  submitted: 'M-10',
  releasePending: 'M-11',
  released: 'M-12',
  payoutUnknown: 'M-13',
  rollbackInProgress: 'M-14',
  releasedToAccount: 'M-15',
  refundInProgress: 'M-16',
  refunded: 'M-17',
  frozen: 'M-18',
});

/**
 * Тон состояния. Цвет — только один из трёх каналов: рядом всегда стоят текст и
 * форма индикатора, иначе дальтоник не отличит «зарезервировано» от «возвращено»
 * (`SCREENS.md` §1.7).
 */
export type StateTone = 'wait' | 'action' | 'ok' | 'warn' | 'danger' | 'info';

export const MONEY_STATE_TONE: Readonly<Record<MoneyState, StateTone>> = Object.freeze({
  notFunded: 'action',
  transferDeclared: 'wait',
  unidentified: 'warn',
  heldThirdParty: 'warn',
  onAccountFx: 'action',
  onAccount: 'info',
  partiallyFunded: 'action',
  overfunded: 'info',
  reserved: 'ok',
  submitted: 'ok',
  releasePending: 'ok',
  released: 'ok',
  payoutUnknown: 'warn',
  rollbackInProgress: 'warn',
  releasedToAccount: 'info',
  refundInProgress: 'wait',
  refunded: 'ok',
  frozen: 'danger',
});

/** Факты приложения, которых нет в домене: они про платёж, а не про транш. */
export interface PaymentFacts {
  /** Клиент сообщил, что отправил перевод, зачисления ещё нет. */
  readonly transferDeclared: boolean;
  /** Поступление пришло без распознанного референса и разбирается вручную. */
  readonly unidentified: boolean;
  /** Деньги на счёте клиента в валюте перевода, конвертация не подтверждена. */
  readonly awaitingConversion: boolean;
  /** Заявка на вывод на счёт-источник отправлена, зачисления в его банке нет. */
  readonly refundDispatched: boolean;
  /** Возврат зачислен в банке клиента. */
  readonly refundArrived: boolean;
}

export interface MoneyStateInput {
  readonly trancheStatus: TrancheStatus;
  readonly dealStatus: DealStatus;
  readonly payoutStatus: PayoutStatus | null;
  readonly requiredMinor: bigint;
  /** Сумма, принятая автоматом под транш: её считает домен. */
  readonly collectedMinor: bigint;
  /** Сумма на свободной части счёта клиента по этой сделке: её считает учёт. */
  readonly creditedMinor: bigint;
  readonly payment: PaymentFacts;
}

export function projectMoneyState(input: MoneyStateInput): MoneyState {
  const { payment } = input;
  switch (input.trancheStatus) {
    case 'pending':
      return 'notFunded';
    case 'collecting': {
      if (payment.unidentified) return 'unidentified';
      if (payment.awaitingConversion) return 'onAccountFx';
      if (input.creditedMinor === 0n) {
        return payment.transferDeclared ? 'transferDeclared' : 'notFunded';
      }
      return 'partiallyFunded';
    }
    case 'collected':
      return input.creditedMinor > input.requiredMinor ? 'overfunded' : 'onAccount';
    case 'release_blocked':
      // Платёж от третьего лица уводится сюда автоматом (¬g_payer_matches):
      // деньги физически пришли, но обязательства перед покупателем из них не
      // возникло, и «баланс» это не он.
      return 'heldThirdParty';
    case 'reserved':
      // Подача документов — состояние **сделки**, а не транша: резерв держится
      // одинаково до и после подачи, меняется только то, чего мы ждём.
      return input.dealStatus === 'filed' || input.dealStatus === 'settling'
        ? 'submitted'
        : 'reserved';
    case 'release_pending':
      return 'releasePending';
    case 'paying_out':
      return input.payoutStatus === 'unknown' ? 'payoutUnknown' : 'releasePending';
    case 'paid_out':
      return 'released';
    case 'refund_pending':
    case 'refunding':
      return 'rollbackInProgress';
    case 'refunded':
      if (payment.refundArrived) return 'refunded';
      return payment.refundDispatched ? 'refundInProgress' : 'releasedToAccount';
    case 'written_off':
      return 'frozen';
    case 'frozen':
      return 'frozen';
  }
}

/**
 * Модификаторы поверх состояния (`SCREENS.md` §2.2). Они не заменяют состояние,
 * а накладываются на него: часы остановлены, курс истёк, реквизиты заперты.
 */
export interface StateModifiers {
  readonly clockPaused: boolean;
  readonly quoteExpired: boolean;
  readonly requisitesLocked: boolean;
  readonly requisitesCooling: boolean;
  readonly coverageBreach: boolean;
}

/**
 * Лестница подтверждения для получающей стороны — `A0…A4` (`SCREENS.md` §2.4).
 * Уровень **не называется гарантией** ни в одном состоянии.
 */
export const ASSURANCE_LEVELS = ['A0', 'A1', 'A2', 'A3', 'A4'] as const;

export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

export function projectAssuranceLevel(state: MoneyState): AssuranceLevel {
  switch (state) {
    case 'notFunded':
    case 'transferDeclared':
    case 'unidentified':
    case 'heldThirdParty':
      return 'A1';
    case 'onAccountFx':
    case 'onAccount':
    case 'partiallyFunded':
    case 'overfunded':
    case 'releasedToAccount':
    case 'refundInProgress':
    case 'refunded':
    case 'rollbackInProgress':
      return 'A2';
    case 'reserved':
    case 'submitted':
    case 'releasePending':
    case 'payoutUnknown':
    case 'frozen':
      return 'A3';
    case 'released':
      return 'A4';
  }
}
