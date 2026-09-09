import { describe, expect, it } from 'vitest';
import {
  AUTH_REASON_KEYS,
  AuthError,
  AuthErrorCode,
  CODE_KEY_MIN_LENGTH,
  IDENTITY_CODE_POLICY,
  type CodeDerivation,
  type IdentityChallenge,
  accountId,
  challengeId,
  challengeStatus,
  issueChallenge,
  uniformIdentityRejection,
  verifyChallenge,
} from '../src/index';
import { hmacCodeDerivation } from '../src/code';
import { NOW, at } from './support';

/**
 * Одноразовый код — над значением, без сети, без базы и без секрета в дереве.
 *
 * Ключ вывода кода в тестах свой и живёт в этом файле: он не боевой и ничего не
 * открывает, а брать его из окружения значило бы завести проверку, которая у
 * одного зелёная, а у другого не запускается.
 */
const TEST_KEY = 'x'.repeat(CODE_KEY_MIN_LENGTH);
const DERIVATION: CodeDerivation = hmacCodeDerivation(TEST_KEY);

function fresh(): IdentityChallenge {
  return issueChallenge({
    challengeId: challengeId('ch-1'),
    accountId: accountId('acc-party-1'),
    issuedAt: NOW,
  });
}

describe('выдача вызова', () => {
  it('срок, счётчик попыток и однократность заданы выдачей, а не вызывающим', () => {
    const challenge = fresh();
    expect(challenge.expiresAt).toBe(at(IDENTITY_CODE_POLICY.ttl));
    expect(challenge.attemptsUsed).toBe(0);
    expect(challenge.maxAttempts).toBe(IDENTITY_CODE_POLICY.maxAttempts);
    expect(challenge.consumedAt).toBeNull();
  });

  it('в значении вызова кода нет ни в каком виде', () => {
    // Красная линия №12 в применении к хранимому: код выводится ключом из
    // окружения, а в значении и в базе остаётся только сам вызов.
    const challenge = fresh();
    const code = DERIVATION.codeFor(challenge);
    expect(JSON.stringify(challenge)).not.toContain(code);
    for (const value of Object.values(challenge)) {
      expect(String(value)).not.toBe(code);
    }
  });
});

describe('код принимается один раз', () => {
  it('верный код закрывает вызов', () => {
    const challenge = fresh();
    const result = verifyChallenge(challenge, DERIVATION.codeFor(challenge), DERIVATION, at(1000));
    expect(result.outcome.ok).toBe(true);
    expect(result.challenge.consumedAt).toBe(at(1000));
    expect(challengeStatus(result.challenge, at(1000))).toBe('consumed');
  });

  it('повтор того же кода отвергается — второй вход по одному ключу не вход', () => {
    const challenge = fresh();
    const code = DERIVATION.codeFor(challenge);
    const first = verifyChallenge(challenge, code, DERIVATION, at(1000));
    const second = verifyChallenge(first.challenge, code, DERIVATION, at(2000));
    expect(second.outcome).toEqual({
      ok: false,
      error: AUTH_REASON_KEYS.identityChallengeConsumed,
    });
    // Закрытый вызов попыток больше не тратит: иначе повтор сам себя переводил
    // бы в «исчерпано» и путал журнал.
    expect(second.challenge.attemptsUsed).toBe(first.challenge.attemptsUsed);
  });
});

describe('срок годности кода', () => {
  it('на границе срока код уже не принимается', () => {
    const challenge = fresh();
    const result = verifyChallenge(
      challenge,
      DERIVATION.codeFor(challenge),
      DERIVATION,
      at(IDENTITY_CODE_POLICY.ttl),
    );
    expect(result.outcome).toEqual({
      ok: false,
      error: AUTH_REASON_KEYS.identityChallengeExpired,
    });
  });

  it('за миллисекунду до срока — принимается', () => {
    const challenge = fresh();
    const result = verifyChallenge(
      challenge,
      DERIVATION.codeFor(challenge),
      DERIVATION,
      at(IDENTITY_CODE_POLICY.ttl - 1),
    );
    expect(result.outcome.ok).toBe(true);
  });

  it('истёкший вызов попыток не тратит', () => {
    const challenge = fresh();
    const result = verifyChallenge(challenge, '000000', DERIVATION, at(IDENTITY_CODE_POLICY.ttl));
    expect(result.challenge.attemptsUsed).toBe(0);
  });
});

describe('исчерпание попыток', () => {
  it('каждая неверная попытка засчитывается, и после последней вызов закрыт', () => {
    let challenge = fresh();
    const wrong = DERIVATION.codeFor(challenge) === '000000' ? '111111' : '000000';
    for (let attempt = 1; attempt <= IDENTITY_CODE_POLICY.maxAttempts; attempt += 1) {
      const result = verifyChallenge(challenge, wrong, DERIVATION, at(1000));
      expect(result.outcome).toEqual({
        ok: false,
        error: AUTH_REASON_KEYS.identityCodeMismatch,
      });
      expect(result.challenge.attemptsUsed).toBe(attempt);
      challenge = result.challenge;
    }
    expect(challengeStatus(challenge, at(1000))).toBe('exhausted');
  });

  it('после исчерпания верный код уже не спасает — иначе счётчик ничего не ограничивает', () => {
    let challenge = fresh();
    const code = DERIVATION.codeFor(challenge);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < IDENTITY_CODE_POLICY.maxAttempts; attempt += 1) {
      challenge = verifyChallenge(challenge, wrong, DERIVATION, at(1000)).challenge;
    }
    const result = verifyChallenge(challenge, code, DERIVATION, at(1000));
    expect(result.outcome).toEqual({
      ok: false,
      error: AUTH_REASON_KEYS.identityAttemptsExhausted,
    });
  });
});

describe('вывод кода ключом', () => {
  it('код — шесть цифр', () => {
    expect(DERIVATION.codeFor(fresh())).toMatch(/^[0-9]{6}$/u);
  });

  it('вызов другой учётной записи даёт другой код при том же идентификаторе', () => {
    // Иначе вызов, переписанный на чужую запись, отвечался бы уже известным
    // кодом — то есть код доказывал бы владение вызовом, а не личностью.
    const mine = fresh();
    const theirs = issueChallenge({
      challengeId: challengeId('ch-1'),
      accountId: accountId('acc-party-2'),
      issuedAt: NOW,
    });
    expect(DERIVATION.codeFor(mine)).not.toBe(DERIVATION.codeFor(theirs));
  });

  it('другой ключ даёт другой код: перебором по вызову код не получить', () => {
    const other = hmacCodeDerivation('y'.repeat(CODE_KEY_MIN_LENGTH));
    const challenge = fresh();
    expect(other.codeFor(challenge)).not.toBe(DERIVATION.codeFor(challenge));
  });

  it('пробелы и дефисы в ответе человека не меняют исхода', () => {
    const challenge = fresh();
    const code = DERIVATION.codeFor(challenge);
    expect(DERIVATION.matches(challenge, `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(true);
    expect(DERIVATION.matches(challenge, `${code.slice(0, 3)}-${code.slice(3)}`)).toBe(true);
  });

  it('ответ не из цифр не совпадает и не роняет проверку', () => {
    const challenge = fresh();
    expect(DERIVATION.matches(challenge, 'абвгде')).toBe(false);
    expect(DERIVATION.matches(challenge, '')).toBe(false);
  });

  it('короткий ключ не принимается, и его значение не попадает в отказ', () => {
    try {
      hmacCodeDerivation('short');
      expect.unreachable('короткий ключ обязан быть отвергнут');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe(AuthErrorCode.codeKeyTooShort);
      expect(JSON.stringify((error as AuthError).details)).not.toContain('short');
    }
  });
});

describe('ответ экрану один на все отказы', () => {
  it('единая причина не совпадает ни с одной внутренней', () => {
    // Разные ответы на «такого лица нет» и «код неверен» — это перечислитель
    // учётных записей. Внутренние причины при этом остаются: их читает журнал.
    expect(uniformIdentityRejection).toBe(AUTH_REASON_KEYS.identityRejected);
    for (const internal of [
      AUTH_REASON_KEYS.identityAccountUnknown,
      AUTH_REASON_KEYS.identityCodeMismatch,
      AUTH_REASON_KEYS.identityChallengeExpired,
      AUTH_REASON_KEYS.identityChallengeConsumed,
      AUTH_REASON_KEYS.identityAttemptsExhausted,
      AUTH_REASON_KEYS.identityChallengeNotFound,
    ]) {
      expect(internal).not.toBe(uniformIdentityRejection);
    }
  });
});
