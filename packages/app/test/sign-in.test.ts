import {
  type AccountRecord,
  type ChallengeId,
  type IdentityChallenge,
  type SessionId,
  AUTH_REASON_KEYS,
  CODE_KEY_MIN_LENGTH,
  IDENTITY_CODE_POLICY,
  PROVISIONAL_CODE_REQUEST_CLOCK,
  accountId,
  challengeId,
  personId,
  policyForRole,
  sessionId,
  sessionStatus,
  uniformIdentityRejection,
} from '@sdelka/auth';
import { hmacCodeDerivation } from '@sdelka/auth/code';
import { type Instant, instant } from '@sdelka/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type SignInDeps,
  type SignInOrigin,
  CODE_PRIMARY_METHOD,
  UNRESOLVED_IDENTITY,
  readSession,
  requestSignInCode,
  signOut,
  submitSignInCode,
} from '../src/sign-in';
import { type AuthTables, channel, memoryAuthStore, tables } from './support/auth-store';

/**
 * Вход как шаг приложения: код, срок, попытки, повтор, хранилище, отзыв.
 *
 * Сети здесь нет ни в одном виде, и канал доставки — не мок платёжного
 * провайдера, а вторая реализация порта, складывающая запросы в массив
 * (`CLAUDE.md`: «если для теста нужен мок платёжного провайдера — тест написан
 * неверно»). Ключ вывода кода свой, тестовый, и живёт в этом файле: боевой
 * приходит из окружения и в дерево не попадает никогда.
 */

const NOW: Instant = instant(Date.UTC(2026, 8, 9, 10, 0, 0));

const ORIGIN: SignInOrigin = Object.freeze({ device: null, network: null, locale: 'ka-GE' });

const PARTY: AccountRecord = Object.freeze({
  accountId: accountId('acc-party-1'),
  personId: personId('per-party-1'),
  roleId: 'party',
});

/** Консольная роль: политика требует устойчивый к фишингу фактор на входе. */
const OPERATOR: AccountRecord = Object.freeze({
  accountId: accountId('acc-operator-1'),
  personId: personId('per-operator-1'),
  roleId: 'operator',
});

const DERIVATION = hmacCodeDerivation('t'.repeat(CODE_KEY_MIN_LENGTH));

let data: AuthTables;
let clock: Instant;
let issued = 0;

function deps(overrides: Partial<SignInDeps> = {}): SignInDeps {
  return {
    store: memoryAuthStore(data),
    delivery: channel().port,
    derivation: DERIVATION,
    ids: {
      session: (): SessionId => sessionId(`s-${(issued += 1)}`),
      challenge: (): ChallengeId => challengeId(`ch-${(issued += 1)}`),
    },
    now: (): Instant => clock,
    ...overrides,
  };
}

function storedChallenge(id: ChallengeId): IdentityChallenge {
  const challenge = data.challenges.get(id);
  if (challenge === undefined) throw new Error(`вызова нет: ${id}`);
  return challenge;
}

async function codeFor(id: ChallengeId): Promise<string> {
  return DERIVATION.codeFor(storedChallenge(id));
}

beforeEach(() => {
  data = tables([PARTY, OPERATOR]);
  clock = NOW;
  issued = 0;
});

describe('запрос кода', () => {
  it('известной записи выдаётся вызов, а код уходит в канал — и только туда', async () => {
    const post = channel();
    const requested = await requestSignInCode(deps({ delivery: post.port }), {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    expect(post.sent).toHaveLength(1);
    expect(post.sent[0]?.code).toBe(await codeFor(requested.value.challengeId));
    // Код не оседает ни в хранимом вызове, ни в журнале входов.
    expect(JSON.stringify(storedChallenge(requested.value.challengeId))).not.toContain(
      post.sent[0]?.code ?? 'нет кода',
    );
    expect(JSON.stringify(data.journal)).not.toContain(post.sent[0]?.code ?? 'нет кода');
  });

  it('неизвестная запись получает такой же ответ по форме', async () => {
    const post = channel();
    const requested = await requestSignInCode(deps({ delivery: post.port }), {
      accountKey: 'acc-not-here',
      origin: ORIGIN,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    // Ссылка на вызов есть, вызова за ней нет, канал молчит: снаружи ответ
    // неотличим от ответа существующей записи.
    expect(requested.value.challengeId).toBeTypeOf('string');
    expect(data.challenges.size).toBe(0);
    expect(post.sent).toHaveLength(0);
  });

  it('отказ во входе по несуществующей записи остаётся в журнале — без введённой строки', async () => {
    await requestSignInCode(deps(), { accountKey: '995555123456', origin: ORIGIN });
    expect(data.journal).toHaveLength(1);
    const event = data.journal[0];
    expect(event?.kind).toBe('session_denied');
    expect(event?.actor.accountId).toBe(UNRESOLVED_IDENTITY);
    // Введённое значение в вечный журнал не попадает: по форме непрозрачного
    // ключа проходит и номер телефона, а запись оттуда не убрать.
    expect(JSON.stringify(data.journal)).not.toContain('995555123456');
  });

  it('отказ канала не выдаёт существования записи и остаётся в журнале', async () => {
    const broken = channel(true);
    const requested = await requestSignInCode(deps({ delivery: broken.port }), {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    expect(requested).toEqual({ ok: false, error: uniformIdentityRejection });
    expect(data.journal.at(-1)?.kind).toBe('session_denied');
    expect(data.delivered.size).toBe(0);
  });
});

describe('поток запросов «пришлите код»', () => {
  it('сто запросов подряд заводят один вызов и одну отправку', async () => {
    // §Z2: сегодня сотня запросов стоила бы ста строк и ста сообщений в канал.
    // Это не приближает никого к коду, но это отказ в обслуживании и наш счёт
    // за отправку.
    const post = channel();
    const runtime = deps({ delivery: post.port });
    const answers: string[] = [];
    for (let n = 0; n < 100; n += 1) {
      clock = instant(NOW + n * 100);
      const requested = await requestSignInCode(runtime, {
        accountKey: PARTY.accountId,
        origin: ORIGIN,
      });
      if (!requested.ok) throw new Error('ответ обязан быть тем же самым');
      answers.push(requested.value.challengeId);
    }
    expect(data.challenges.size).toBe(1);
    expect(post.sent).toHaveLength(1);
    // Ссылка у всех ста одна: человек, у которого сообщение задержалось, всё
    // это время получает свой живой вызов, а не пустоту.
    expect(new Set(answers).size).toBe(1);
    const code = await codeFor(answers[0] as ChallengeId);
    expect(post.sent[0]?.code).toBe(code);
  });

  it('придержанный запрос отвечает так же, как обычный, и код по нему подходит', async () => {
    const runtime = deps();
    const first = await requestSignInCode(runtime, {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    clock = instant(NOW + 1000);
    const again = await requestSignInCode(runtime, {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    // Ответ совпадает полем в поле: «слишком часто» не имеет ни своего отказа,
    // ни своего поля, иначе форма входа перечисляет учётные записи (§Z3).
    expect(again).toEqual(first);
    if (!again.ok) return;
    const opened = await submitSignInCode(runtime, {
      challengeId: again.value.challengeId,
      code: await codeFor(again.value.challengeId),
      origin: ORIGIN,
    });
    expect(opened.ok).toBe(true);
  });

  it('за окном тот же код уходит ещё раз, а строка остаётся одна', async () => {
    const post = channel();
    const runtime = deps({ delivery: post.port });
    const first = await requestSignInCode(runtime, {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    if (!first.ok) throw new Error('вызов не выдан');
    clock = instant(NOW + PROVISIONAL_CODE_REQUEST_CLOCK.resendWindow);
    const again = await requestSignInCode(runtime, {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    expect(again).toEqual(first);
    expect(data.challenges.size).toBe(1);
    expect(post.sent).toHaveLength(2);
    expect(post.sent[1]?.code).toBe(post.sent[0]?.code);
    // Срок повтором не двигается: продлеваемый срок — не срок.
    expect(storedChallenge(first.value.challengeId).expiresAt).toBe(
      instant(NOW + IDENTITY_CODE_POLICY.ttl),
    );
  });

  it('истёкший вызов не запирает вход: следующий запрос выдаёт новый', async () => {
    const post = channel();
    const runtime = deps({ delivery: post.port });
    const first = await requestSignInCode(runtime, {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    if (!first.ok) throw new Error('вызов не выдан');
    clock = instant(NOW + IDENTITY_CODE_POLICY.ttl);
    const next = await requestSignInCode(runtime, {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    if (!next.ok) throw new Error('вызов не выдан');
    expect(next.value.challengeId).not.toBe(first.value.challengeId);
    expect(data.challenges.size).toBe(2);
    expect(post.sent).toHaveLength(2);
    expect(post.sent[1]?.code).not.toBe(post.sent[0]?.code);
  });

  it('сто запросов после исчерпания попыток не дают ни одной новой догадки', async () => {
    // Иначе ограничение обходится за пять секунд: пять неверных ответов
    // закрывают вызов, следующий запрос заводит новый и шлёт сообщение.
    const post = channel();
    const runtime = deps({ delivery: post.port });
    const requested = await requestSignInCode(runtime, {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    if (!requested.ok) throw new Error('вызов не выдан');
    const id = requested.value.challengeId;
    const wrong = (await codeFor(id)) === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < IDENTITY_CODE_POLICY.maxAttempts; attempt += 1) {
      await submitSignInCode(runtime, { challengeId: id, code: wrong, origin: ORIGIN });
    }
    for (let n = 0; n < 100; n += 1) {
      clock = instant(NOW + 1000 + n * 100);
      await requestSignInCode(runtime, { accountKey: PARTY.accountId, origin: ORIGIN });
    }
    expect(data.challenges.size).toBe(1);
    expect(post.sent).toHaveLength(1);
  });

  it('другая учётная запись своим окном не ограничена', async () => {
    // Окно — на запись, а не на процесс: иначе один запрос останавливал бы
    // вход всем.
    const post = channel();
    const runtime = deps({ delivery: post.port });
    await requestSignInCode(runtime, { accountKey: PARTY.accountId, origin: ORIGIN });
    clock = instant(NOW + 1000);
    await requestSignInCode(runtime, { accountKey: OPERATOR.accountId, origin: ORIGIN });
    expect(post.sent).toHaveLength(2);
    expect(data.challenges.size).toBe(2);
  });
});

describe('ответ кодом', () => {
  it('верный код открывает сессию и оставляет запись в журнале', async () => {
    const runtime = deps();
    const requested = await requestSignInCode(runtime, {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    if (!requested.ok) throw new Error('вызов не выдан');
    const result = await submitSignInCode(runtime, {
      challengeId: requested.value.challengeId,
      code: await codeFor(requested.value.challengeId),
      origin: ORIGIN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accountId).toBe(PARTY.accountId);
    expect(result.value.roleId).toBe('party');
    expect(result.value.primary.method).toBe(CODE_PRIMARY_METHOD);
    // Срок берётся у политики роли, а не у вызывающего.
    expect(result.value.expiresAt - result.value.issuedAt).toBe(policyForRole('party').maxTtl);
    expect(data.journal.at(-1)?.kind).toBe('session_established');
  });

  it('повтор того же кода вторую сессию не даёт', async () => {
    const runtime = deps();
    const requested = await requestSignInCode(runtime, {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    if (!requested.ok) throw new Error('вызов не выдан');
    const code = await codeFor(requested.value.challengeId);
    const first = await submitSignInCode(runtime, {
      challengeId: requested.value.challengeId,
      code,
      origin: ORIGIN,
    });
    expect(first.ok).toBe(true);
    const second = await submitSignInCode(runtime, {
      challengeId: requested.value.challengeId,
      code,
      origin: ORIGIN,
    });
    expect(second).toEqual({ ok: false, error: uniformIdentityRejection });
    expect(data.sessions.size).toBe(1);
    // Настоящая причина повтора не теряется — она в журнале, а не на экране.
    const denied = data.journal.at(-1);
    expect(denied?.kind === 'session_denied' && denied.reason).toBe(
      AUTH_REASON_KEYS.identityChallengeConsumed,
    );
  });

  it('истёкший код не пускает', async () => {
    const runtime = deps();
    const requested = await requestSignInCode(runtime, {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    if (!requested.ok) throw new Error('вызов не выдан');
    const code = await codeFor(requested.value.challengeId);
    clock = instant(NOW + IDENTITY_CODE_POLICY.ttl);
    const result = await submitSignInCode(runtime, {
      challengeId: requested.value.challengeId,
      code,
      origin: ORIGIN,
    });
    expect(result).toEqual({ ok: false, error: uniformIdentityRejection });
    const denied = data.journal.at(-1);
    expect(denied?.kind === 'session_denied' && denied.reason).toBe(
      AUTH_REASON_KEYS.identityChallengeExpired,
    );
    expect(data.sessions.size).toBe(0);
  });

  it('попытки кончаются, и верный код после этого уже не спасает', async () => {
    const runtime = deps();
    const requested = await requestSignInCode(runtime, {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    if (!requested.ok) throw new Error('вызов не выдан');
    const id = requested.value.challengeId;
    const code = await codeFor(id);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 1; attempt <= IDENTITY_CODE_POLICY.maxAttempts; attempt += 1) {
      const result = await submitSignInCode(runtime, { challengeId: id, code: wrong, origin: ORIGIN });
      expect(result.ok).toBe(false);
      // Каждая попытка доезжает до хранилища: счётчик, оставшийся в памяти
      // шага, подбор не ограничивает ничем.
      expect(storedChallenge(id).attemptsUsed).toBe(attempt);
    }
    const rescue = await submitSignInCode(runtime, { challengeId: id, code, origin: ORIGIN });
    expect(rescue).toEqual({ ok: false, error: uniformIdentityRejection });
    const denied = data.journal.at(-1);
    expect(denied?.kind === 'session_denied' && denied.reason).toBe(
      AUTH_REASON_KEYS.identityAttemptsExhausted,
    );
    expect(data.sessions.size).toBe(0);
  });

  it('ссылка на несуществующий вызов отвечает той же единой причиной', async () => {
    const result = await submitSignInCode(deps(), {
      challengeId: 'ch-never-issued',
      code: '000000',
      origin: ORIGIN,
    });
    expect(result).toEqual({ ok: false, error: uniformIdentityRejection });
    const denied = data.journal.at(-1);
    expect(denied?.kind === 'session_denied' && denied.reason).toBe(
      AUTH_REASON_KEYS.identityChallengeNotFound,
    );
  });

  it('подделанная ссылка не роняет шаг, а просто ничего не находит', async () => {
    const result = await submitSignInCode(deps(), {
      challengeId: 'не ключ, а строка',
      code: '000000',
      origin: ORIGIN,
    });
    expect(result).toEqual({ ok: false, error: uniformIdentityRejection });
  });

  it('консольная роль по коду в канал не входит — устойчивого фактора у него нет', async () => {
    // `ACTORS.md` §11 Р6 B: канал, который может быть у нападающего, вторым
    // фактором не является. Сотрудник, видящий деньги, так войти не должен.
    const runtime = deps();
    const requested = await requestSignInCode(runtime, {
      accountKey: OPERATOR.accountId,
      origin: ORIGIN,
    });
    if (!requested.ok) throw new Error('вызов не выдан');
    const result = await submitSignInCode(runtime, {
      challengeId: requested.value.challengeId,
      code: await codeFor(requested.value.challengeId),
      origin: ORIGIN,
    });
    expect(result).toEqual({ ok: false, error: uniformIdentityRejection });
    const denied = data.journal.at(-1);
    // Причина — именно запрет метки для консоли: `establishSession` разбирает
    // его первым, до второго фактора, и это тот же довод Р6 B, только раньше.
    expect(denied?.kind === 'session_denied' && denied.reason).toBe(
      AUTH_REASON_KEYS.primaryMethodNotAllowedForConsole,
    );
  });
});

describe('сессия переживает перезапуск процесса', () => {
  it('второе хранилище над теми же таблицами видит ту же сессию', async () => {
    const before = deps();
    const requested = await requestSignInCode(before, {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    if (!requested.ok) throw new Error('вызов не выдан');
    const opened = await submitSignInCode(before, {
      challengeId: requested.value.challengeId,
      code: await codeFor(requested.value.challengeId),
      origin: ORIGIN,
    });
    if (!opened.ok) throw new Error('сессия не выдана');

    // Перезапуск: прежние объекты выброшены, таблицы остались.
    const after = deps({ store: memoryAuthStore(data) });
    const restored = await readSession(after, opened.value.sessionId);
    expect(restored).not.toBeNull();
    expect(restored?.sessionId).toBe(opened.value.sessionId);
    expect(restored?.expiresAt).toBe(opened.value.expiresAt);
    clock = instant(NOW + 1000);
    expect(sessionStatus(restored as NonNullable<typeof restored>, clock)).toBe('active');
  });
});

describe('выход', () => {
  it('отзыв закрывает доступ немедленно и остаётся записью', async () => {
    const runtime = deps();
    const requested = await requestSignInCode(runtime, {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    if (!requested.ok) throw new Error('вызов не выдан');
    const opened = await submitSignInCode(runtime, {
      challengeId: requested.value.challengeId,
      code: await codeFor(requested.value.challengeId),
      origin: ORIGIN,
    });
    if (!opened.ok) throw new Error('сессия не выдана');

    clock = instant(NOW + 60_000);
    expect(await signOut(runtime, { sessionId: opened.value.sessionId })).toEqual({
      ok: true,
      value: null,
    });
    const after = await readSession(runtime, opened.value.sessionId);
    expect(after?.revokedAt).toBe(clock);
    // Немедленно: в тот же момент, а не с истечением срока.
    expect(sessionStatus(after as NonNullable<typeof after>, clock)).toBe('revoked');
    expect(data.journal.at(-1)?.kind).toBe('session_revoked');
  });

  it('повторный выход не ломается и второй записи не оставляет', async () => {
    const runtime = deps();
    const requested = await requestSignInCode(runtime, {
      accountKey: PARTY.accountId,
      origin: ORIGIN,
    });
    if (!requested.ok) throw new Error('вызов не выдан');
    const opened = await submitSignInCode(runtime, {
      challengeId: requested.value.challengeId,
      code: await codeFor(requested.value.challengeId),
      origin: ORIGIN,
    });
    if (!opened.ok) throw new Error('сессия не выдана');
    await signOut(runtime, { sessionId: opened.value.sessionId });
    const journalled = data.journal.length;
    expect(await signOut(runtime, { sessionId: opened.value.sessionId })).toEqual({
      ok: true,
      value: null,
    });
    expect(data.journal).toHaveLength(journalled);
  });

  it('выход из сессии, которой нет, — тот же исход, а не отказ', async () => {
    expect(await signOut(deps(), { sessionId: 's-never-issued' })).toEqual({
      ok: true,
      value: null,
    });
  });
});
