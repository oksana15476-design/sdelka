import { describe, expect, it } from 'vitest';
import { type AuditRecord, auditRef, sameRef, verifyChain } from '@sdelka/audit';
import {
  type Authority,
  type DisclosureCapability,
  type World,
  DISCLOSURE_POLICY_DEFAULT,
  PERSONAL_FIELDS,
  PLATFORM_SUBJECT,
  authorize,
  correctPayoutReason,
  emptyWorld,
  notePartyCardOpened,
  releaseDocument,
  revealPersonalFields,
} from '@sdelka/app';
import { type Actor, STAFF, acting, login } from './support/actors';
import { NOW, OPERATOR_NOTE_SOURCE } from './support/fixtures';

/**
 * Инвариант 24 целиком, а не наполовину.
 *
 * Обещание `FUNCTIONAL.md` («просмотр документа и персональных данных
 * логируется») держалось механизмом без дороги: вид записи `personal_data_viewed`
 * объявлен, тело описано, метка в базе заведена — и ни одна строка продукта
 * такую запись не строила. Это не внутренняя дисциплина, а обязанность перед
 * субъектом персональных данных: пока пишущего нет, ответить на запрос «кто
 * смотрел мои документы» нечем.
 *
 * ⚠ Что именно считать просмотром — открытие карточки, раскрытие поля или
 * выгрузку файла — остаётся **[открыто]** за владельцем (`DECISIONS-REVIEW.md`
 * §H5). Здесь проверяется пересечение всех трёх трактовок: выгрузка файла и
 * раскрытие поля по явному действию. Широкая трактовка (открытие карточки)
 * проверяется отдельно — вместе с тем, что по умолчанию она выключена.
 */

const CHAIN = 'chain-disclosure';
const PARTY = 'party-buyer';
const DOCUMENT = 'document-contract-1';
const PURPOSE = 'disclosure.purpose.deal_support';

/** Владелец: из прав на чтение у него ровно `read_deal`, персональных прав нет. */
const PRINCIPAL: Actor = Object.freeze({
  key: 'principal',
  roleId: 'principal',
  accountId: 'owner-1',
  personId: 'person-owner-1',
});

function world(): World {
  return emptyWorld({ now: NOW, chainId: CHAIN });
}

function disclosures(scene: World): readonly AuditRecord[] {
  return scene.chain.records.filter((record) => record.body.kind === 'personal_data_viewed');
}

function onlyDisclosure(scene: World): AuditRecord {
  const found = disclosures(scene);
  expect(found).toHaveLength(1);
  const record = found[0];
  if (record === undefined) throw new Error('test.no_disclosure');
  return record;
}

/* ------------------------------------------------------------------------- */

describe('инвариант 24: просмотр персональных данных попадает в журнал', () => {
  it('полномочия нет — разрешения нет, записи нет, документ не отдан', () => {
    const scene = world();
    const session = login(scene, PRINCIPAL);
    const before = session.world.chain.records.length;

    const decided = authorize(session.world, session.sessionId, 'read_party', PLATFORM_SUBJECT);

    expect(decided.ok).toBe(false);
    // Дальше идти не с чем: `releaseDocument` принимает `Authority`, и собрать
    // его литералом нельзя. Значит отказ в полномочии — это и отсутствие
    // записи, и отсутствие выдачи одновременно, а не два разных решения.
    expect(session.world.chain.records).toHaveLength(before);
    expect(disclosures(session.world)).toHaveLength(0);
  });

  it('полномочие есть — документ отдан и запись появилась ровно одна', () => {
    const step = acting(world(), 'read_party', PLATFORM_SUBJECT, STAFF.operator);
    let delivered = 0;

    const released = releaseDocument(
      step.world,
      {
        partyId: PARTY,
        documentId: DOCUMENT,
        purposeKey: PURPOSE,
        fields: ['name', 'document_number'],
      },
      step.authority,
      () => {
        delivered += 1;
        return 'bytes';
      },
    );

    expect(delivered).toBe(1);
    expect(released.released).toBe('bytes');
    const record = onlyDisclosure(released.world);
    expect(record.body.kind).toBe('personal_data_viewed');
    expect(record.subject.scope).toBe('party');
    expect(record.subject.id).toBe(PARTY);
    // Смотрящий — актор записи, и назвать его вызывающий не может: он выведен
    // из сессии (`journalActor`).
    expect(record.actor.actorId).toBe(STAFF.operator.accountId);
    expect(record.actor.roleId).toBe('operator');
    expect(record.actor.capability).toBe('read_party');
    // Что именно было отдано — ссылкой, а не содержимым.
    const document = auditRef('document', DOCUMENT);
    expect(record.related.some((ref) => sameRef(ref, document))).toBe(true);
    expect(verifyChain(released.world.chain).intact).toBe(true);
  });

  it('в теле записи нет персональных данных — только ключи полей и основание', () => {
    const step = acting(world(), 'read_party', PLATFORM_SUBJECT, STAFF.operator);
    const released = releaseDocument(
      step.world,
      {
        partyId: PARTY,
        documentId: DOCUMENT,
        purposeKey: PURPOSE,
        fields: ['name', 'account', 'phone'],
      },
      step.authority,
      () => null,
    );

    const body = onlyDisclosure(released.world).body;
    if (body.kind !== 'personal_data_viewed') throw new Error('test.wrong_body');
    // Полей в теле ровно три, и ни одно из них не несёт значения.
    expect(Object.keys(body).sort()).toEqual(['fields', 'kind', 'purposeKey']);
    expect(body.purposeKey).toBe(PURPOSE);
    for (const field of body.fields) {
      expect(PERSONAL_FIELDS).toContain(field);
    }
  });

  it('повтор просмотра — вторая запись, а не идемпотентность: это журнал', () => {
    const first = acting(world(), 'read_party', PLATFORM_SUBJECT, STAFF.operator);
    const request = {
      partyId: PARTY,
      documentId: DOCUMENT,
      purposeKey: PURPOSE,
      fields: ['name'],
    } as const;
    const once = releaseDocument(first.world, request, first.authority, () => null);

    const second = acting(once.world, 'read_party', PLATFORM_SUBJECT, STAFF.operator);
    const twice = releaseDocument(second.world, request, second.authority, () => null);

    const found = disclosures(twice.world);
    expect(found).toHaveLength(2);
    expect(found[0]?.recordId).not.toBe(found[1]?.recordId);
    expect(verifyChain(twice.world.chain).intact).toBe(true);
  });

  it('раскрытие поля по явному действию пишется тем же путём', () => {
    const step = acting(world(), 'read_beneficiary', PLATFORM_SUBJECT, STAFF.operator);
    const revealed = revealPersonalFields(
      step.world,
      { partyId: PARTY, purposeKey: PURPOSE, fields: ['account'] },
      step.authority,
      () => 'GE00XX',
    );

    const body = onlyDisclosure(revealed.world).body;
    if (body.kind !== 'personal_data_viewed') throw new Error('test.wrong_body');
    expect(body.fields).toEqual(['account']);
    expect(revealed.released).toBe('GE00XX');
  });
});

describe('широкая трактовка §H5 выключена по умолчанию', () => {
  it('открытие карточки при умолчании записи не создаёт', () => {
    const step = acting(world(), 'read_party', PLATFORM_SUBJECT, STAFF.operator);
    const next = notePartyCardOpened(
      step.world,
      { partyId: PARTY, purposeKey: PURPOSE, fields: ['name'] },
      step.authority,
      DISCLOSURE_POLICY_DEFAULT,
    );

    expect(DISCLOSURE_POLICY_DEFAULT.logCardOpened).toBe(false);
    expect(disclosures(next)).toHaveLength(0);
    expect(next).toBe(step.world);
  });

  it('включённая настройка пишет запись того же вида', () => {
    const step = acting(world(), 'read_party', PLATFORM_SUBJECT, STAFF.operator);
    const next = notePartyCardOpened(
      step.world,
      { partyId: PARTY, purposeKey: PURPOSE, fields: ['name'] },
      step.authority,
      { logCardOpened: true },
    );

    expect(onlyDisclosure(next).subject.id).toBe(PARTY);
  });

  it('полномочие проверяется до ветвления по настройке', () => {
    const step = acting(world(), 'create_deal', PLATFORM_SUBJECT, STAFF.operator);
    const wrong = step.authority as unknown as Authority<DisclosureCapability>;

    expect(() =>
      notePartyCardOpened(
        step.world,
        { partyId: PARTY, purposeKey: PURPOSE, fields: ['name'] },
        wrong,
        DISCLOSURE_POLICY_DEFAULT,
      ),
    ).toThrow(/app\.authority\.wrong_origin/u);
  });
});

describe('запись о просмотре только дописывается', () => {
  it('чужое полномочие не пускает к выдаче и к записи', () => {
    const step = acting(world(), 'create_deal', PLATFORM_SUBJECT, STAFF.operator);
    const wrong = step.authority as unknown as Authority<DisclosureCapability>;
    let delivered = 0;

    expect(() =>
      releaseDocument(
        step.world,
        { partyId: PARTY, documentId: DOCUMENT, purposeKey: PURPOSE, fields: ['name'] },
        wrong,
        () => {
          delivered += 1;
          return null;
        },
      ),
    ).toThrow(/app\.authority\.wrong_origin/u);
    expect(delivered).toBe(0);
    expect(disclosures(step.world)).toHaveLength(0);
  });

  it('исправить запись о просмотре нечем — корень не исход выплаты', () => {
    const step = acting(world(), 'read_party', PLATFORM_SUBJECT, STAFF.operator);
    const released = releaseDocument(
      step.world,
      { partyId: PARTY, documentId: DOCUMENT, purposeKey: PURPOSE, fields: ['name'] },
      step.authority,
      () => null,
    );
    const record = onlyDisclosure(released.world);

    const correcting = acting(
      released.world,
      'record_bank_outcome',
      PLATFORM_SUBJECT,
      STAFF.operator,
    );

    expect(() =>
      correctPayoutReason(
        correcting.world,
        {
          correctsRecordId: record.recordId,
          reasonKey: 'correction.mistake',
          basis: OPERATOR_NOTE_SOURCE,
          statedReasonKey: 'payout.partner_confirmed',
        },
        correcting.authority,
      ),
    ).toThrow(/app\.correction\.kind_not_correctable:personal_data_viewed/u);
  });

  it('основание обязательно, поле — только из закрытого перечня, повтор поля отвергается', () => {
    const step = acting(world(), 'read_party', PLATFORM_SUBJECT, STAFF.operator);
    const base = { partyId: PARTY, documentId: DOCUMENT, purposeKey: PURPOSE } as const;

    expect(() =>
      releaseDocument(
        step.world,
        { ...base, purposeKey: '', fields: ['name'] },
        step.authority,
        () => null,
      ),
    ).toThrow(/app\.disclosure\.purpose_required/u);

    expect(() =>
      releaseDocument(
        step.world,
        { ...base, fields: ['Иванов Иван' as never] },
        step.authority,
        () => null,
      ),
    ).toThrow(/app\.disclosure\.unknown_field/u);

    expect(() =>
      releaseDocument(
        step.world,
        { ...base, fields: ['name', 'name'] },
        step.authority,
        () => null,
      ),
    ).toThrow(/app\.disclosure\.duplicate_field/u);
  });
});
