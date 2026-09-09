import type { Instant } from '@sdelka/domain';
import { describe, expect, it } from 'vitest';
import {
  type ChallengeId,
  type CodeDerivation,
  type CodeRequestPlan,
  type IdentityChallenge,
  CODE_KEY_MIN_LENGTH,
  IDENTITY_CODE_POLICY,
  PROVISIONAL_CODE_REQUEST_CLOCK,
  accountId,
  challengeId,
  challengeStatus,
  issueChallenge,
  planCodeRequest,
  recordDelivery,
  verifyChallenge,
} from '../src/index';
import { hmacCodeDerivation } from '../src/code';
import { NOW, at } from './support';

/**
 * Поток запросов «пришлите код»: сколько вызовов и сколько отправок стоит за
 * сотней запросов (`DECISIONS-REVIEW.md` §Z2).
 *
 * Сети здесь нет ни в одном виде: канал — массив, хранилище — переменная,
 * часы — аргумент. Ключ вывода кода тестовый и живёт в этом файле, как в
 * `challenge.test.ts`: боевой приходит из окружения и в дерево не попадает.
 */

const KEY = 'z'.repeat(CODE_KEY_MIN_LENGTH);
const DERIVATION: CodeDerivation = hmacCodeDerivation(KEY);
const ACCOUNT = accountId('acc-party-1');
const WINDOW = PROVISIONAL_CODE_REQUEST_CLOCK.resendWindow;

/**
 * Учётная запись с историей запросов: хранилище (последний вызов) и канал
 * (ушедшие коды) — второй реализацией, а не заданным поведением.
 *
 * Хранилище здесь ведёт себя так, как обязано вести себя настоящее: отметка об
 * отправке двигается на **каждую** отправку, включая повторную. Это и есть
 * условие, при котором правило работает; невыполненное — оно ломается молча,
 * и потому названо в `code-request.ts` отдельным пунктом связывания.
 */
function requester() {
  let latest: IdentityChallenge | null = null;
  let ids = 0;
  const sent: string[] = [];
  const references: ChallengeId[] = [];
  const issued: ChallengeId[] = [];
  return {
    sent,
    references,
    issued,
    stored: (): IdentityChallenge | null => latest,
    /** Хранилище переписано снаружи: ответ кодом, порча отметки, чужой вызов. */
    put: (challenge: IdentityChallenge | null): void => {
      latest = challenge;
    },
    request: (now: Instant): CodeRequestPlan => {
      const plan = planCodeRequest({
        accountId: ACCOUNT,
        latest,
        fresh: challengeId(`ch-${(ids += 1)}`),
        now,
      });
      references.push(plan.reference);
      if (plan.outcome === 'issued') {
        latest = plan.challenge;
        issued.push(plan.challenge.challengeId);
      }
      if (plan.outcome !== 'withheld') {
        sent.push(DERIVATION.codeFor(plan.challenge));
        latest = recordDelivery(plan.challenge, now);
      }
      return plan;
    },
  };
}

/** Ответ кодом столько раз, сколько сказано, и всегда неверным. */
function guessWrong(challenge: IdentityChallenge, times: number, now: Instant): IdentityChallenge {
  const wrong = DERIVATION.codeFor(challenge) === '000000' ? '111111' : '000000';
  let current = challenge;
  for (let attempt = 0; attempt < times; attempt += 1) {
    current = verifyChallenge(current, wrong, DERIVATION, now).challenge;
  }
  return current;
}

describe('поток запросов «пришлите код»', () => {
  it('сто запросов подряд заводят один вызов и одну отправку', () => {
    const account = requester();
    for (let n = 0; n < 100; n += 1) account.request(at(n * 100));
    expect(account.issued).toHaveLength(1);
    expect(account.sent).toHaveLength(1);
    // И ссылка у всех ста одна и та же: второго живого вызова не завелось.
    expect(new Set(account.references).size).toBe(1);
  });

  it('повтор в пределах окна возвращает тот же живой вызов, а не новый', () => {
    const account = requester();
    const first = account.request(NOW);
    const again = account.request(at(WINDOW - 1));
    expect(again.outcome).toBe('withheld');
    expect(again.reference).toBe(first.reference);
    // Вызов в хранилище не тронут: ни срок, ни счётчик попыток, ни момент
    // выдачи. Продлеваемый повтором срок — не срок.
    const live = account.stored() as IdentityChallenge;
    expect(live.challengeId).toBe(first.reference);
    expect(live.issuedAt).toBe(NOW);
    expect(live.expiresAt).toBe(at(IDENTITY_CODE_POLICY.ttl));
    expect(live.attemptsUsed).toBe(0);
    // Человек, у которого сообщение задержалось, не заперт: код из первого
    // сообщения по возвращённой ссылке по-прежнему подходит.
    expect(DERIVATION.matches(live, account.sent[0] as string)).toBe(true);
  });

  it('за пределами окна отправка повторяется — тем же вызовом и тем же кодом', () => {
    const account = requester();
    const first = account.request(NOW);
    account.request(at(WINDOW - 1));
    const resent = account.request(at(WINDOW));
    expect(resent.outcome).toBe('resent');
    expect(resent.reference).toBe(first.reference);
    expect(account.sent).toHaveLength(2);
    expect(account.sent[1]).toBe(account.sent[0]);
    // Второй строки в хранилище не появилось: повторная отправка — это
    // отправка, а не выдача.
    expect(account.issued).toHaveLength(1);
  });

  it('окно считается от последней отправки, а не от выдачи вызова', () => {
    // Иначе после первого повтора окно открыто навсегда: отметка стоит на
    // выдаче, разница с ней только растёт, и каждый следующий запрос шлёт.
    const account = requester();
    account.request(NOW);
    account.request(at(WINDOW));
    account.request(at(WINDOW + 1));
    account.request(at(2 * WINDOW - 1));
    expect(account.sent).toHaveLength(2);
    expect(account.request(at(2 * WINDOW)).outcome).toBe('resent');
    expect(account.sent).toHaveLength(3);
  });

  it('отказ канала не запирает человека на окно', () => {
    // Выдача прошла, отправка — нет: отметки нет ни одной. Поломка на нашей
    // стороне не должна выглядеть как ограничение.
    const account = requester();
    account.request(NOW);
    const live = account.stored() as IdentityChallenge;
    account.put(Object.freeze({ ...live, deliveredAt: null }));
    const retry = account.request(at(1000));
    expect(retry.outcome).toBe('resent');
    expect(retry.reference).toBe(live.challengeId);
  });

  it('чужой вызов не выдаётся за свой', () => {
    const account = requester();
    account.put(
      recordDelivery(
        issueChallenge({
          challengeId: challengeId('ch-someone-else'),
          accountId: accountId('acc-party-2'),
          issuedAt: NOW,
        }),
        NOW,
      ),
    );
    const plan = account.request(at(1000));
    expect(plan.outcome).toBe('issued');
    expect(plan.reference).not.toBe('ch-someone-else');
  });
});

describe('закрытый вызов не запирает вход', () => {
  it('истёкший вызов не мешает завести новый', () => {
    const account = requester();
    const first = account.request(NOW);
    const next = account.request(at(IDENTITY_CODE_POLICY.ttl));
    expect(next.outcome).toBe('issued');
    expect(next.reference).not.toBe(first.reference);
    expect(account.sent).toHaveLength(2);
    // Новый вызов — новый код: истёкший не переиздаётся.
    expect(account.sent[1]).not.toBe(account.sent[0]);
  });

  it('израсходованный вызов не мешает завести новый', () => {
    const account = requester();
    account.request(NOW);
    const live = account.stored() as IdentityChallenge;
    const consumed = verifyChallenge(live, DERIVATION.codeFor(live), DERIVATION, at(5000));
    expect(challengeStatus(consumed.challenge, at(5000))).toBe('consumed');
    account.put(consumed.challenge);
    const next = account.request(at(WINDOW + 5000));
    expect(next.outcome).toBe('issued');
    expect(next.reference).not.toBe(live.challengeId);
  });

  it('исчерпанный попытками вызов не мешает завести новый', () => {
    const account = requester();
    account.request(NOW);
    const live = account.stored() as IdentityChallenge;
    const burnt = guessWrong(live, IDENTITY_CODE_POLICY.maxAttempts, at(5000));
    expect(challengeStatus(burnt, at(5000))).toBe('exhausted');
    account.put(burnt);
    const next = account.request(at(WINDOW + 5000));
    expect(next.outcome).toBe('issued');
    expect(next.reference).not.toBe(live.challengeId);
    expect(account.sent).toHaveLength(2);
  });

  it('ожидание после закрытого вызова — окно, а не срок годности кода', () => {
    // Цена варианта Б, названная в §Z2, — «человек ждёт истечения десяти
    // минут». Здесь он ждёт окна: минуту, а не срок кода.
    const account = requester();
    account.request(NOW);
    account.put(guessWrong(account.stored() as IdentityChallenge, 5, at(1000)));
    expect(account.request(at(2000)).outcome).toBe('withheld');
    expect(account.request(at(WINDOW)).outcome).toBe('issued');
    expect(WINDOW).toBeLessThan(IDENTITY_CODE_POLICY.ttl);
  });
});

describe('ответ снаружи один и тот же', () => {
  it('«слишком часто» и обычный ответ неразличимы по форме', () => {
    // Ответ транспорта строится из одного поля плана — ссылки. Разный ответ на
    // «держите код» и «слишком часто» был бы перечислителем учётных записей,
    // которому не нужен ни один код (§Z3).
    const account = requester();
    const issued = account.request(NOW);
    const withheld = account.request(at(1000));
    expect(withheld.outcome).toBe('withheld');
    const answer = (plan: CodeRequestPlan): Record<string, unknown> => ({
      challengeId: plan.reference,
    });
    expect(Object.keys(answer(withheld))).toEqual(Object.keys(answer(issued)));
    expect(JSON.stringify(answer(withheld)).length).toBe(JSON.stringify(answer(issued)).length);
    expect(withheld.reference).toBeTypeOf('string');
    expect(withheld.reference.length).toBeGreaterThan(0);
  });

  it('«слишком часто» — не отказ: ссылка ведёт на живой вызов', () => {
    const account = requester();
    const issued = account.request(NOW);
    const withheld = account.request(at(1000));
    expect(withheld.reference).toBe(issued.reference);
    const live = account.stored() as IdentityChallenge;
    expect(challengeStatus(live, at(1000))).toBe('pending');
    expect(verifyChallenge(live, account.sent[0] as string, DERIVATION, at(1000)).outcome.ok).toBe(
      true,
    );
  });

  it('закрытый вызов внутри окна отвечает ссылкой, а не пустотой', () => {
    // Иначе «ссылки нет» означало бы «вы только что жгли попытки», то есть
    // ответ снова стал бы разным.
    const account = requester();
    account.request(NOW);
    account.put(guessWrong(account.stored() as IdentityChallenge, 5, at(1000)));
    const withheld = account.request(at(2000));
    expect(withheld.outcome).toBe('withheld');
    expect(withheld.challenge).toBeNull();
    expect(withheld.reference).toBeTypeOf('string');
    expect(withheld.reference.length).toBeGreaterThan(0);
  });
});

describe('политика подбора кода не ослабла', () => {
  it('три её числа остались теми же', () => {
    expect(IDENTITY_CODE_POLICY.ttl).toBe(10 * 60 * 1000);
    expect(IDENTITY_CODE_POLICY.maxAttempts).toBe(5);
    expect(IDENTITY_CODE_POLICY.codeLength).toBe(6);
  });

  it('повторный запрос не возвращает потраченные попытки', () => {
    // Иначе «пришлите ещё раз» — это шестая попытка, и счётчик не ограничивает
    // ничего: подбор идёт по попыткам, а не по знакам кода.
    const account = requester();
    account.request(NOW);
    account.put(guessWrong(account.stored() as IdentityChallenge, 3, at(1000)));
    expect((account.stored() as IdentityChallenge).attemptsUsed).toBe(3);
    account.request(at(2000));
    expect((account.stored() as IdentityChallenge).attemptsUsed).toBe(3);
    const resent = account.request(at(WINDOW));
    if (resent.outcome !== 'resent') throw new Error(`ожидался повтор, а не ${resent.outcome}`);
    expect(resent.challenge.attemptsUsed).toBe(3);
    expect(resent.challenge.expiresAt).toBe(at(IDENTITY_CODE_POLICY.ttl));
  });

  it('повторная отправка не оживляет исчерпанный вызов', () => {
    const account = requester();
    account.request(NOW);
    const live = account.stored() as IdentityChallenge;
    const code = DERIVATION.codeFor(live);
    account.put(guessWrong(live, IDENTITY_CODE_POLICY.maxAttempts, at(1000)));
    const next = account.request(at(WINDOW));
    if (next.outcome !== 'issued') throw new Error(`ожидалась выдача, а не ${next.outcome}`);
    // Старый код не переиздан и не принимается: новый вызов — новый код.
    expect(account.sent[1]).not.toBe(code);
    expect(DERIVATION.matches(next.challenge, code)).toBe(false);
  });

  it('сто запросов после исчерпания попыток не дают ни одной новой догадки', () => {
    // Сегодня сто запросов дают сто вызовов по пять попыток — пятьсот догадок.
    // Здесь их пять за окно, и это и есть разница.
    const account = requester();
    account.request(NOW);
    account.put(guessWrong(account.stored() as IdentityChallenge, 5, at(1000)));
    for (let n = 0; n < 100; n += 1) account.request(at(1000 + n * 100));
    expect(account.issued).toHaveLength(1);
    expect(account.sent).toHaveLength(1);
  });
});

describe('число окна', () => {
  it('окно объявлено временным и живёт одной константой', () => {
    // Число — вопрос владельца (§Z2). Проверяется не значение как «верное», а
    // то, что оно одно: разъехавшиеся окна ответа и отправки — два правила.
    expect(PROVISIONAL_CODE_REQUEST_CLOCK.resendWindow).toBe(60 * 1000);
    expect(Object.isFrozen(PROVISIONAL_CODE_REQUEST_CLOCK)).toBe(true);
  });
});
