import {
  type AccountRecord,
  type AuthReasonKey,
  type AuthStore,
  type AuthTransaction,
  type ChallengeId,
  type CodeDeliveryPort,
  type CodeDerivation,
  type Fingerprint,
  type IdentityChallenge,
  type PrimaryMethod,
  type Session,
  type SessionId,
  AUTH_REASON_KEYS,
  CODE_PURPOSE_KEYS,
  accountId as toAccountId,
  challengeId as toChallengeId,
  deliveryFor,
  establishSession,
  issueChallenge,
  personId as toPersonId,
  policyForRole,
  revoke,
  sessionDenied,
  sessionEstablished,
  sessionRevoked,
  sessionId as toSessionId,
  uniformIdentityRejection,
  verifyChallenge,
} from '@sdelka/auth';
import { type Instant, type Result, failure, ok } from '@sdelka/domain';

/**
 * Вход — **решение приложения, а не транспорта**.
 *
 * ## Что здесь происходит
 *
 * Два шага и один выход. Первый: «мне нужен код» — учётная запись ищется,
 * вызов выдаётся, код выводится ключом и уходит в канал. Второй: «вот код» —
 * ответ сверяется, попытка засчитывается, сессия выдаётся политикой роли и
 * ложится в хранилище. Выход: сессия отзывается, и отзыв — запись, а не пропажа
 * строки.
 *
 * Транспорт (`apps/web`) не решает **ничего**: он переводит форму в вызов и
 * результат в экран. Ни срока, ни числа попыток, ни выбора роли, ни решения «а
 * пустим ли» в нём нет ни одного.
 *
 * ## Три правила, которые здесь держатся, и почему именно здесь
 *
 * 1. **Ответ экрану один на все отказы.** «Такого лица нет» и «код неверен»
 *    снаружи неразличимы: разница между ними — готовый перечислитель учётных
 *    записей, которому не нужен ни один код. Различие при этом не теряется —
 *    оно уходит в журнал входов, куда экран не смотрит. Ровно поэтому уравнение
 *    ответов живёт здесь, а не в транспорте: транспорт, которому дали разные
 *    ключи, однажды покажет их оба.
 * 2. **Попытка засчитывается всегда.** Изменённый вызов пишется до того, как
 *    разбирается исход: счётчик, не доехавший до хранилища, — это счётчик,
 *    который не считает, и подбор переживает ограничение молча.
 * 3. **Вход оставляет запись.** И удачный, и неудачный: `session_established`
 *    либо `session_denied` в `sdelka.auth_event` — таблице, у которой роль
 *    приложения имеет `SELECT` и `INSERT` и не имеет ничего больше (красная
 *    линия №11). Кода и его отпечатка среди полей записи нет ни одного.
 *
 * ## Чего здесь нет
 *
 * **Секретов.** Ключ вывода кода живёт в окружении и приходит сюда уже
 * связанным внутрь `CodeDerivation`; сам код не попадает ни в журнал, ни в
 * возвращаемое значение, ни в отказ (красная линия №12).
 *
 * **Канала.** Он за портом, и порт без боевого адаптера отказывает на старте
 * процесса, а не печатает код в лог молча (`auth/src/delivery.ts`).
 */

/* ------------------------------------------------------------------------- */
/* Чем подтверждается вход                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Метка первичного подтверждения для входа по одноразовому коду.
 *
 * ⚠ **Названного значения в перечне нет, и это расхождение, а не выбор.**
 * `PRIMARY_METHODS` (`auth/src/second-factor.ts`) знает четыре метки —
 * `passkey`, `password`, `federated`, `magic_link`, — и `one_time_code` среди
 * них нет. Завести его нельзя отсюда: перечень продублирован в
 * `packages/audit` (`AUDIT_PRIMARY_METHODS`) и сверяется построчно
 * (`auth/test/journal.test.ts`), то есть пятая метка — правка чужого пакета.
 *
 * Взят `magic_link` по прямому основанию, а не по похожести: запрет этой метки
 * для консольных ролей выведен из `ACTORS.md` §11 Р6 **варианта B**, а вариант
 * B — это дословно «одноразовый код на почту». Пакет уже трактует метку как
 * «подтверждение владением каналом» (`second-factor.ts`: «тот же довод
 * переносится на SMS и на код в мессенджере»), и запрет для консоли работает
 * ровно так, как нужно: сотрудник, видящий деньги, по коду в канал не входит.
 *
 * Цена решения названа: журнал не редактируется (красная линия №11), поэтому
 * записанное сегодня `magic_link` останется там навсегда, даже если метка
 * появится завтра. Развилка вынесена владельцу — `DECISIONS-REVIEW.md` §Z1
 * **[открыто]**.
 */
export const CODE_PRIMARY_METHOD: PrimaryMethod = 'magic_link';

/**
 * Кем записан отказ, когда лица за попыткой установить не удалось.
 *
 * `sdelka.auth_event` требует учётную запись и человека **непустыми**: запись
 * об отказе без субъекта ничего не даёт при разборе. Настоящий ключ сюда не
 * кладётся: строка приходит из формы, и «непрозрачный ключ» по форме — это ещё
 * и номер телефона, а журнал не редактируется, то есть попавшее в него не убрать.
 *
 * Ключ зарезервирован: учётная запись с таким именем не заводится.
 */
export const UNRESOLVED_IDENTITY = 'unresolved';

const UNRESOLVED_ACTOR = Object.freeze({
  accountId: toAccountId(UNRESOLVED_IDENTITY),
  personId: toPersonId(UNRESOLVED_IDENTITY),
  roleId: null,
  onDuty: false,
});

function actorOf(account: AccountRecord) {
  return Object.freeze({
    accountId: account.accountId,
    personId: account.personId,
    roleId: account.roleId,
    onDuty: false,
  });
}

/* ------------------------------------------------------------------------- */
/* Зависимости                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Источник идентификаторов. Порт, а не `crypto` внутри: случайность —
 * свойство среды, и шаг, который её сам добывает, невоспроизводим в тесте.
 */
export interface IdentitySource {
  session(): SessionId;
  challenge(): ChallengeId;
}

export interface SignInDeps {
  readonly store: AuthStore;
  readonly delivery: CodeDeliveryPort;
  readonly derivation: CodeDerivation;
  readonly ids: IdentitySource;
  /** Момент берётся у среды один раз на шаг: свободный момент оживляет истёкшее. */
  now(): Instant;
}

/** Откуда пришла попытка. Отпечатки, а не сырые значения (`ACTORS.md` §4.1 A2). */
export interface SignInOrigin {
  readonly device: Fingerprint | null;
  readonly network: Fingerprint | null;
  /** Язык получателя тегом локали: канал переводит текст сам. */
  readonly locale: string;
}

export interface CodeRequested {
  /**
   * Ссылка на вызов, которую транспорт кладёт в форму.
   *
   * Выдаётся **всегда** — и когда учётной записи нет. Иначе ответ «ссылки нет»
   * сообщал бы, что записи не существует, то есть уравнивание ответов
   * отменялось бы полем ответа.
   */
  readonly challengeId: ChallengeId;
}

/* ------------------------------------------------------------------------- */
/* Шаг первый: запрос кода                                                   */
/* ------------------------------------------------------------------------- */

/**
 * «Мне нужен код».
 *
 * Неизвестная учётная запись доходит до конца и получает **ссылку на вызов,
 * которого нет**: строка в хранилище не появляется. Это намеренно и названо
 * ценой ниже.
 *
 * ⚠ **Ответы уравнены по содержанию, но не по времени.** Известной записи
 * достаётся вставка строки и обращение к каналу, неизвестной — ничего, и
 * разница видна замером. Закрыть её можно двумя способами: заводить вызов и
 * несуществующей записи (тогда в вечно живущей таблице оседает строка, введённая
 * кем угодно, — а «непрозрачный ключ» по форме это и номер телефона) либо
 * выравнивать время искусственно. Первое противоречит правилу о персональных
 * данных, второе — это задержка, которую надо назначить. Развилка вынесена
 * владельцу: `DECISIONS-REVIEW.md` §Z3 **[открыто]**.
 */
export async function requestSignInCode(
  deps: SignInDeps,
  input: { readonly accountKey: string; readonly origin: SignInOrigin },
): Promise<Result<CodeRequested, AuthReasonKey>> {
  const now = deps.now();
  return deps.store.transact(async (tx) => {
    const account = await tx.accounts.find(input.accountKey);
    if (account === null) {
      await journalDenied(tx, UNRESOLVED_ACTOR, AUTH_REASON_KEYS.identityAccountUnknown, now, input.origin);
      // Ссылка выдаётся, вызова за ней нет: ответ формы обязан совпасть с
      // ответом по существующей записи до последнего поля.
      return ok({ challengeId: deps.ids.challenge() });
    }
    const challenge = issueChallenge({
      challengeId: deps.ids.challenge(),
      accountId: account.accountId,
      issuedAt: now,
    });
    await tx.challenges.save(challenge);
    const code = deps.derivation.codeFor(challenge);
    try {
      await deps.delivery.deliver(
        deliveryFor(challenge, code, CODE_PURPOSE_KEYS.signIn, input.origin.locale),
      );
    } catch {
      // Отказ канала — не ответ о личности, но и не повод показать его только
      // существующим записям: наружу уходит та же единая причина, в журнал —
      // настоящая. Исключение канала не пересказывается: в нём может лежать
      // адрес получателя, а он персональные данные.
      await journalDenied(
        tx,
        actorOf(account),
        AUTH_REASON_KEYS.identityChannelUnavailable,
        now,
        input.origin,
      );
      return failure(uniformIdentityRejection);
    }
    await tx.challenges.markDelivered(challenge.challengeId, now);
    return ok({ challengeId: challenge.challengeId });
  });
}

/* ------------------------------------------------------------------------- */
/* Шаг второй: ответ кодом                                                   */
/* ------------------------------------------------------------------------- */

/**
 * «Вот код».
 *
 * Порядок операций внутри — не стиль: изменённый вызов записывается **до**
 * разбора исхода, иначе неверная попытка не тратит ничего.
 */
export async function submitSignInCode(
  deps: SignInDeps,
  input: {
    readonly challengeId: string;
    readonly code: string;
    readonly origin: SignInOrigin;
  },
): Promise<Result<Session, AuthReasonKey>> {
  const now = deps.now();
  return deps.store.transact(async (tx) => {
    const challenge = await loadChallenge(tx, input.challengeId);
    if (challenge === null) {
      await journalDenied(
        tx,
        UNRESOLVED_ACTOR,
        AUTH_REASON_KEYS.identityChallengeNotFound,
        now,
        input.origin,
      );
      return failure(uniformIdentityRejection);
    }
    const account = await tx.accounts.find(challenge.accountId);
    if (account === null) {
      await journalDenied(
        tx,
        UNRESOLVED_ACTOR,
        AUTH_REASON_KEYS.identityAccountUnknown,
        now,
        input.origin,
      );
      return failure(uniformIdentityRejection);
    }
    const verification = verifyChallenge(challenge, input.code, deps.derivation, now);
    if (verification.challenge !== challenge) {
      // Записывается новое состояние вызова, а не исход: попытка засчитана
      // независимо от того, что решено дальше.
      await tx.challenges.save(verification.challenge);
    }
    if (!verification.outcome.ok) {
      await journalDenied(tx, actorOf(account), verification.outcome.error, now, input.origin);
      return failure(uniformIdentityRejection);
    }

    /*
     * Срок сессии берётся у политики роли и не приходит снаружи: аргумент-срок
     * означал бы, что вызывающий назначает себе сутки там, где политика даёт
     * пятнадцать минут. Второго фактора у входа по коду нет ни одного, поэтому
     * консольные и внешние роли здесь **не входят** — `establishSession`
     * откажет `secondFactorMissing`, и это верный отказ: устойчивого к фишингу
     * канала у нас пока нет вовсе (`ACTORS.md` §11 Р6 A).
     */
    const established = establishSession(
      {
        sessionId: deps.ids.session(),
        accountId: account.accountId,
        personId: account.personId,
        roleId: account.roleId,
        onDuty: false,
        primary: {
          method: CODE_PRIMARY_METHOD,
          at: now,
          device: input.origin.device,
          network: input.origin.network,
        },
        factors: [],
        requestedTtl: policyForRole(account.roleId).maxTtl,
      },
      now,
    );
    if (!established.ok) {
      await journalDenied(tx, actorOf(account), established.error, now, input.origin);
      return failure(uniformIdentityRejection);
    }
    await tx.sessions.save(established.value);
    await tx.journal.append(sessionEstablished(established.value, null));
    return ok(established.value);
  });
}

/* ------------------------------------------------------------------------- */
/* Выход                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Выход: сессия отзывается, и отзыв — **запись**, а не пропажа строки.
 *
 * Идемпотентен по построению: выход из сессии, которой нет или которая уже
 * отозвана, — это тот же исход «доступа больше нет», а не ошибка. Кнопка
 * «выйти», падающая на второй нажатии, приучает игнорировать её отказ.
 */
export async function signOut(
  deps: SignInDeps,
  input: { readonly sessionId: string },
): Promise<Result<null, AuthReasonKey>> {
  const now = deps.now();
  return deps.store.transact(async (tx) => {
    const session = await loadSession(tx, input.sessionId);
    if (session === null || session.revokedAt !== null) return ok(null);
    const revoked = revoke(session, now);
    await tx.sessions.save(revoked);
    await tx.journal.append(sessionRevoked(revoked, AUTH_REASON_KEYS.sessionRevoked, now));
    return ok(null);
  });
}

/* ------------------------------------------------------------------------- */
/* Чтение сессии по запросу                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Сессия из хранилища по идентификатору из куки.
 *
 * Ничего не решает: годна ли сессия, отвечает `sessionStatus` (`@sdelka/auth`),
 * а полномочия — `authorize` (`authority.ts`). Здесь только чтение, и оно
 * возвращает `null` на неверной форме идентификатора: строка из куки приходит
 * от кого угодно, и исключение на ней означало бы, что подделанная кука роняет
 * страницу вместо того, чтобы просто не быть сессией.
 */
export async function readSession(deps: SignInDeps, id: string): Promise<Session | null> {
  return deps.store.transact((tx) => loadSession(tx, id));
}

/* ------------------------------------------------------------------------- */
/* Общее                                                                     */
/* ------------------------------------------------------------------------- */

async function loadChallenge(
  tx: AuthTransaction,
  id: string,
): Promise<IdentityChallenge | null> {
  const typed = safeChallengeId(id);
  return typed === null ? null : tx.challenges.load(typed);
}

async function loadSession(tx: AuthTransaction, id: string): Promise<Session | null> {
  const typed = safeSessionId(id);
  return typed === null ? null : tx.sessions.load(typed);
}

/**
 * Идентификатор из запроса — либо годный, либо `null`.
 *
 * Исключение здесь означало бы, что подделанное значение в куке или в адресе
 * роняет обработчик, а упавший обработчик отличается от «не нашлось» и по коду
 * ответа, и по времени.
 */
function safeChallengeId(value: string): ChallengeId | null {
  try {
    return toChallengeId(value);
  } catch {
    return null;
  }
}

function safeSessionId(value: string): SessionId | null {
  try {
    return toSessionId(value);
  } catch {
    return null;
  }
}

async function journalDenied(
  tx: AuthTransaction,
  actor: Parameters<typeof sessionDenied>[0],
  reason: AuthReasonKey,
  at: Instant,
  origin: SignInOrigin,
): Promise<void> {
  await tx.journal.append(
    sessionDenied(actor, CODE_PRIMARY_METHOD, reason, at, origin.device, origin.network),
  );
}
