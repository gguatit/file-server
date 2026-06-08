import app from './app'
import { cleanupExpiredFiles } from './services/cleanup'
import type { Env } from './lib/types'

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(req, env, ctx)
  },
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    if (event.cron === '0 0,12 * * *') {
      const result = await cleanupExpiredFiles(env.FILE_BUCKET)
      console.log(
        `[cleanup] deleted=${result.deleted} errors=${result.errors}`,
      )
    }
  },
}
