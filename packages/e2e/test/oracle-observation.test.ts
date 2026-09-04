import { describe, expect, it } from 'vitest';
import { observationSatisfies } from '@sdelka/domain';
import { money } from '@sdelka/money';
import { accountBalance, clientLockedAccount } from '@sdelka/ledger';
import {
  advance,
  applyDealEvent,
  applyObservationEvent,
  applyTrancheEvent,
  approve,
  attachObservation,
  dealFactsOf,
  dealStatusOf,
  observationFromCard,
  observationSettled,
  receivePaidExtract,
  rejectDealEvent,
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  APPLICATION_ID,
  CADASTRAL_CODE,
  DAY_MS,
  GEL,
  OTHER_CADASTRAL_CODE,
  POLICY,
  POLICY_VERSION,
  SMALL_AMOUNT,
  cardOf,
  registryUnavailable,
  registryWithApplicationCard,
  registryWithEncumbrance,
  registryWithForeignObject,
  registryWithTransfer,
  registryWithoutOwnerDocumentNumber,
} from './support/fixtures';
import { toExtractOrdered, toReserved } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION);
const COST = money(GEL, 1_000n);

/**
 * Сценарий 13 — оракул регистрации в сквозном прогоне.
 *
 * Всё, что здесь проверяется, до этого батча не проверялось **ничем**:
 * `g_observation_sufficient` и `g_no_open_filing` появились в домене вместе с
 * `packages/oracle`, а вызывающего у машины наблюдения не было — заявления и
 * наблюдения приезжали в мир присваиванием фактов. Guard, который не звался ни
 * из одного сквозного сценария, проверен ровно нигде.
 *
 * Правило, вокруг которого собран весь файл, одно: **дешёвые сигналы управляют
 * таймингом, дорогие — деньгами** (`CORE.md` Ф7, `ORACLE.md` §2).
 */
describe('оракул регистрации', () => {
  it('бесплатное наблюдение запускает тайминг и не разрешает выплату ни одной дверью', async () => {
    const DEAL = 'deal-free-signal';
    const TRANCHE = 'tranche-free-signal';

    const reserved = await toReserved({ dealId: DEAL, trancheId: TRANCHE });
    let world = applyDealEvent(reserved.world, DEAL, { type: 'tranches_reserved' }, OPTIONS);
    world = applyObservationEvent(world, TRANCHE, { type: 'observation_started' }, OPTIONS).world;

    // --- Карточка заявления: L1, деньги не двигает ---
    const card = cardOf(registryWithApplicationCard(), APPLICATION_ID);
    const step = applyObservationEvent(
      world,
      TRANCHE,
      {
        type: 'filing_card_observed',
        applicationId: card.applicationId,
        cadastralCode: card.cadastralCode,
        applicationStatus: card.applicationStatus,
      },
      OPTIONS,
    );
    world = step.world;
    expect(step.state.status).toBe('filing_confirmed');
    // Тайминг запущен — намерением, а не переходом транша. Приложение это
    // намерение сегодня **не исполняет** (регламентный срок ведёт планировщик),
    // и потому оно обязано быть видно вызывающему, а не проглочено.
    expect(step.intents.map((intent) => intent.type)).toEqual([
      'register_filing',
      'start_statutory_clock',
    ]);
    expect(dealStatusOf(world, DEAL)).toBe('filed');

    // --- А деньги стоят ---
    // Наблюдение бесплатного уровня в фактах транша: пять полей выключены,
    // собственник не установлен. Даже если бы они были включены, guard уровня
    // стоит **раньше** guard'ов содержимого.
    const free = observationFromCard(card);
    expect(free.level).toBe('L1');
    expect(
      observationSatisfies(free, {
        conditionType: 'registration_transfer',
        expectedCadastralCode: CADASTRAL_CODE,
        now: world.now,
        policy: trancheOf(world, TRANCHE).facts.observationPolicy,
      }),
    ).toBe(false);

    // Первая дверь пути выплаты: `reserved --condition_established--> release_pending`.
    const firstDoor = rejectTrancheEvent(world, TRANCHE, {
      type: 'condition_established',
      evidenceBundleId: 'evidence-free',
      conditionType: 'registration_transfer',
    });
    expect([...firstDoor.failedGuards]).toContain('g_observation_sufficient');

    // Вторая дверь: разбор и выпуск обратно утверждением оператора. Именно её
    // §1.4 называет причиной, по которой guard'ы доказательств продублированы.
    world = applyObservationEvent(world, TRANCHE, { type: 'statutory_term_elapsed' }, OPTIONS).world;
    world = applyObservationEvent(world, TRANCHE, { type: 'extract_ordered', cost: COST }, OPTIONS).world;
    const secondDoor = rejectTrancheEvent(world, TRANCHE, {
      type: 'condition_established',
      evidenceBundleId: 'evidence-free',
      conditionType: 'registration_transfer',
    });
    expect([...secondDoor.failedGuards]).toContain('g_observation_sufficient');
    // Деньги как лежали в файле транша, так и лежат: бесплатный сигнал не
    // двинул ни тетри.
    expect(
      accountBalance(world.journal, clientLockedAccount(reserved.buyerKey, DEAL, TRANCHE), GEL).minor,
    ).toBe(20_000_000n);
  });

  it('платная выписка с пятью сошедшимися полями разрешает выплату', async () => {
    const DEAL = 'deal-paid-extract';
    const TRANCHE = 'tranche-paid-extract';

    const ordered = await toExtractOrdered({ dealId: DEAL, trancheId: TRANCHE });
    const answer = registryWithTransfer().paidExtract(CADASTRAL_CODE);
    if (answer.kind !== 'found') throw new Error('unreachable');

    const received = receivePaidExtract(
      ordered.world,
      TRANCHE,
      answer.value,
      'evidence-paid',
      POLICY,
      OPTIONS,
    );
    // Машина классифицировала документ, транш вывел из него то же самое своими
    // guard'ами. Два вывода из одного документа — и они сошлись.
    expect(received.state.status).toBe('matched');
    expect(trancheStatusOf(received.world, TRANCHE)).toBe('release_pending');
    const observation = trancheOf(received.world, TRANCHE).facts.observation;
    expect(observation?.level).toBe('L3');
    expect(observation?.ownerCheck).toBe('established');
    // Отпечаток сырого ответа — часть наблюдения по типу: разобранные поля без
    // исходника суд не убедит (`CORE.md` Ф11).
    expect(observation?.rawSourceDigest).toBe(answer.value.rawSource.digest);
    // Наблюдение терминально: добывать больше нечего.
    expect(observationSettled(received.world, TRANCHE)).toBe(true);
  });

  it('не даёт зарегистрировать заявление по сделке, не дошедшей до подачи', async () => {
    const DEAL = 'deal-early-filing';
    const TRANCHE = 'tranche-early-filing';

    // Сделка в `funding`: транши ещё не зарезервированы, до `funded` она не
    // дошла. Заявление здесь — расхождение данных, и оно обязано упасть
    // отказом автомата, а не осесть фактом в стороне от состояния.
    const reserved = await toReserved({ dealId: DEAL, trancheId: TRANCHE });
    expect(dealStatusOf(reserved.world, DEAL)).toBe('funding');
    let world = applyObservationEvent(
      reserved.world,
      TRANCHE,
      { type: 'observation_started' },
      OPTIONS,
    ).world;
    expect(() =>
      applyObservationEvent(
        world,
        TRANCHE,
        { type: 'filing_claimed', applicationId: 'app-early', byParty: 'party-buyer' },
        OPTIONS,
      ),
    ).toThrow('app.deal.rejected');
    expect(dealFactsOf(world, DEAL).filings).toEqual([]);
  });

  it('расхождение по одному полю уводит в разбор при любой сумме', async () => {
    const DEAL = 'deal-one-field';
    const TRANCHE = 'tranche-one-field';

    // Сумма — первая ступень утверждений: 100 000 ₾, одна подпись. Если бы
    // расхождение зависело от суммы, здесь оно и растворилось бы.
    const ordered = await toExtractOrdered({
      dealId: DEAL,
      trancheId: TRANCHE,
      amount: SMALL_AMOUNT,
    });
    const answer = registryWithEncumbrance().paidExtract(CADASTRAL_CODE);
    if (answer.kind !== 'found') throw new Error('unreachable');

    const received = receivePaidExtract(
      ordered.world,
      TRANCHE,
      answer.value,
      'evidence-one-field',
      POLICY,
      OPTIONS,
    );
    expect(received.state.status).toBe('mismatched');
    // Первое разошедшееся поле названо: обременение, которого стороны не
    // объявляли. Транш ушёл в разбор, а не к выплате.
    expect(received.intents).toEqual([
      { type: 'emit_tranche_event', event: 'mismatch_detected', field: 'encumbrance' },
      { type: 'enqueue_operator_task', kind: 'field_mismatch' },
    ]);
    expect(trancheStatusOf(received.world, TRANCHE)).toBe('release_blocked');
    // Задача оператору заведена, и **вид у неё свой**: «расхождение по полю», а
    // не умолчание транша «источник средств». Лежит она отдельным списком —
    // в `REVIEW_TASK_KINDS` из `@sdelka/compliance` этих трёх видов нет, и
    // подставлять чужой вид ради типа значило бы соврать оператору.
    expect(
      received.world.observationTasks.map((task) => [task.trancheId, task.kind]),
    ).toEqual([[TRANCHE, 'field_mismatch']]);

    // Выход из разбора утверждением оператора не открывает выплату: guard'ы
    // доказательств стоят и на втором ребре.
    let world = approve(received.world, TRANCHE, 'approver-1');
    world = approve(world, TRANCHE, 'approver-2');
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'approval_added', userId: 'approver-1' },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_pending');
    const blocked = rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' });
    expect([...blocked.failedGuards]).toContain('g_fields_match');
  });

  it('выписка без номера документа собственника даёт «недостаточно», а не проход', async () => {
    const DEAL = 'deal-owner-absent';
    const TRANCHE = 'tranche-owner-absent';

    const ordered = await toExtractOrdered({ dealId: DEAL, trancheId: TRANCHE });
    const answer = registryWithoutOwnerDocumentNumber().paidExtract(CADASTRAL_CODE);
    if (answer.kind !== 'found') throw new Error('unreachable');
    // Имя собственника в выписке совпадает с покупателем **точно**. Этого
    // недостаточно: латинизация грузинского необратима, и сверка по имени не
    // является основанием ни для чего (`CORE.md` Ф7).
    expect(answer.value.ownerDocumentNumber).toBe('absent');

    const received = receivePaidExtract(
      ordered.world,
      TRANCHE,
      answer.value,
      'evidence-owner-absent',
      POLICY,
      OPTIONS,
    );
    // ⚠ `insufficient`, а не `mismatched`: «мы не смогли установить» и «мы
    // установили обратное» — разные задачи оператору, и первая не должна
    // прятаться за второй (`ORACLE.md` §5.3).
    expect(received.state.status).toBe('insufficient');
    expect(received.intents).toEqual([
      { type: 'enqueue_operator_task', kind: 'owner_reconciliation' },
    ]);
    // «Собственника установить не смогли» — своя очередь, не «поле разошлось».
    expect(received.world.observationTasks.map((task) => task.kind)).toEqual([
      'owner_reconciliation',
    ]);
    // Транш не сдвинулся ни на шаг: у `insufficient` намерения `emit_tranche_event`
    // нет вовсе, то есть автоматического пути к выплате отсюда не существует.
    expect(trancheStatusOf(received.world, TRANCHE)).toBe('reserved');
    expect(trancheOf(received.world, TRANCHE).facts.observation?.ownerCheck).toBe('insufficient');

    // И вручную тоже нет: guard роняет ровно так же, как на `refuted`.
    const world = attachObservation(
      received.world,
      TRANCHE,
      answer.value,
      'evidence-owner-absent',
      POLICY,
    );
    const refused = rejectTrancheEvent(world, TRANCHE, {
      type: 'condition_established',
      evidenceBundleId: 'evidence-owner-absent',
      conditionType: 'registration_transfer',
    });
    expect([...refused.failedGuards]).toEqual(['g_owner_is_buyer']);
  });

  it('выписка по чужому объекту не разрешает выплату по нашей сделке', async () => {
    const DEAL = 'deal-foreign-object';
    const TRANCHE = 'tranche-foreign-object';

    const ordered = await toExtractOrdered({ dealId: DEAL, trancheId: TRANCHE });
    const answer = registryWithForeignObject().paidExtract(OTHER_CADASTRAL_CODE);
    if (answer.kind !== 'found') throw new Error('unreachable');
    // Выписка полноценная: L3, свежая, пять полей сошлись, собственник
    // установлен. Она просто не про нашу вещь.
    expect(answer.value.cadastralCode).toBe(OTHER_CADASTRAL_CODE);

    const received = receivePaidExtract(
      ordered.world,
      TRANCHE,
      answer.value,
      'evidence-foreign',
      POLICY,
      OPTIONS,
    );
    expect(received.state.status).toBe('insufficient');
    expect(trancheStatusOf(received.world, TRANCHE)).toBe('reserved');

    const refused = rejectTrancheEvent(received.world, TRANCHE, {
      type: 'condition_established',
      evidenceBundleId: 'evidence-foreign',
      conditionType: 'registration_transfer',
    });
    expect([...refused.failedGuards]).toEqual(['g_observation_sufficient']);
  });

  it('устаревшая выписка перестаёт быть основанием', async () => {
    const DEAL = 'deal-stale-extract';
    const TRANCHE = 'tranche-stale-extract';

    const ordered = await toExtractOrdered({ dealId: DEAL, trancheId: TRANCHE });
    const answer = registryWithTransfer().paidExtract(CADASTRAL_CODE);
    if (answer.kind !== 'found') throw new Error('unreachable');
    let world = attachObservation(ordered.world, TRANCHE, answer.value, 'evidence-stale', POLICY);

    // Сегодня она годится: тот же документ, тот же транш — переход проходит.
    expect(
      trancheStatusOf(
        applyTrancheEvent(
          world,
          TRANCHE,
          {
            type: 'condition_established',
            evidenceBundleId: 'evidence-stale',
            conditionType: 'registration_transfer',
          },
          OPTIONS,
        ).world,
        TRANCHE,
      ),
    ).toBe('release_pending');

    // Тот же самый шаг сутками позже.
    world = advance(world, DAY_MS + 1);
    const stale = rejectTrancheEvent(world, TRANCHE, {
      type: 'condition_established',
      evidenceBundleId: 'evidence-stale',
      conditionType: 'registration_transfer',
    });
    // Выписка суточной давности не утверждает ничего о сегодняшних
    // обременениях (`JUSTICE-API.md` §3.1, ст. 10(1)).
    expect([...stale.failedGuards]).toEqual(['g_observation_sufficient']);
  });

  it('недоступность реестра не читается как «всё хорошо»', async () => {
    const DEAL = 'deal-registry-down';
    const TRANCHE = 'tranche-registry-down';

    const ordered = await toExtractOrdered({ dealId: DEAL, trancheId: TRANCHE });
    const answer = registryUnavailable().paidExtract(CADASTRAL_CODE);
    expect(answer.kind).toBe('unavailable');
    if (answer.kind !== 'unavailable') throw new Error('unreachable');

    const down = applyObservationEvent(
      ordered.world,
      TRANCHE,
      { type: 'registry_unavailable', reasonKey: answer.reasonKey },
      OPTIONS,
    );
    // Состояние нетерминальное: у наблюдения нет ни вердикта, ни выхода к
    // деньгам. Часы **сделки** приостанавливаются намерением — и намерением
    // остаются: приложение его сегодня не исполняет, и это видно вызывающему,
    // а не спрятано (`ORACLE.md` §10, §11).
    expect(down.state.status).toBe('unavailable');
    expect(down.intents).toEqual([
      { type: 'suspend_deal_clock', reasonKey: 'oracle.registry.unavailable' },
    ]);
    expect(trancheStatusOf(down.world, TRANCHE)).toBe('reserved');

    // Единственный выход — обратно к заказу выписки. Ни в «сошлось», ни в
    // «не сошлось».
    const back = applyObservationEvent(down.world, TRANCHE, { type: 'registry_recovered' }, OPTIONS);
    expect(back.state.status).toBe('extract_due');
    expect(back.intents.map((intent) => intent.type)).toEqual([
      'order_paid_extract',
      'resume_deal_clock',
    ]);
  });

  it('запрещает автооткат при подтверждённом заявлении и разрешает при названном стороной', async () => {
    // --- Заявление подтверждено карточкой: откат по отсечке запрещён (Ф9) ---
    const CONFIRMED = 'deal-filing-confirmed';
    const confirmed = await toExtractOrdered({
      dealId: CONFIRMED,
      trancheId: 'tranche-filing-confirmed',
    });
    expect(dealStatusOf(confirmed.world, CONFIRMED)).toBe('filed');
    expect(dealFactsOf(confirmed.world, CONFIRMED).filings.map((filing) => filing.source)).toEqual([
      'application_card',
    ]);
    const refused = rejectDealEvent(confirmed.world, CONFIRMED, { type: 'deadline_reached' });
    expect([...refused.failedGuards]).toEqual(['g_no_open_filing']);
    // ⚠ Это ровно тот сценарий, который Ф9 называет производящим конфликт:
    // резерв снят, деньги у покупателя, объект наутро регистрируется на него же.

    // ⚠ Надгробие. Ф9 запрещает **автоматический** откат, а отзыв — явное
    // волеизъявление покупателя (§1.4), и по замыслу он должен быть возможен и
    // здесь. В таблице переходов ребра `filed --revocation_requested--> …`
    // **нет**: отзыв выражен только из `funding`. То есть после подачи
    // заявления покупатель не может отозвать средства вовсе — ни автоматически,
    // ни руками. Расхождение названо в отчёте; таблица в `packages/domain`,
    // чужой пакет, в этом батче не правится.
    const noRevocation = rejectDealEvent(confirmed.world, CONFIRMED, {
      type: 'revocation_requested',
    });
    expect(noRevocation.code).toBe('domain.transition.not_allowed');

    // --- Заявление только названо стороной: откат по отсечке законен ---
    const CLAIMED = 'deal-filing-claimed';
    const TRANCHE = 'tranche-filing-claimed';
    const reserved = await toReserved({ dealId: CLAIMED, trancheId: TRANCHE });
    let world = applyDealEvent(reserved.world, CLAIMED, { type: 'tranches_reserved' }, OPTIONS);
    world = applyObservationEvent(world, TRANCHE, { type: 'observation_started' }, OPTIONS).world;
    world = applyObservationEvent(
      world,
      TRANCHE,
      { type: 'filing_claimed', applicationId: 'app-claimed', byParty: 'party-buyer' },
      OPTIONS,
    ).world;
    expect(dealFactsOf(world, CLAIMED).filings.map((filing) => filing.source)).toEqual([
      'party_claim',
    ]);
    // Непроверенный номер нашим дедлайном не управляет: иначе сторона
    // останавливает откат одним сообщением (И3.2, критерий 1).
    const unwound = applyDealEvent(world, CLAIMED, { type: 'deadline_reached' }, OPTIONS);
    expect(dealStatusOf(unwound, CLAIMED)).toBe('unwinding');
  });

  it('карточка с чужим кадастровым кодом не подтверждает нашу подачу', async () => {
    const DEAL = 'deal-foreign-card';
    const TRANCHE = 'tranche-foreign-card';

    const reserved = await toReserved({ dealId: DEAL, trancheId: TRANCHE });
    let world = applyDealEvent(reserved.world, DEAL, { type: 'tranches_reserved' }, OPTIONS);
    world = applyObservationEvent(world, TRANCHE, { type: 'observation_started' }, OPTIONS).world;

    // «Сторона называет чужой номер» — крайний случай И3.2. Отказ виден: это
    // не «карточка ничего не сделала», а «подтверждения не случилось».
    expect(() =>
      applyObservationEvent(
        world,
        TRANCHE,
        {
          type: 'filing_card_observed',
          applicationId: APPLICATION_ID,
          cadastralCode: OTHER_CADASTRAL_CODE,
          applicationStatus: 'in_progress',
        },
        OPTIONS,
      ),
    ).toThrow('oracle.filing_card.cadastral_mismatch');
    expect(dealStatusOf(world, DEAL)).toBe('funded');
    expect(dealFactsOf(world, DEAL).filings).toEqual([]);
  });
});
