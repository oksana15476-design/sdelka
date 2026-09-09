import { register } from 'node:module';

/**
 * Ставит хук разрешения (`resolve-ts.mjs`) перед запуском команды.
 * Подключается флагом `--import`, а не импортом из самой команды: хук обязан
 * встать **до** того, как node начнёт разбирать её импорты.
 */
register('./resolve-ts.mjs', import.meta.url);
