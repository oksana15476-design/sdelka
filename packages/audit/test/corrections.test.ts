import { describe, expect, it } from 'vitest';
import { appendRecord, correctionsOf, effectiveView, verifyChain } from '../src/index';
import { DEAL, OPERATOR, TRANCHE, at, dossierChain, source } from './support/fixtures';

describe('исправление — только новой записью', () => {
  it('исходная запись остаётся в цепочке и остаётся видимой', () => {
    const chain = dossierChain();
    const view = effectiveView(chain, 'rec-evidence');
    expect(view?.original.recordId).toBe('rec-evidence');
    expect(view?.original.body.kind).toBe('evidence_attached');
    expect(view?.corrections.map((item) => item.recordId)).toEqual(['rec-fix']);
    // Обе записи на месте: исправление ничего не удалило и не переписало.
    expect(chain.records.filter((item) => item.recordId === 'rec-evidence')).toHaveLength(1);
    expect(verifyChain(chain).intact).toBe(true);
  });

  it('исправление исправления выстраивается в порядке цепочки', () => {
    let chain = dossierChain();
    chain = appendRecord(chain, {
      recordId: 'rec-fix-2',
      recordedAt: at(9),
      actor: OPERATOR,
      subject: TRANCHE,
      related: [DEAL],
      body: {
        kind: 'correction',
        correctsRecordId: 'rec-fix',
        reasonKey: 'correction.superseded',
        basis: source(9, 'operator_note', 'sdelka.console'),
        attributes: { provider: 'registry-central' },
      },
    });
    expect(correctionsOf(chain, 'rec-evidence').map((item) => item.recordId)).toEqual([
      'rec-fix',
      'rec-fix-2',
    ]);
  });

  it('у записи без исправлений набор пуст, а не отсутствует', () => {
    expect(correctionsOf(dossierChain(), 'rec-order')).toEqual([]);
  });

  it('представления несуществующей записи нет', () => {
    expect(effectiveView(dossierChain(), 'rec-missing')).toBeNull();
  });
});
