import { createApp } from './app.ts'
import { adminStatus } from './admin.ts'
import { config } from './config.ts'
import { sweep } from './game.ts'
import { importPendingBatches } from './questions.ts'

importPendingBatches(config.batchDir)
setInterval(() => { try { sweep() } catch (e) { console.error('sweep', e) } }, 30 * 60_000).unref()

const server = createApp()
server.listen(config.port, '0.0.0.0', () => {
  console.log(`Ratespaß läuft auf http://0.0.0.0:${config.port} (Admin: ${adminStatus()})`)
})
const stop = () => server.close(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
