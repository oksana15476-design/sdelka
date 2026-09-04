-- 0005 — выплаты и выводы: частичный уникальный индекс.
--
-- `CLAUDE.md`, «Инварианты, проверяемые базой»: «не более одной выплаты по
-- траншу в активных статусах — частичный уникальный индекс». `FUNCTIONAL.md`
-- §2, инвариант 9.

SET LOCAL ROLE sdelka_owner;

CREATE TABLE sdelka.payout (
  payout_id text PRIMARY KEY CHECK (length(payout_id) > 0 AND length(payout_id) <= 128),
  deal_id text NOT NULL,
  tranche_id text NOT NULL,
  status sdelka.payout_status NOT NULL,

  -- Ключ идемпотентности детерминирован **по траншу** и только по нему
  -- (`payoutIdempotencyKey`, инвариант 13): ни номера попытки, ни времени, иначе
  -- повтор при потерянном ответе банка создаст вторую выплату.
  --
  -- Глобального `UNIQUE` на этой колонке нет **намеренно**. Повторная выплата
  -- после `rejected` несёт тот же ключ — он функция транша, — и глобальная
  -- уникальность запретила бы задокументированный путь восстановления
  -- `paying_out --payout_result(rejected)--> release_blocked → release_pending →
  -- paying_out` (`STATE-MACHINES.md` §1.4). Уникальность живёт ровно там, где
  -- она означает то, что нужно: в частичном индексе по активным статусам.
  idempotency_key uuid NOT NULL,

  -- Красная линия №5: «выплата невозможна без ссылки на пакет доказательств.
  -- Кнопки „просто выплатить“ не существует». `NOT NULL` на уровне колонки —
  -- это и есть отсутствие такой кнопки.
  evidence_bundle_id text NOT NULL CHECK (length(evidence_bundle_id) > 0),

  amount_minor numeric(38, 0) NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL REFERENCES sdelka.currency (code),
  beneficiary_party_id text NOT NULL REFERENCES sdelka.party (party_id),

  created_at timestamptz NOT NULL DEFAULT now(),
  -- Ответ провайдера, если он был. NULL — ответа нет, и это `unknown`.
  provider_reference text,

  FOREIGN KEY (deal_id, tranche_id) REFERENCES sdelka.tranche (deal_id, tranche_id),

  -- `STATE-MACHINES.md` §2.2: ни один адаптер не возвращает «отказ» при сетевой
  -- ошибке — только «неизвестно». Отказ — это явный ответ провайдера, поэтому
  -- у него обязана быть ссылка на ответ; у `unknown` её быть не может.
  CONSTRAINT payout_unknown_has_no_response CHECK (
    status <> 'unknown' OR provider_reference IS NULL
  )
);

-- Инвариант 9 целиком.
--
-- Предикат — дословно `ACTIVE_PAYOUT_STATUSES` (`domain/src/payout.ts`).
-- `unknown` здесь **активен**, и это главное: деньги, возможно, ушли
-- (`STATE-MACHINES.md` §2.2, красная линия №8). Считать «неизвестно»
-- завершением значило бы разрешить вторую выплату по тому же траншу ровно в тот
-- момент, когда первая, вероятно, исполнена.
CREATE UNIQUE INDEX payout_one_active_per_tranche
  ON sdelka.payout (deal_id, tranche_id)
  WHERE status IN ('created', 'submitted', 'unknown');

-- ---------------------------------------------------------------------------
-- Вывод со счёта клиента — ROADMAP.md И12.2
-- ---------------------------------------------------------------------------
--
-- Своя машина и свой ключ идемпотентности (`withdrawalIdempotencyKey`): у
-- вывода транша нет вовсе, поэтому ключ по траншу здесь не годится.
CREATE TABLE sdelka.withdrawal (
  withdrawal_id text PRIMARY KEY CHECK (length(withdrawal_id) > 0 AND length(withdrawal_id) <= 128),
  party_id text NOT NULL REFERENCES sdelka.party (party_id),
  status sdelka.withdrawal_status NOT NULL,
  idempotency_key uuid NOT NULL,

  amount_minor numeric(38, 0) NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL REFERENCES sdelka.currency (code),

  -- Красная линия №9: возврат и вывод — только на счёт-источник, на имя
  -- плательщика. Здесь отпечаток реквизитов, а не сами реквизиты
  -- (`compliance/src/pii.ts`): номер счёта в открытом виде в базе не живёт.
  source_account_fingerprint text NOT NULL CHECK (source_account_fingerprint ~ '^[0-9a-f]{64}$'),

  created_at timestamptz NOT NULL DEFAULT now()
);

-- Зеркало `g_no_active_withdrawal` (`domain/src/client-account.ts`): вывод не
-- выпускается, пока по счёту есть незавершённый.
--
-- ⚠ **Решение там, где спека молчит.** Домен считает активные выводы числом
-- (`facts.activeWithdrawals`), а какие статусы в это число входят, не сказано
-- нигде. Берём все нетерминальные: `WITHDRAWAL_STATUSES` минус
-- `TERMINAL_WITHDRAWAL_STATUSES`. Следствие: заблокированный вывод не даёт
-- завести следующий, пока оператор его не отменит (`blocked → cancelled` в
-- таблице переходов есть). Это сознательно закрытая сторона: незавершённый
-- вывод, о котором забыли, — худшее из двух состояний.
CREATE UNIQUE INDEX withdrawal_one_active_per_party
  ON sdelka.withdrawal (party_id)
  WHERE status IN ('requested', 'approved', 'paying_out', 'blocked');

GRANT SELECT, INSERT, UPDATE ON sdelka.payout, sdelka.withdrawal TO sdelka_app;
