import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  LedgerError,
  LedgerErrorCode,
  accountBalance,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  emptyJournal,
  settleTrancheToClientAccount,
  trancheSettlement,
} from '@sdelka/ledger';
import { rationalFromDecimalString } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import { type Intent, type TrancheEvent, RejectionCode } from '../src/index';
import {
  AMOUNT,
  BUYER,
  BUYER_PARTY_ID,
  CONDITION_ACT,
  DEAL_ID,
  PAYER_CLIENT_KEY,
  RECIPIENT,
  RECIPIENT_CLIENT_KEY,
  RECIPIENT_PARTY_ID,
  TRANCHE_ID,
  context,
} from './support/facts';
import { accept, reject, stateAt } from './support/drive';
import { projectIntents } from './support/ledger-projection';

const settled: TrancheEvent = { type: 'payout_result', outcome: 'settled' };
const FEE_RATE = rationalFromDecimalString('0.005');

function settlementOf(intents: readonly Intent[]) {
  const intent = intents.find((item) => item.type === 'post_settlement_entry');
  if (intent === undefined || intent.type !== 'post_settlement_entry') {
    throw new Error('no settlement intent');
  }
  return intent;
}

/**
 * Красная линия №1 со стороны домена: **получателя расчёта называет акт об
 * условии, и назвать его больше нечем.**
 *
 * До этого получатель был свободным параметром приложения
 * (`TrancheSpec.recipient` в `packages/e2e`), не сверявшимся ни со сторонами
 * сделки, ни с `conditionAct`. Учёт свою половину закрыл — движение
 * обязательства между владельцами он требует подтверждать, — но подтверждение
 * изготавливал тот же вызывающий, который строил проводки, то есть оно ничего
 * не подтверждало. Здесь проверяется, что подтверждение теперь изготавливает
 * автомат и что изготовить его больше негде.
 */
describe('получатель расчёта приходит из акта об условии (ст. 27(2), CORE.md Ф13)', () => {
  it('names the recipient from the act, not from any argument of the caller', () => {
    const paidOut = accept(stateAt('paying_out'), settled, context());
    const settlement = settlementOf(paidOut.intents);
    expect(settlement.recipientClientKey).toBe(RECIPIENT_CLIENT_KEY);
    expect(settlement.payerClientKey).toBe(PAYER_CLIENT_KEY);
    expect(settlement.dealId).toBe(DEAL_ID);
    expect(settlement.trancheId).toBe(TRANCHE_ID);
    // Ссылка на пакет доказательств — та же, под которой ушло поручение.
    expect(settlement.attestation.evidenceRef).toBe('evidence-1');
  });

  it('follows the act when both parties amend it, because there is nowhere else to look', () => {
    const other = { partyId: 'party-seller-2', accountKey: 'ge.passport.seller-2' };
    const ctx = context();
    const amended = accept(
      stateAt('paying_out'),
      {
        type: 'condition_act_amended',
        act: {
          ...CONDITION_ACT,
          recipient: other,
          conditionTextVersion: 'condition.registration_transfer.v2',
        },
        acceptedBy: [BUYER_PARTY_ID, other.partyId],
      },
      ctx,
    );
    // Акт переписан в состоянии; факты обязаны сойтись с ним, иначе редьюсер
    // откажет по `conditionActSubstituted`.
    const after = accept(
      amended.state,
      settled,
      context({
        conditionAct: {
          ...CONDITION_ACT,
          recipient: other,
          conditionTextVersion: 'condition.registration_transfer.v2',
        },
      }),
    );
    expect(settlementOf(after.intents).recipientClientKey).toBe(other.accountKey);
  });

  it('refuses to open the tranche when the act names the buyer as the recipient', () => {
    // Одно лицо по обе стороны (§2.1) и условие, зависящее от воли одной
    // стороны (красная линия №6). Отказ **до денег**: раньше эта сверка стояла
    // только на изменении условия.
    const ctx = context({ conditionAct: { ...CONDITION_ACT, recipient: BUYER } });
    const error = reject(stateAt('pending'), { type: 'instructions_issued' }, ctx);
    expect(error.code).toBe(RejectionCode.guardFailed);
    expect(error.failedGuards).toContain('g_condition_agreed');
  });

  it('hands the ledger an attestation it accepts, and the ledger writes the obligation', () => {
    const paidOut = accept(stateAt('paying_out'), settled, context());
    const journal = projectIntents(emptyJournal, paidOut.intents, { feeRate: FEE_RATE });
    const payer = clientKey(PAYER_CLIENT_KEY);
    const recipient = clientKey(RECIPIENT_CLIENT_KEY);
    // Обязательство перед получателем **возникло**, и ровно на нетто.
    const fee = AMOUNT.minor / 200n;
    expect(accountBalance(journal, clientFreeAccount(recipient), 'GEL').minor).toBe(
      AMOUNT.minor - fee,
    );
    expect(accountBalance(journal, clientLockedAccount(payer, DEAL_ID, TRANCHE_ID), 'GEL').minor)
      .toBe(-AMOUNT.minor);
  });

  it('does not let one tranche settlement be paid with another tranche attestation', () => {
    // Подтверждение выдаётся на конкретную сделку, транш и пару сторон. Взять
    // его у соседнего транша нельзя — а больше взять негде: построить значение
    // этого типа кодом невозможно.
    const foreign = settlementOf(
      accept(
        stateAt('paying_out'),
        settled,
        { ...context(), dealId: 'deal-2', trancheId: 'tranche-2' },
      ).intents,
    ).attestation;
    const payer = clientKey(PAYER_CLIENT_KEY);
    const recipient = clientKey(RECIPIENT_CLIENT_KEY);
    let thrown: unknown = null;
    try {
      settleTrancheToClientAccount(
        { id: 'e1', occurredAt: '2026-09-03T12:00:00Z' },
        trancheSettlement({ dealId: DEAL_ID, trancheId: TRANCHE_ID }, payer, recipient, foreign),
        AMOUNT,
        null,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LedgerError);
    expect((thrown as LedgerError).code).toBe(LedgerErrorCode.settlementAttestationMismatch);
  });

  it('substituting the recipient at the ledger call breaks the attestation', () => {
    // Проекция получателя не выбирает, но даже если бы приложение подставило
    // своего — подтверждение выдано не на него, и учёт запись не соберёт.
    const settlement = settlementOf(accept(stateAt('paying_out'), settled, context()).intents);
    let thrown: unknown = null;
    try {
      trancheSettlement(
        { dealId: DEAL_ID, trancheId: TRANCHE_ID },
        clientKey(PAYER_CLIENT_KEY),
        clientKey('ge.passport.stranger-1'),
        settlement.attestation,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LedgerError);
    expect((thrown as LedgerError).code).toBe(LedgerErrorCode.settlementAttestationMismatch);
  });

  it('keeps exactly one place in the domain where an attestation can be minted', () => {
    // Структурное свойство, а не обещание. `DealPartiesAttestation` невозможно
    // построить кодом — только привести тип, — поэтому число мест с приведением
    // и есть число мест, где подтверждение изготавливается. Их обязано быть
    // одно, и оно обязано быть в автомате транша: подтверждение, которое можно
    // выписать где угодно, не подтверждает ничего.
    const root = join(import.meta.dirname, '..', 'src');
    const found: string[] = [];
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.ts')) continue;
      const source = readFileSync(join(root, name), 'utf8');
      if (source.includes('as unknown as')) found.push(name);
    }
    // Мест чеканки два, по одному на ambient-тип: подтверждение сторон
    // (`tranche.ts`) и разрешение внутреннего движения (`allocation.ts`,
    // И12.4). Больше приведений в домене нет ни одного, и каждое — единственное
    // для своего типа.
    expect(found).toEqual(['allocation.ts', 'tranche.ts']);
    const tranche = readFileSync(join(root, 'tranche.ts'), 'utf8');
    expect(tranche.split('as unknown as DealPartiesAttestation').length - 1).toBe(1);
    const allocation = readFileSync(join(root, 'allocation.ts'), 'utf8');
    expect(allocation.split('as unknown as AllocationAuthorization').length - 1).toBe(1);
    // И функция, которая его изготавливает, наружу не выходит: ни из модуля,
    // ни из пакета.
    expect(tranche).toContain('function trancheSettlementAttestation(');
    expect(tranche).not.toContain('export function trancheSettlementAttestation(');
  });

  it('names the recipient party and the account key as one value', () => {
    // Половин у ссылки на сторону нет: акт, назвавший сторону без счёта или
    // счёт без стороны, не открывает приём средств.
    expect(CONDITION_ACT.recipient).toEqual({
      partyId: RECIPIENT_PARTY_ID,
      accountKey: RECIPIENT_CLIENT_KEY,
    });
    expect(RECIPIENT.accountKey).not.toBe(BUYER.accountKey);
  });
});
