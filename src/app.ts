import { OpenAPIHono } from '@hono/zod-openapi'
import type { Env } from './lib/types'
import fileRoutes from './routes/files'

const app = new OpenAPIHono<{ Bindings: Env }>()

app.route('/', fileRoutes)

export default app
