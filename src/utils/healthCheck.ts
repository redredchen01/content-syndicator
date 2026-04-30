import { logger } from './logger';
// Using fetch for health check
export async function performHealthCheck(url: string, platform: string) {
  try {
    const response = await fetch(url, { method: "GET", headers: { "User-Agent": "Mozilla/5.0" }, redirect: 'follow' });
    if (response.ok) {
      logger.success(`[HealthCheck] ${platform} link healthy: ${url}`);
      return { status: 'healthy' };
    } else {
      logger.error(`[HealthCheck] ${platform} link returned ${response.status}: ${url}`);
      return { status: 'down', error: `Status ${response.status}` };
    }
  } catch (e: any) {
    logger.error(`[HealthCheck] Link check failed: ${url}`, e);
    return { status: 'down', error: e.message };
  }
}
