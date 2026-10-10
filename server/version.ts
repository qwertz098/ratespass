// App-Version 0.0.<Anzahl Commits>: wird nicht von Hand gepflegt. Reihenfolge: APP_VERSION (Docker-Build-Argument, setzt build+deploy.bat bzw. die
// Publish-Action), sonst aus dem Git-Verlauf (Entwicklung), sonst 0.0.0. Der Browser holt sie als /version.js (App) und /sw-version.js (Service Worker).
import { execFileSync } from 'node:child_process'
import { config } from './config.ts'

function fromGit(): string | undefined {
  try {
    const n = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: config.root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim()
    return /^\d+$/.test(n) ? `0.0.${n}` : undefined
  } catch { return undefined }
}
export const VERSION = (process.env.APP_VERSION ?? '').trim() || fromGit() || '0.0.0'
