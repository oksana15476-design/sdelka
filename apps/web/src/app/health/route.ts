import { probeAuthConfig, probeDatabase } from '@/health/probe';
import { healthReport } from '@/health/state';

/**
 * `GET /health` — проверка здоровья для оркестратора и дежурного.
 *
 * Отвечает на три вопроса разом: **жив ли процесс** (сам факт ответа),
 * **готова ли база** (`db`) и **настроен ли вход** (`auth`). Проба «процесс
 * поднялся» бесполезна: контейнер с недоступной базой отвечает на порт и
 * выглядит здоровым — как и контейнер, в который войти нельзя вовсе.
 *
 * Путь вне сегмента языка намеренно — это не экран, а служебная точка; в
 * `middleware.ts` он исключён из перенаправления на язык, иначе `/health`
 * отвечал бы редиректом.
 *
 * Коды: `200` — готов; `503` — не готов (база недоступна, не накачена, ответила
 * отказом либо вход настроен неверно). Тело — технические ключи, без значений
 * окружения (красная линия №12).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  const report = healthReport(await probeDatabase(), probeAuthConfig());
  return Response.json(report.body, {
    status: report.status,
    // Ответ проверки здоровья не кэшируется нигде и никогда: закэшированное
    // «ok» переживает отказ базы и рассказывает о нём неправду.
    headers: { 'cache-control': 'no-store' },
  });
}
