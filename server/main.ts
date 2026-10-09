import { createApp } from './app.ts'
import { adminStatus } from './admin.ts'
import { config } from './config.ts'
import { sweep } from './game.ts'
import { sweepRooms } from './rooms.ts'
import { importPendingBatches } from './questions.ts'
import { autoRun } from './ai.ts'
import { sweepProfiles } from './erase.ts'
import { resumeLive, sweepLive } from './live.ts'
import { missingSettings } from './privacy.ts'

importPendingBatches(config.batchDir)
resumeLive()
setInterval(() => { try { sweep(); sweepRooms(); sweepProfiles(); sweepLive() } catch (e) { console.error('sweep', e) } }, 30 * 60_000).unref()

// KI-Auto-Lauf (nur mit ANTHROPIC_API_KEY und AI_AUTO=1 bzw. im Admin eingeschaltet): neue Fragen landen immer in der Moderation
setInterval(() => { autoRun().catch((e) => console.error('ai auto', e?.message ?? e)) }, 60 * 60_000).unref()

const miss = missingSettings()
if (miss.length) console.warn(`Datenschutz: Pflichtangaben fehlen (${miss.join(', ')}) – die Erklärung zeigt Platzhalter. Bitte als Umgebungsvariablen setzen.`)

const server = createApp()
server.listen(config.port, '0.0.0.0', () => {
  console.log(`Ratespaß läuft auf http://0.0.0.0:${config.port} (Admin: ${adminStatus()})`)
})
const stop = () => server.close(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
