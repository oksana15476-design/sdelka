import { describe, expect, it } from 'vitest';
import {
  AUDIT_PRIMARY_METHODS,
  AUDIT_RECORD_KINDS,
  AUDIT_SECOND_FACTOR_KINDS,
  type AuditBody,
  AuditErrorCode,
  type RoleChangedBody,
  type SessionDeniedBody,
  type SessionEstablishedBody,
  type SettingChangedBody,
  appendRecord,
  auditFingerprint,
  auditInstant,
  auditRef,
  auditToken,
  policyRef,
  verifyChain,
} from '../src/index';
import {
  DEAL,
  FOREIGN_HASH,
  OPERATOR,
  SYSTEM,
  at,
  expectAuditError,
  fp,
  newChain,
  source,
} from './support/fixtures';

/**
 * События безопасности и изменения настроек.
 *
 * До этих видов журнал описывал деньги, решения и просмотр персональных данных.
 * Вход, отказ во входе, смена роли и изменение настройки не описывались ни
 * одним видом: `packages/auth` порождал события, которым было некуда лечь, а
 * управляемые настройки (тариф, наценка, пороги) двигали бы деньги мимо
 * журнала. Красная линия №11 распространяется и на них.
 */

const ACCOUNT = auditRef('account', 'acc-fc-1');
const SETTING = auditRef('setting', 'fx.markup.eur_gel');
const DEVICE = auditFingerprint('device', fp(0x51));
const NETWORK = auditFingerprint('network_address', fp(0x52));
const FX_POLICY = policyRef('fx/2026-09-04.1');

/** Актор события безопасности — сам входящий; у настройки — тот, кто внёс. */
const CONSOLE_ACTOR = OPERATOR;

function sessionEstablishedBody(): SessionEstablishedBody {
  return {
    kind: 'session_established',
    sessionId: auditToken('ses-1'),
    primaryMethod: 'passkey',
    secondFactor: 'webauthn',
    expiresAt: at(480),
    device: DEVICE,
    network: NETWORK,
  };
}

/** Ветвь «настройка менялась»: `Extract` держит разбор союза в одном месте. */
type SettingUpdated = Extract<SettingChangedBody, { readonly change: 'updated' }>;

function settingChangedBody(
  overrides: {
    readonly previous?: SettingUpdated['previous'];
    readonly next?: SettingUpdated['next'];
    readonly effectiveFrom?: SettingUpdated['effectiveFrom'];
  } = {},
): SettingUpdated {
  return {
    kind: 'setting_changed',
    change: 'updated',
    setting: auditToken('fx.markup.eur_gel'),
    previous: overrides.previous ?? 150,
    next: overrides.next ?? 180,
    orderedBy: CONSOLE_ACTOR,
    reasonKey: 'setting.fx_markup.raised',
    policy: FX_POLICY,
    effectiveFrom: overrides.effectiveFrom ?? at(1440),
  };
}

describe('перечень видов записей покрывает все тела и наоборот', () => {
  it('каждое тело названо в AUDIT_RECORD_KINDS, и каждое значение перечня имеет тело', () => {
    // Не тавтология: соответствие проверяется в обе стороны и **типом**. Тело,
    // добавленное без значения перечня, не соберётся — запись `Record` станет
    // неполной; значение перечня без тела уронит сравнение массивов. Колонка
    // `kind` в базе — зеркало этого перечня, разойтись молча они не могут.
    const coverage: Record<AuditBody['kind'], true> = {
      chain_opened: true,
      decision_made: true,
      state_transition: true,
      condition_act_recorded: true,
      evidence_attached: true,
      payout_ordered: true,
      payout_result: true,
      beneficiary_changed: true,
      personal_data_viewed: true,
      correction: true,
      timestamp_token: true,
      anchor_published: true,
      session_established: true,
      session_denied: true,
      role_changed: true,
      setting_changed: true,
    };
    expect([...AUDIT_RECORD_KINDS].sort()).toEqual(Object.keys(coverage).sort());
  });

  it('новые виды дописаны в конец перечня', () => {
    // Порядок меток зеркалится в `sdelka.audit_record_kind`, а
    // `ALTER TYPE ... ADD VALUE` умеет только дописывать в конец. Вставка в
    // середину означала бы пересоздание типа на живых данных журнала.
    expect(AUDIT_RECORD_KINDS.slice(-4)).toEqual([
      'session_established',
      'session_denied',
      'role_changed',
      'setting_changed',
    ]);
  });
});

describe('вход', () => {
  it('ложится в цепочку и покрывается её хешем', () => {
    const chain = appendRecord(newChain(), {
      recordId: 'rec-login',
      recordedAt: at(1),
      actor: CONSOLE_ACTOR,
      subject: ACCOUNT,
      body: sessionEstablishedBody(),
    });
    const record = chain.records[1];
    expect(record?.body.kind).toBe('session_established');
    expect(verifyChain(chain).intact).toBe(true);
  });

  it('подмена отпечатка устройства рвёт хеш записи', () => {
    // Ради этого запись и ведётся: «вход из чужой сети» обязан быть
    // неисправимым задним числом, а не просто записанным.
    const chain = appendRecord(newChain(), {
      recordId: 'rec-login',
      recordedAt: at(1),
      actor: CONSOLE_ACTOR,
      subject: ACCOUNT,
      body: sessionEstablishedBody(),
    });
    const genesis = chain.records[0];
    const original = chain.records[1];
    if (genesis === undefined || original === undefined) throw new Error('unreachable');
    const report = verifyChain({
      chainId: chain.chainId,
      records: [
        genesis,
        {
          ...original,
          body: { ...sessionEstablishedBody(), device: auditFingerprint('device', fp(0x99)) },
        },
      ],
    });
    expect(report.intact).toBe(false);
    expect(report.intact === false && report.firstBreak.kind).toBe('hash_mismatch');
  });

  it('субъектом входа не может быть сделка', () => {
    // Иначе выборка по субъекту врёт: досье сделки наполняется чужими входами,
    // а входы по учётной записи не находятся.
    expectAuditError(
      () =>
        appendRecord(newChain(), {
          recordId: 'rec-login',
          recordedAt: at(1),
          actor: CONSOLE_ACTOR,
          subject: DEAL,
          body: sessionEstablishedBody(),
        }),
      AuditErrorCode.subjectScopeMismatch,
    );
  });
});

describe('отказ во входе', () => {
  const denied = (device: SessionDeniedBody['device'], network: SessionDeniedBody['network']) =>
    appendRecord(newChain(), {
      recordId: 'rec-denied',
      recordedAt: at(1),
      actor: SYSTEM,
      subject: ACCOUNT,
      body: {
        kind: 'session_denied',
        primaryMethod: 'magic_link',
        reasonKey: 'auth.primary.method_not_allowed_for_console',
        device,
        network,
      },
    });

  it('записывается с причиной, способом и отпечатками', () => {
    const chain = denied(DEVICE, NETWORK);
    const body = chain.records[1]?.body;
    expect(body?.kind).toBe('session_denied');
    expect(body?.kind === 'session_denied' && body.network).toEqual(NETWORK);
    expect(verifyChain(chain).intact).toBe(true);
  });

  it('отпечатков нет — это законный ответ, но написанный явно', () => {
    // `null` остаётся выразимым: отпечаток мог не сниматься. Невыразимо
    // другое — **промолчать** о нём, см. проверку ниже.
    expect(denied(null, null).records[1]?.body.kind).toBe('session_denied');
  });

  it('отпечатки не проставляются умолчанием', () => {
    // @ts-expect-error — `network` обязателен: запись об отказе ведётся ради
    // отпечатков, и пустыми они получались молчанием вызывающего.
    const body: SessionDeniedBody = {
      kind: 'session_denied',
      primaryMethod: 'password',
      reasonKey: 'auth.second_factor.missing',
      device: null,
    };
    expect(body.kind).toBe('session_denied');
  });

  it('причина — ключ, а не текст для человека', () => {
    // `CLAUDE.md`, «Три языка»: ни одной строки пользовательского текста.
    // Свободный текст не проходит форму `AUDIT_TOKEN` и в журнал не попадает.
    expectAuditError(
      () =>
        appendRecord(newChain(), {
          recordId: 'rec-denied',
          recordedAt: at(1),
          actor: SYSTEM,
          subject: ACCOUNT,
          body: {
            kind: 'session_denied',
            primaryMethod: 'password',
            reasonKey: 'Неверный пароль',
            device: null,
            network: null,
          },
        }),
      AuditErrorCode.tokenInvalid,
    );
  });
});

describe('смена роли', () => {
  const change = (body: RoleChangedBody) =>
    appendRecord(newChain(), {
      recordId: 'rec-role',
      recordedAt: at(2),
      actor: SYSTEM,
      subject: ACCOUNT,
      body,
    });

  it('прежняя и новая роль стоят в одной записи', () => {
    const chain = change({
      kind: 'role_changed',
      previous: 'operator',
      next: 'financial_controller',
      order: { kind: 'ordered_by', actor: CONSOLE_ACTOR },
      reasonKey: 'access.role.reassigned',
    });
    const body = chain.records[1]?.body;
    expect(body?.kind === 'role_changed' && body.previous).toBe('operator');
    expect(body?.kind === 'role_changed' && body.next).toBe('financial_controller');
    expect(verifyChain(chain).intact).toBe(true);
  });

  it('распоряжение вне системы требует документа', () => {
    // `auth` допускает «распорядился никто из системы»; в журнале это не
    // пустое поле, а ссылка на приказ: `CORE.md` Ф11.
    const chain = change({
      kind: 'role_changed',
      previous: null,
      next: 'support',
      order: { kind: 'external_order', document: source(9, 'operator_note', 'hr') },
      reasonKey: 'access.role.granted',
    });
    expect(chain.records[1]?.body.kind).toBe('role_changed');
  });

  it('смена роли на ту же самую не записывается', () => {
    expectAuditError(
      () =>
        change({
          kind: 'role_changed',
          previous: 'operator',
          next: 'operator',
          order: { kind: 'ordered_by', actor: CONSOLE_ACTOR },
          reasonKey: 'access.role.reassigned',
        }),
      AuditErrorCode.roleChangeIsNoop,
    );
  });

  it('субъектом смены роли не может быть сделка', () => {
    expectAuditError(
      () =>
        appendRecord(newChain(), {
          recordId: 'rec-role',
          recordedAt: at(2),
          actor: SYSTEM,
          subject: DEAL,
          body: {
            kind: 'role_changed',
            previous: 'operator',
            next: 'financial_controller',
            order: { kind: 'ordered_by', actor: CONSOLE_ACTOR },
            reasonKey: 'access.role.reassigned',
          },
        }),
      AuditErrorCode.subjectScopeMismatch,
    );
  });

  it('пары «ниоткуда в никуда» не существует', () => {
    // @ts-expect-error — при `previous: null` новая роль обязательна: запись
    // «роли не было и не стало» ни о чём не свидетельствует.
    const body: RoleChangedBody = {
      kind: 'role_changed',
      previous: null,
      next: null,
      order: { kind: 'ordered_by', actor: CONSOLE_ACTOR },
      reasonKey: 'access.role.revoked',
    };
    expect(body.kind).toBe('role_changed');
  });

  it('распоряжение обязательно', () => {
    // @ts-expect-error — нет `order`: смена роли без распоряжения и есть тихая
    // раздача доступа.
    const body: RoleChangedBody = {
      kind: 'role_changed',
      previous: 'operator',
      next: 'support',
      reasonKey: 'access.role.reassigned',
    };
    expect(body.kind).toBe('role_changed');
  });
});

describe('изменение настройки', () => {
  const change = (body: SettingChangedBody, recordedAt = at(10)) =>
    appendRecord(newChain(), {
      recordId: 'rec-setting',
      recordedAt,
      actor: CONSOLE_ACTOR,
      subject: SETTING,
      body,
    });

  it('записывает что, из чего, во что, кем, на каком основании и с какого момента', () => {
    const chain = change(settingChangedBody());
    const body = chain.records[1]?.body;
    if (body?.kind !== 'setting_changed' || body.change !== 'updated') {
      throw new Error('unreachable');
    }
    expect(body.setting).toBe('fx.markup.eur_gel');
    expect(body.previous).toBe(150);
    expect(body.next).toBe(180);
    expect(body.orderedBy.actorId).toBe(CONSOLE_ACTOR.actorId);
    expect(body.reasonKey).toBe('setting.fx_markup.raised');
    expect(body.policy).toBe('fx/2026-09-04.1');
    expect(body.effectiveFrom).toBe(at(1440));
    expect(verifyChain(chain).intact).toBe(true);
  });

  it('первичный ввод настройки — отдельная ветвь, а не пустое прежнее значение', () => {
    const chain = change({
      kind: 'setting_changed',
      change: 'introduced',
      setting: auditToken('fx.markup.eur_gel'),
      next: 150,
      orderedBy: CONSOLE_ACTOR,
      reasonKey: 'setting.fx_markup.introduced',
      policy: FX_POLICY,
      effectiveFrom: at(1440),
    });
    expect(chain.records[1]?.body.kind).toBe('setting_changed');
  });

  it('прежнее значение не заменяется на null', () => {
    const body: SettingChangedBody = {
      kind: 'setting_changed',
      change: 'updated',
      setting: auditToken('fx.markup.eur_gel'),
      // @ts-expect-error — «прежнего значения нет» выражается ветвью
      // `introduced`, а не пустым полем: пустое получается молчанием.
      previous: null,
      next: 180,
      orderedBy: CONSOLE_ACTOR,
      reasonKey: 'setting.fx_markup.raised',
      policy: FX_POLICY,
      effectiveFrom: at(1440),
    };
    expect(body.kind).toBe('setting_changed');
  });

  it('«вводится впервые» с прежним значением не собирается', () => {
    // Иначе ветвь `introduced` становится способом скрыть прежнее значение:
    // поле указано, а ветвь утверждает, что его не было.
    // @ts-expect-error — у ветви `introduced` поля `previous` нет вовсе
    const body: SettingChangedBody = {
      kind: 'setting_changed',
      change: 'introduced',
      setting: auditToken('fx.markup.eur_gel'),
      previous: 150,
      next: 180,
      orderedBy: CONSOLE_ACTOR,
      reasonKey: 'setting.fx_markup.introduced',
      policy: FX_POLICY,
      effectiveFrom: at(1440),
    };
    expect(body.kind).toBe('setting_changed');
  });

  it('момент вступления в силу обязателен', () => {
    // @ts-expect-error — нет `effectiveFrom`: «с какого момента действует» —
    // часть записи, а не подразумеваемое «сразу».
    const body: SettingChangedBody = {
      kind: 'setting_changed',
      change: 'updated',
      setting: auditToken('fx.markup.eur_gel'),
      previous: 150,
      next: 180,
      orderedBy: CONSOLE_ACTOR,
      reasonKey: 'setting.fx_markup.raised',
      policy: FX_POLICY,
    };
    expect(body.kind).toBe('setting_changed');
  });

  it('основание обязательно: ни причины, ни редакции пропустить нельзя', () => {
    // @ts-expect-error — нет `policy` и `reasonKey`
    const body: SettingChangedBody = {
      kind: 'setting_changed',
      change: 'updated',
      setting: auditToken('fx.markup.eur_gel'),
      previous: 150,
      next: 180,
      orderedBy: CONSOLE_ACTOR,
      effectiveFrom: at(1440),
    };
    expect(body.kind).toBe('setting_changed');
  });

  it('кто распорядился — обязательно', () => {
    // @ts-expect-error — нет `orderedBy`. Актор конверта отвечает на другой
    // вопрос: кто внёс. Распорядившийся называется, а не подразумевается.
    const body: SettingChangedBody = {
      kind: 'setting_changed',
      change: 'updated',
      setting: auditToken('fx.markup.eur_gel'),
      previous: 150,
      next: 180,
      reasonKey: 'setting.fx_markup.raised',
      policy: FX_POLICY,
      effectiveFrom: at(1440),
    };
    expect(body.kind).toBe('setting_changed');
  });

  it('настройка не вводится в действие задним числом', () => {
    // `ROADMAP.md` И16.2: пересчёт задним числом невозможен, а не запрещён
    // правилом. Настройка, действующая раньше собственной записи, и есть он.
    expectAuditError(
      () => change({ ...settingChangedBody(), effectiveFrom: auditInstant(1) }, at(10)),
      AuditErrorCode.settingEffectiveFromBackdated,
    );
  });

  it('запись об изменении, в котором ничего не изменилось, не создаётся', () => {
    expectAuditError(
      () => change({ ...settingChangedBody(), previous: 180, next: 180 }),
      AuditErrorCode.settingChangeIsNoop,
    );
  });

  it('перестановка ключей значением не является', () => {
    // Сравнение по канонической форме: `{a,b}` и `{b,a}` — одно значение.
    expectAuditError(
      () =>
        change({
          ...settingChangedBody(),
          previous: { rate: 150, cap: 500 },
          next: { cap: 500, rate: 150 },
        }),
      AuditErrorCode.settingChangeIsNoop,
    );
  });

  it('настройка в теле и в субъекте — одна и та же', () => {
    expectAuditError(
      () =>
        appendRecord(newChain(), {
          recordId: 'rec-setting',
          recordedAt: at(10),
          actor: CONSOLE_ACTOR,
          subject: auditRef('setting', 'fee.percent'),
          body: settingChangedBody(),
        }),
      AuditErrorCode.settingSubjectMismatch,
    );
  });

  it('субъектом изменения настройки не может быть сделка', () => {
    expectAuditError(
      () =>
        appendRecord(newChain(), {
          recordId: 'rec-setting',
          recordedAt: at(10),
          actor: CONSOLE_ACTOR,
          subject: DEAL,
          body: settingChangedBody(),
        }),
      AuditErrorCode.subjectScopeMismatch,
    );
  });
});

describe('новые виды идут через ту же дверь, что и остальные', () => {
  it('сцепка, нумерация и монотонность времени действуют на них', () => {
    let chain = newChain();
    chain = appendRecord(chain, {
      recordId: 'rec-login',
      recordedAt: at(1),
      actor: CONSOLE_ACTOR,
      subject: ACCOUNT,
      body: sessionEstablishedBody(),
    });
    chain = appendRecord(chain, {
      recordId: 'rec-role',
      recordedAt: at(2),
      actor: SYSTEM,
      subject: ACCOUNT,
      body: {
        kind: 'role_changed',
        previous: 'operator',
        next: 'financial_controller',
        order: { kind: 'ordered_by', actor: CONSOLE_ACTOR },
        reasonKey: 'access.role.reassigned',
      },
    });
    chain = appendRecord(chain, {
      recordId: 'rec-setting',
      recordedAt: at(3),
      actor: CONSOLE_ACTOR,
      subject: SETTING,
      body: settingChangedBody(),
    });

    expect(verifyChain(chain).intact).toBe(true);
    expect(chain.records.map((record) => record.seq)).toEqual([0, 1, 2, 3]);

    // Запись, вырванная из цепочки, обнаруживается так же, как денежная.
    expect(
      verifyChain({
        chainId: chain.chainId,
        records: chain.records.filter((record) => record.recordId !== 'rec-role'),
      }).intact,
    ).toBe(false);

    // Подменённая сцепка — тоже.
    const first = chain.records[0];
    const second = chain.records[1];
    if (first === undefined || second === undefined) throw new Error('unreachable');
    expect(
      verifyChain({
        chainId: chain.chainId,
        records: [first, { ...second, prevHash: FOREIGN_HASH }],
      }).intact,
    ).toBe(false);
  });

  it('время записи о входе не убывает', () => {
    const chain = appendRecord(newChain(), {
      recordId: 'rec-login',
      recordedAt: at(5),
      actor: CONSOLE_ACTOR,
      subject: ACCOUNT,
      body: sessionEstablishedBody(),
    });
    expectAuditError(
      () =>
        appendRecord(chain, {
          recordId: 'rec-login-2',
          recordedAt: at(4),
          actor: CONSOLE_ACTOR,
          subject: ACCOUNT,
          body: { ...sessionEstablishedBody(), sessionId: auditToken('ses-2') },
        }),
      AuditErrorCode.recordTimeRegression,
    );
  });

  it('исправление записи о входе — только новой записью со ссылкой', () => {
    // Красная линия №11 распространяется на события безопасности без оговорок.
    let chain = appendRecord(newChain(), {
      recordId: 'rec-login',
      recordedAt: at(1),
      actor: CONSOLE_ACTOR,
      subject: ACCOUNT,
      body: sessionEstablishedBody(),
    });
    chain = appendRecord(chain, {
      recordId: 'rec-login-fix',
      recordedAt: at(2),
      actor: SYSTEM,
      subject: ACCOUNT,
      body: {
        kind: 'correction',
        correctsRecordId: 'rec-login',
        reasonKey: 'session.device_fingerprint_misattributed',
        basis: source(9, 'operator_note', 'sdelka.console'),
        attributes: { device: auditFingerprint('device', fp(0x99)) },
      },
    });
    expect(chain.records).toHaveLength(3);
    expect(chain.records[1]?.body.kind).toBe('session_established');
    expect(verifyChain(chain).intact).toBe(true);
  });
});

describe('перечни способов входа', () => {
  it('перечислены и закрыты', () => {
    expect([...AUDIT_PRIMARY_METHODS]).toEqual(['passkey', 'password', 'federated', 'magic_link']);
    expect([...AUDIT_SECOND_FACTOR_KINDS]).toEqual(['webauthn', 'totp', 'push', 'sms', 'email']);
  });
});
