-- 0013 — справочник и гранты для пяти полномочий из `0012`.
--
-- Отдельный файл, потому что метку перечня нельзя использовать в той же
-- транзакции, в которой она добавлена; довод целиком — в шапке `0012`.
--
-- Обе вставки — **дописывание**, а не переписывание: `0010` применена, править
-- её нельзя (контрольная сумма, `src/migrate.ts`). Тест дрейфа
-- (`test/auth-reference.test.ts`) читает засев по всем миграциям подряд,
-- поэтому порядок строк здесь обязан продолжать порядок `0010`: полномочия — в
-- порядке `CAPABILITIES`, пары «роль → полномочие» — в порядке
-- `ROLE_CAPABILITIES` внутри каждой роли.

SET LOCAL ROLE sdelka_owner;

-- packages/auth: CAPABILITY_SPECS
--
-- Второго фактора нет только у подготовки расчёта: она ничего не двигает сама,
-- а всё, что готовит, проходит через утверждение, у которого фактор есть.
-- `operate_treasury` — единственный `release` из пяти: здесь двигаются деньги
-- платформы (недостача признаётся её расходом, комиссия уходит на операционный
-- счёт), а не готовится чужая операция.
INSERT INTO sdelka.auth_capability (capability, effect, second_factor, journaled) VALUES
  ('prepare_settlement',   'prepare',  'none',     true),
  ('record_bank_outcome',  'prepare',  'step_up',  true),
  ('operate_treasury',     'release',  'step_up',  true),
  ('conduct_withdrawal',   'prepare',  'step_up',  true),
  ('patch_tranche_facts',  'prepare',  'step_up',  true);

-- packages/auth: ROLE_CAPABILITIES
--
-- Носителей два, и это разделение обязанностей, а не вкус: ОП готовит расчёт и
-- вносит внешний факт платежа, ФК двигает деньги платформы. Ни одного из пяти
-- нет у владельца (Н6), стороны, поддержки и аудитора; ни одно не выдаётся
-- дежурством (§7.3 — дежурство добавляет только сужающие).
INSERT INTO sdelka.role_capability (role_id, capability, requires_duty) VALUES
  ('operator',              'prepare_settlement',   false),
  ('operator',              'record_bank_outcome',  false),
  ('operator',              'conduct_withdrawal',   false),
  ('operator',              'patch_tranche_facts',  false),
  ('financial_controller',  'operate_treasury',     false);
