import { describe, expect, it } from 'vitest';
import {
  type AuditRecord,
  auditRef,
  correctionsOf,
  effectiveView,
  logSafeRecord,
  reconstructPayout,
  verifyChain,
} from '@sdelka/audit';
import { payoutIdempotencyKey } from '@sdelka/domain';
import {
  CORRECTED_FIELD,
  type CorrectionRequest,
  type World,
  effectivePayoutReasonKey,
  trancheOptions,
} from '@sdelka/app';
import { STAFF } from './support/actors';
import { applyTrancheEvent, correctPayoutReason } from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  OPERATOR_NOTE_SOURCE,
  POLICY_VERSION,
  bankPort,
  settledOutcome,
} from './support/fixtures';
import { toPayingOut } from './support/paths';

const DEAL = 'deal-correction';
const TRANCHE = 'tranche-correction';

/** Ключ, которым оператор ошибочно классифицировал подтверждённый платёж. */
const MISTAKEN = 'payout.partner_batch_delayed';
/** Ключ, которым он должен был его классифицировать. */
const CORRECTED = 'payout.partner_confirmed';

/**
 * Красная линия №11 целиком, а не наполовину.
 *
 * Запрет («журнал не редактируется») держался и до этого сценария: менять
 * запись в `@sdelka/audit` нечем, база отбирает `UPDATE`/`DELETE` у роли
 * приложения. А предписанное той же линией средство — «исправление только новой
 * записью со ссылкой на предыдущую» — не порождалось ни одной строкой продукта:
 * тело `CorrectionBody`, проверки цепочки, ветвь триггера, `correctionsOf` и
 * включение в досье существовали, вызывающего не было. Журнал был не
 * «неизменяемый и исправляемый», а просто неисправимый.
 *
 * Сценарий отказа воспроизводится здесь в сильной форме: исход `settled`
 * терминален (`TERMINAL_PAYOUT_STATUSES`), исходящих рёбер у него нет, второй
 * записи по этой выплате не будет никогда. Ошибочный ключ причины оставался бы
 * в вечном журнале без пометки, а `reconstructPayout` отдавал бы его как
 * действующий.
 */
async function paidOut(): Promise<{ world: World; result: AuditRecord }> {
  const path = await toPayingOut({ dealId: DEAL, trancheId: TRANCHE });
  const bank = bankPort({ outcomes: [settledOutcome()], reconciliation: null });
  const outcome = bank.outcomeFor(payoutIdempotencyKey(TRANCHE));
  expect(outcome.outcome).toBe('settled');
  const world = applyTrancheEvent(
    path.world,
    TRANCHE,
    { type: 'payout_result', outcome: 'settled' },
    // Ключ причины — операторский ввод, и вот он введён неверно.
    trancheOptions(POLICY_VERSION, {
      payoutResponse: BANK_RESPONSE_SOURCE,
      payoutReasonKey: MISTAKEN,
    }),
  ).world;
  const result = world.chain.records.find((item) => item.body.kind === 'payout_result');
  if (result === undefined) {
    expect.unreachable();
    throw new Error('unreachable');
  }
  return { world, result };
}

function request(correctsRecordId: string, statedReasonKey: string = CORRECTED) {
  return {
    correctsRecordId,
    reasonKey: 'correction.reason_key_misclassified',
    basis: OPERATOR_NOTE_SOURCE,
    statedReasonKey,
  };
}

describe('исправление записи журнала — новой записью со ссылкой на предыдущую', () => {
  it('исправление доходит до журнала и проверяется цепочкой', async () => {
    const { world, result } = await paidOut();
    if (result.body.kind !== 'payout_result') {
      expect.unreachable();
      return;
    }
    expect(result.body.reasonKey).toBe(MISTAKEN);
    const lengthBefore = world.chain.records.length;

    const corrected = correctPayoutReason(world, TRANCHE, request(result.recordId));

    // Дописано ровно одно звено, и цепочка после него сходится: хеши, сцепка,
    // нумерация, монотонность времени. Проверка идёт из самого пакета аудита, а
    // не из утверждения сценария.
    expect(corrected.chain.records).toHaveLength(lengthBefore + 1);
    expect(verifyChain(corrected.chain).intact).toBe(true);

    const fix = corrected.chain.records[corrected.chain.records.length - 1];
    expect(fix?.body.kind).toBe('correction');
    if (fix?.body.kind !== 'correction') {
      expect.unreachable();
      return;
    }
    // Ссылка на исправляемую запись — и она ведёт именно в неё.
    expect(fix.body.correctsRecordId).toBe(result.recordId);
    // Причина — ключом, а не текстом; основание — сырым ответом, а не пересказом.
    expect(fix.body.reasonKey).toBe('correction.reason_key_misclassified');
    expect(fix.body.basis.sourceKind).toBe('operator_note');
    expect(fix.body.basis.digest).toBe(OPERATOR_NOTE_SOURCE.digest);
    expect(fix.body.attributes).toEqual({
      field: CORRECTED_FIELD,
      recorded: MISTAKEN,
      stated: CORRECTED,
    });
    // Исправление стоит там же, где исправляемая запись: искать его будут по
    // предмету.
    expect(fix.subject).toEqual(result.subject);

    // Собирается как исправление к этой записи, а не как отдельная запись рядом.
    expect(correctionsOf(corrected.chain, result.recordId).map((item) => item.recordId)).toEqual([
      fix.recordId,
    ]);

    // И попадает в досье по выплате — то самое, которым аудитор отвечает на
    // «на основании какого документа и что запись не правилась задним числом».
    const dossier = reconstructPayout(
      corrected.chain,
      [],
      auditRef('payout', payoutIdempotencyKey(TRANCHE)),
    );
    expect(dossier.integrity.intact).toBe(true);
    expect(dossier.corrections.map((item) => item.recordId)).toEqual([fix.recordId]);
    // Основание исправления — материал досье наравне с основанием решения.
    expect(dossier.evidence.map((item) => item.sourceKind)).toContain('operator_note');
  });

  it('исходная запись после исправления читается прежней', async () => {
    const { world, result } = await paidOut();
    const before = logSafeRecord(result);

    const corrected = correctPayoutReason(world, TRANCHE, request(result.recordId));

    const after = corrected.chain.records.filter((item) => item.recordId === result.recordId);
    // Ровно одна: исправление не удалило и не размножило исходную.
    expect(after).toHaveLength(1);
    const kept = after[0];
    if (kept === undefined || kept.body.kind !== 'payout_result') {
      expect.unreachable();
      return;
    }
    // Байт в байт, включая хеш записи: ни одно поле не переписано.
    expect(logSafeRecord(kept)).toEqual(before);
    expect(kept.recordHash).toBe(result.recordHash);
    // Ошибочный ключ **остался** в записи. Действующее представление — это
    // исходная запись плюс исправления к ней, а не подмена исходной.
    expect(kept.body.reasonKey).toBe(MISTAKEN);
    const view = effectiveView(corrected.chain, result.recordId);
    expect(view?.original.recordHash).toBe(result.recordHash);
    expect(view?.corrections).toHaveLength(1);
    // Действующим при этом считается исправленное значение: «исходная запись
    // плюс исправления к ней» — отдельный ответ, а не подмена записи.
    expect(effectivePayoutReasonKey(world, result.recordId)).toBe(MISTAKEN);
    expect(effectivePayoutReasonKey(corrected, result.recordId)).toBe(CORRECTED);

    // И выведенный ответ досье исправлением не сдвинут: `result` — по-прежнему
    // исходная запись, а не пометка на ней.
    const dossier = reconstructPayout(
      corrected.chain,
      [],
      auditRef('payout', payoutIdempotencyKey(TRANCHE)),
    );
    expect(dossier.result?.recordId).toBe(result.recordId);
  });

  it('исправление без ссылки на существующую запись невозможно', async () => {
    const { world } = await paidOut();
    expect(() => correctPayoutReason(world, TRANCHE, request('rec-does-not-exist'))).toThrow(
      /app\.correction\.target_missing/u,
    );

    // Ссылки нет вовсе — не собирается: обязательна типом (красная линия №11).
    // @ts-expect-error — исправление без `correctsRecordId`
    const withoutRef: CorrectionRequest = {
      reasonKey: 'correction.reason_key_misclassified',
      basis: OPERATOR_NOTE_SOURCE,
      statedReasonKey: CORRECTED,
    };
    expect(withoutRef.reasonKey.length).toBeGreaterThan(0);
  });

  it('исправление без причины и без основания невозможно', async () => {
    const { world, result } = await paidOut();
    expect(() =>
      correctPayoutReason(world, TRANCHE, {
        ...request(result.recordId),
        reasonKey: '',
      }),
    ).toThrow(/app\.correction\.reason_required/u);

    expect(() =>
      correctPayoutReason(world, TRANCHE, {
        ...request(result.recordId),
        statedReasonKey: '',
      }),
    ).toThrow(/app\.correction\.stated_reason_required/u);

    // Основания нет вовсе — не собирается: обязательно типом. `CORE.md` Ф11 —
    // разобранные поля без исходника суд не убедит.
    // @ts-expect-error — исправление без `basis`
    const withoutBasis: CorrectionRequest = {
      correctsRecordId: result.recordId,
      reasonKey: 'correction.reason_key_misclassified',
      statedReasonKey: CORRECTED,
    };
    expect(withoutBasis.reasonKey.length).toBeGreaterThan(0);
  });

  it('исправление от чужого имени невозможно: автор берётся из сессии', async () => {
    const { world, result } = await paidOut();

    // Поля «кем» у заявки нет и не может быть: назвать автора нечем.
    const named: CorrectionRequest = {
      ...request(result.recordId),
      // @ts-expect-error — актора аргументом шаг не принимает: он из сессии
      actor: 'approver-1',
    };
    expect(named.correctsRecordId).toBe(result.recordId);

    const corrected = correctPayoutReason(world, TRANCHE, request(result.recordId), STAFF.operator);
    const fix = corrected.chain.records[corrected.chain.records.length - 1];
    // В журнале — учётная запись вошедшего и полномочие, под которым он
    // действовал, а не то, что он о себе сообщил.
    expect(fix?.actor.actorId).toBe(STAFF.operator.accountId);
    expect(fix?.actor.roleId).toBe('operator');
    expect(fix?.actor.capability).toBe('record_bank_outcome');

    // Лицо без этого полномочия исправить не может: отказ выдаёт `authorize`,
    // то же решение, что в продукте.
    expect(() =>
      correctPayoutReason(world, TRANCHE, request(result.recordId), STAFF.analyst),
    ).toThrow(/e2e\.session\.denied|app\.authority\.denied/u);
    expect(() =>
      correctPayoutReason(world, TRANCHE, request(result.recordId), STAFF.controller),
    ).toThrow(/e2e\.session\.denied|app\.authority\.denied/u);
  });

  it('исправляется сказанное, а не сделанное: решение человека этим путём не трогается', async () => {
    const { world, result } = await paidOut();
    const decision = world.chain.records.find((item) => item.body.kind === 'decision_made');
    expect(decision).toBeDefined();
    // Решение — действие, а не высказывание о мире: оно двигало состояние и
    // деньги. Пометка на полях его не отменяет, и путь к ней закрыт.
    expect(() =>
      correctPayoutReason(world, TRANCHE, request(decision?.recordId ?? 'rec-none')),
    ).toThrow(/app\.correction\.kind_not_correctable:decision_made/u);
    // Поручение на выплату — тоже не высказывание.
    const ordered = world.chain.records.find((item) => item.body.kind === 'payout_ordered');
    expect(() =>
      correctPayoutReason(world, TRANCHE, request(ordered?.recordId ?? 'rec-none')),
    ).toThrow(/app\.correction\.kind_not_correctable:payout_ordered/u);

    // И исправление, ничего не меняющее, — шум в вечном журнале.
    expect(() =>
      correctPayoutReason(world, TRANCHE, request(result.recordId, MISTAKEN)),
    ).toThrow(/app\.correction\.is_noop/u);
  });

  it('описка в самой пометке исправима: исправление исправления встаёт в цепочку', async () => {
    const { world, result } = await paidOut();
    const once = correctPayoutReason(world, TRANCHE, request(result.recordId));
    const first = once.chain.records[once.chain.records.length - 1];
    if (first === undefined) {
      expect.unreachable();
      return;
    }

    const twice = correctPayoutReason(
      once,
      TRANCHE,
      request(first.recordId, 'payout.partner_confirmed_manually'),
    );
    const second = twice.chain.records[twice.chain.records.length - 1];

    expect(verifyChain(twice.chain).intact).toBe(true);
    // Порядок цепочки: исправление исправления идёт после исправляемого, и оба
    // видны как исправления исходной записи.
    expect(correctionsOf(twice.chain, result.recordId).map((item) => item.recordId)).toEqual([
      first.recordId,
      second?.recordId,
    ]);
    if (second?.body.kind !== 'correction') {
      expect.unreachable();
      return;
    }
    // Отменяемое значение взято из прежней пометки, а не из исходной записи.
    expect(second.body.attributes['recorded']).toBe(CORRECTED);
    // Обе прежние записи на месте, ни одна не переписана.
    expect(twice.chain.records.filter((item) => item.recordId === result.recordId)).toHaveLength(1);
    expect(twice.chain.records.filter((item) => item.recordId === first.recordId)).toHaveLength(1);
    // Действующим считается последнее по цепочке.
    expect(effectivePayoutReasonKey(twice, result.recordId)).toBe('payout.partner_confirmed_manually');
  });
});
