// Freischaltbare Kategorie-Stufen: „basic“ ist für alle offen, „nerd“/„expert“ gelten pro Spieler.
// Freigeschaltet wird per Code (vom Admin erzeugt, auch als Link `#/unlock/CODE`) oder direkt durch den Admin.
// Wer als Rundenwähler eine Stufe freigeschaltet hat, bekommt deren Kategorien zur Auswahl; die Gegnerin oder der Gegner
// spielt die gewählte Kategorie mit – auch ohne eigene Freischaltung.
import { CATEGORIES, TIERS, isTier, tierOf, type Tier } from './categories.ts'
import { all, get, run, tx, now } from './db.ts'
import { HttpError } from './http.ts'
import { randomCode } from './auth.ts'

export const playerTiers = (playerId: number): Tier[] =>
  ['basic', ...all<{ tier: Tier }>('SELECT tier FROM unlocks WHERE player_id=?', playerId).map((r) => r.tier)] as Tier[]

export const openCategories = (playerId: number): Set<string> => {
  const t = new Set(playerTiers(playerId))
  return new Set(CATEGORIES.filter((c) => t.has(tierOf(c))))
}

export function grant(playerId: number, tier: unknown, via: string) {
  if (!isTier(tier) || tier === 'basic') throw new HttpError(400, 'bad_tier')
  run('INSERT OR IGNORE INTO unlocks(player_id,tier,via,created_at) VALUES(?,?,?,?)', playerId, tier, via, now())
}

export function createCode(tier: unknown, maxUses: unknown, note: unknown, days: unknown) {
  if (!isTier(tier) || tier === 'basic') throw new HttpError(400, 'bad_tier')
  const max = Math.min(10_000, Math.max(1, Math.floor(Number(maxUses) || 1)))
  const d = Number(days)
  const expires = d > 0 ? now() + Math.floor(d) * 86_400_000 : null
  const code = randomCode(8)
  run('INSERT INTO unlock_codes(code,tier,max_uses,note,created_at,expires_at) VALUES(?,?,?,?,?,?)', code, tier, max,
    String(note ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80), now(), expires)
  return code
}

export function redeem(playerId: number, raw: unknown): Tier {
  const code = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32)
  return tx(() => {
    const c = get<{ tier: Tier; max_uses: number; uses: number; expires_at: number | null }>('SELECT * FROM unlock_codes WHERE code=?', code)
    if (!c) throw new HttpError(404, 'bad_unlock_code')
    if (get('SELECT 1 FROM unlocks WHERE player_id=? AND tier=?', playerId, c.tier)) return c.tier // schon offen (z. B. Link erneut geöffnet): kein Fehler, Code nicht verbrauchen
    if (c.uses >= c.max_uses || (c.expires_at && c.expires_at < now())) throw new HttpError(404, 'bad_unlock_code')
    grant(playerId, c.tier, 'code:' + code)
    run('UPDATE unlock_codes SET uses=uses+1 WHERE code=?', code)
    return c.tier
  })
}

export const listCodes = () => all('SELECT * FROM unlock_codes ORDER BY created_at DESC, rowid DESC LIMIT 200')
export const deleteCode = (code: string) => run('DELETE FROM unlock_codes WHERE code=?', code.toUpperCase())
export { TIERS }
