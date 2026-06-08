import { OpenAPIHono } from '@hono/zod-openapi'
import type { Env } from './lib/types'
import fileRoutes from './routes/files'
import adminRoutes from './routes/admin'

const app = new OpenAPIHono<{ Bindings: Env }>()

app.route('/', fileRoutes)
app.route('/', adminRoutes)

export default app
