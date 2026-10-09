// Löschen von Profilen: auf Wunsch („Profil löschen“ / Widerruf) und automatisch nach Ablauf der Speicherdauer.
import { config } from './config.ts'
import { all, run, tx, now } from './db.ts'
import { resign } from './game.ts'
import { forgetPlayer } from './rooms.ts'
import type { PlayerRow } from './auth.ts'

export function erasePlayer(p: PlayerRow) {
  tx(() => {
    for (const g of all<{ id: number }>("SELECT id FROM games WHERE (p1=? OR p2=?) AND status IN ('waiting','active')", p.id, p.id)) resign(g.id, p)
    run("UPDATE players SET deleted=1, name='—', username=NULL, pw_hash=NULL, birth_year=NULL WHERE id=?", p.id)
    run('DELETE FROM sessions WHERE player_id=?', p.id)
    run('DELETE FROM push_subs WHERE player_id=?', p.id)
    run('DELETE FROM transfer_codes WHERE player_id=?', p.id)
    run('DELETE FROM contacts WHERE player_id=? OR contact_id=?', p.id, p.id)
    run('DELETE FROM seen WHERE player_id=?', p.id)
    run('DELETE FROM reports WHERE player_id=?', p.id)
    run('DELETE FROM ladders WHERE player_id=?', p.id)
    run('DELETE FROM consents WHERE player_id=?', p.id)
    forgetPlayer(p.id)
    run('UPDATE reviews SET player_id=NULL WHERE player_id=?', p.id)
    run('UPDATE players SET reviewer=0 WHERE id=?', p.id)
    run('UPDATE questions SET submitted_by=NULL WHERE submitted_by=?', p.id)
  })
}

/** Anonyme Profile (ohne Konto) ohne Aktivität über die Speicherdauer hinaus werden gelöscht. */
export function sweepProfiles(): number {
  const cutoff = now() - config.privacy.retentionDays * 86_400_000
  const old = all<PlayerRow>('SELECT * FROM players WHERE deleted=0 AND is_bot=0 AND username IS NULL AND COALESCE(last_seen, created_at) < ?', cutoff)
  for (const p of old) erasePlayer(p)
  return old.length
}
