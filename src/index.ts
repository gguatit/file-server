import app from './app'

export default {
  fetch(req: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    return app.fetch(req, env as any, ctx)
  },
}
