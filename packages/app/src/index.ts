/**
 * `@sdelka/app` — слой приложения.
 *
 * Здесь живёт всё, что не является ни доменом, ни учётом, ни журналом, но без
 * чего они не работают: мир, проверка инвариантов после каждого шага, проекция
 * намерений автоматов в проводки, планировщик (вызывающий у часов), драйвер
 * машины наблюдения и порты внешних источников.
 *
 * **Почему пакет появился.** Всё перечисленное лежало в `packages/e2e` — то
 * есть в пакете сквозных тестов. Проверка `grep '@sdelka/e2e'` вне самого
 * пакета не давала ни одного попадания: инвариант «собранное обеспечено
 * учётом» и планировщик, превращающий наступивший дедлайн в событие,
 * существовали **только внутри тестов**. В продукте фантомного собранного не
 * ловил никто, а вызывающего у часов не было вовсе — семь остывших статусов
 * получали дедлайн, который никто не читал. Тест, который проверяет то, чего
 * нет в продукте, зелёный по построению.
 *
 * Теперь этим слоем может пользоваться и `apps/web`, и будущий сервер, а
 * `packages/e2e` остаётся тем, чем называется, — сквозными сценариями.
 */
/**
 * ⚠ **`authority.ts` реэкспортируется поимённо, а не звёздочкой.**
 *
 * В нём живут два конструктора машинных разрешений — `clockAuthority` и
 * `oracleAuthority`, — и наружу они не выходят намеренно. Иначе «шаг без
 * сессии» был бы доступен любому, кто их позовёт: события часов
 * (`reserve_expired`, `deadline_reached`) подавал бы кто угодно, а
 * `condition_established` — вообще любой, минуя машину наблюдения. Внутри
 * пакета их зовут ровно два места: `tick` и исполнитель намерений оракула.
 *
 * `export *` здесь был бы дырой, которую не видно на ревью: она открывается не
 * строкой кода, а её отсутствием.
 */
export {
  type ActionSubject,
  type Authority,
  type OpenedSession,
  type SessionOpening,
  type StepOrigin,
  AuthorityError,
  ORACLE_ACTOR,
  PLATFORM_SUBJECT,
  SYSTEM_ACTOR,
  actingAccount,
  adoptSession,
  actingPerson,
  actingRole,
  actionContextFor,
  authorize,
  dealSubject,
  journalActor,
  openSession,
  requireAuthority,
  requireSamePerson,
  revokeSession,
  sessionOf,
  statusOfSession,
  touchSession,
  trancheSubject,
} from './authority';
export * from './origins';
/**
 * ⚠ **`application.ts` вывозится целиком, и это безопасно.**
 *
 * Мира он не собирает и не трогает: заявка на сделку — запись до сделки, у неё
 * нет ни проводки, ни притязания, ни состояния в `World`. Наружу выходят
 * сценарии (подача, свои заявки, очередь неразобранных), узкий порт хранилища и
 * автомат состояний заявки; ни одна из этих функций не даёт ни завести сделку,
 * ни обойти `Authority`.
 */
export * from './application';
/**
 * ⚠ **`intake-halt.ts` вывозится целиком, и это безопасно.**
 *
 * Ни одна его функция не даёт собрать мир: остановку ставит либо автомат
 * закрытия банковского дня (разрешение часов, наружу не выходит), либо человек
 * с полномочием `halt_intake`; снимают её двое с `lift_halt`. Отказ на входе
 * (`assertIntakeOpen`) зовут `createDeal` и `createTranche` — снаружи его можно
 * только позвать ещё раз, но не обойти.
 */
export * from './intake-halt';
export * from './correction';
export * from './disclosure';
export * from './flow';
export * from './keys';
export * from './ledger-app';
export * from './ports';
export * from './scheduler';
export * from './sign-in';
/**
 * ⚠ **`store.ts` вывозится целиком, и это безопасно.**
 *
 * Ни одна его функция не собирает мир: `stepWorld` принимает шаг, который
 * возвращает уже запечатанный `World`, а `restoreWorld` возвращает снимки, а не
 * мир. Дверью мимо `sealed` хранилище не является ни в одну сторону.
 */
export * from './store';
/**
 * ⚠ **`resume.ts` — единственный вход в `World` из хранилища, и он тоже не
 * лазейка.**
 *
 * `resumeWorld` собирает мир **только** из записанного, проводит его через ту
 * же проверку, что и запечатывание (`surfaceViolations` плюс притязания на
 * собранное), и отдаёт нарушение значением, а не миром. Снаружи он принимает
 * ровно один вид фактов — собранную сумму по живому траншу, — и её немедленно
 * проверяет учёт. Подписей, полномочий, реквизитов и следов «кто готовил» он не
 * принимает вовсе: аргумента под них нет, а умолчания у них закрытые. Поэтому
 * поднятый мир строго беднее живого: он умеет вернуть деньги покупателю и не
 * умеет выплатить.
 */
export * from './resume';
/**
 * ⚠ **`seed.ts` вывозится целиком, и это безопасно.**
 *
 * Засев не собирает мир сам: он зовёт те же шаги, что и продукт, под теми же
 * полномочиями и пишет через тот же порт. Дверью мимо `sealed` он не является
 * ни в одну сторону, а отказ работать на настоящих данных стоит выше — там, где
 * известна схема (`@sdelka/db`).
 */
export * from './seed';
export * from './unwind';
export * from './withdrawal';
/**
 * ⚠ **`withdrawal-clock.ts` — величина владельца, а не константа.**
 *
 * Часы заявки (срок операции и норматив простоя) приходят версией настройки:
 * пустой журнал версий — отказ, а не «взять умолчание». Временное значение
 * (`PROVISIONAL_WITHDRAWAL_CLOCK_VALUE`) существует ровно для того, чтобы им
 * завели первую версию. `DECISIONS-REVIEW.md` §H4 **[открыто]**.
 */
export * from './withdrawal-clock';
/**
 * Дорога от журнала версий тарифа до транша (`tariff.ts`, `@sdelka/pricing`).
 *
 * Наружу выходят тип тарифа транша, его разрешение на момент создания и ссылка
 * на версию. Ни одной величины: числа тарифа принадлежат владельцу
 * (`DECISIONS-REVIEW.md` §J **[открыто]**), а журнал версий заводится
 * средствами `@sdelka/pricing` и кладётся в мир при его создании.
 */
export * from './tariff';
/**
 * ⚠ **`world.ts` тоже вывозится поимённо.**
 *
 * Наружу не выходят `sealed`, `recorded`, `withTranche`, `withDeal` и
 * `seedWorld`. Каждая из них принимает уже существующий мир и возвращает новый —
 * то есть даёт собрать транш с любыми фактами и любыми подписями, минуя и
 * полномочие, и автомат: `sealed({ ...world, tranches: withTranche(world, {
 * ...runtime, approvalRecords: [подделка] }) })` набирал бы кворум без единой
 * сессии. Внутри пакета они и есть переходы мира; снаружи вход один — шаги
 * `flow.ts`, `unwind.ts`, `withdrawal.ts` и `scheduler.ts`, и каждый требует
 * `Authority`.
 *
 * Проверок, чтения и вспомогательных величин это не касается — они ниже.
 */
export {
  type ActingParty,
  type ActionFact,
  type ActionFactKind,
  type AppInvariant,
  type DealRuntime,
  type InvariantSurface,
  type InvariantViolation,
  type MachineOrigin,
  type Notification,
  type IntakeHalt,
  type IntakeHaltLift,
  type ObservationTask,
  type SuppressedEntry,
  type SurfaceTranche,
  type TrancheRuntime,
  type UnwindApproval,
  type UnwindReview,
  type World,
  ACTION_FACT_KINDS,
  APP_INVARIANTS,
  AppInvariantError,
  coverageOk,
  dealOf,
  invariantViolations,
  moneyLabel,
  payerOf,
  recipientOf,
  surfaceOf,
  surfaceViolations,
  trancheOf,
} from './world';
