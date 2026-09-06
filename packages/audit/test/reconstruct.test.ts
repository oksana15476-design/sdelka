import { describe, expect, it } from 'vitest';
import { logSafeRecord, reconstructPayout, verifyChain } from '../src/index';
import {
  COMPLIANCE_POLICY,
  LEGAL_POLICY,
  PAYOUT,
  PAYOUT_POLICY,
  anchorAt,
  dossierChain,
  replaceRecord,
} from './support/fixtures';

/**
 * Критерий приёмки И7.2 целиком: «по любой выплате восстанавливается, на
 * основании какого документа, кем и когда принято решение, по каким правилам, и
 * что запись не правилась задним числом».
 */
describe('досье по выплате', () => {
  const chain = dossierChain();
  const head = chain.records[chain.records.length - 1];
  const anchors = head === undefined ? [] : [anchorAt(head, 60)];
  const dossier = reconstructPayout(chain, anchors, PAYOUT);

  it('дано: выплата совершена — тогда доступен сырой ответ источника', () => {
    const kinds = dossier.evidence.map((item) => item.sourceKind);
    expect(kinds).toContain('payment_provider_response');
    expect(kinds).toContain('registry_extract');
    expect(kinds).toContain('condition_act');
    // Ссылка ведёт в хранилище и связана с байтами отпечатком, а не пересказом.
    for (const item of dossier.evidence) {
      expect(item.digest).toHaveLength(64);
      expect(item.storageRef.length).toBeGreaterThan(0);
    }
  });

  it('дано: решение принято — тогда видно, кем и когда', () => {
    expect(dossier.decisions).toHaveLength(1);
    const [first] = dossier.decisions;
    expect(first?.actor.actorId).toBe('analyst-1');
    expect(first?.actor.roleId).toBe('compliance_analyst');
    expect(first?.recordedAt).toBe(chain.records[2]?.recordedAt);
    // И кто распорядился выплатой — отдельно от того, кто её разрешил.
    expect(dossier.ordered?.actor.roleId).toBe('financial_controller');
  });

  it('дано: решение принято — тогда оно хранит версию применённой политики', () => {
    expect(dossier.policies).toContain(COMPLIANCE_POLICY);
    expect(dossier.policies).toContain(PAYOUT_POLICY);
    // Редакция текста условия на момент акта получателя (Ф13).
    expect(dossier.policies).toContain(LEGAL_POLICY);
  });

  it('дано: решение принято — тогда есть внешняя метка времени', () => {
    expect(dossier.independentTime).toHaveLength(1);
    expect(dossier.independentTime[0]?.provider).toBe('tsa-independent');
    expect(dossier.independentTime[0]?.digest).toBe(dossier.ordered?.recordHash);
  });

  it('дано: запись создана — тогда она в цепочке, и якорь фиксирует состояние', () => {
    expect(dossier.integrity.intact).toBe(true);
    expect(dossier.anchors.anchoredThroughSeq).toBe(chain.records.length - 1);
    expect(dossier.anchors.unanchoredTail).toBe(0);
    expect(dossier.anchors.brokenAnchors).toEqual([]);
  });

  it('акт получателя об условии попадает в досье, хотя выплата на него не ссылается', () => {
    const kinds = dossier.records.map((item) => item.body.kind);
    expect(kinds).toContain('condition_act_recorded');
    expect(kinds).toContain('decision_made');
    expect(kinds).toContain('payout_ordered');
    expect(kinds).toContain('payout_result');
  });

  it('исправление видно как отдельная запись, исходная — на месте', () => {
    expect(dossier.corrections.map((item) => item.recordId)).toEqual(['rec-fix']);
    expect(dossier.records.map((item) => item.recordId)).toContain('rec-evidence');
  });

  it('досье выдаётся и по порванной цепочке, но с точным местом разрыва', () => {
    const forged = replaceRecord(chain, 2, (record) =>
      Object.freeze({
        ...record,
        body: { ...record.body, outcomeKey: 'block' } as typeof record.body,
      }),
    );
    const broken = reconstructPayout(forged, anchors, PAYOUT);
    expect(broken.decisions).toHaveLength(1);
    expect(broken.integrity.intact).toBe(false);
    if (broken.integrity.intact) {
      expect.unreachable();
      return;
    }
    expect(broken.integrity.firstBreak.index).toBe(2);
    expect(broken.integrity.firstBreak.recordId).toBe('rec-decision');
    expect(broken.integrity.firstBreak.kind).toBe('hash_mismatch');
  });

  it('досье по несуществующей выплате пусто, а не собрано из чужого', () => {
    const empty = reconstructPayout(chain, anchors, {
      kind: 'ref',
      scope: 'payout',
      id: 'payout-404',
    } as typeof PAYOUT);
    expect(empty.records).toEqual([]);
    expect(empty.evidence).toEqual([]);
    expect(empty.ordered).toBeNull();
  });

  it('вся цепочка сериализуется без потери сумм и без персональных данных', () => {
    const serialized = JSON.stringify(chain.records.map(logSafeRecord));
    // Сумма пережила сериализацию как строка, а не как число с точкой.
    expect(serialized).toContain('"minor":"125000"');
    expect(serialized).not.toContain('e+');
    // Ни одной подстроки, похожей на реквизиты или номер документа.
    expect(serialized).not.toMatch(/[A-Z]{2}\d{2}[A-Z0-9]{11,30}/u);
    expect(verifyChain(chain).intact).toBe(true);
  });
});
