// Quiz-Pool: Wer mitmacht, kann vom Server als Gegner für ein Duell ausgewählt werden („Pool-Gegner“).
//  - Beitritt freiwillig (Schalter) oder automatisch durch das Anfragen eines Pool-Gegners; Austritt jederzeit.
//  - Teilnahmefähig: Pool an, aktiv in den letzten Tagen, gleiche App-Sprache, nicht in einem anderen Pool-Spiel, noch kein offenes Spiel mit der anfragenden Person.
//  - Je Person läuft höchstens ein Pool-Spiel (als Anfragende/r oder Angefragte/r).
//  - Hat die angefragte Person nach `pool.expireMin` Minuten noch keinen Zug gemacht (obwohl sie dran ist), verfällt das Spiel; beide werden benachrichtigt.
import crypto from 'node:crypto'
import { all, get, run, tx, now } from './db.ts'
import { config } from './config.ts'
import { HttpError } from './http.ts'
import { notifyPlayer } from './push.ts'
import { guardLimit, insertGame, nameOf } from './game.ts'
import type { PlayerRow } from './auth.ts'

const OPEN = "status IN ('waiting','active')"

/** Das offene Pool-Spiel der Person (egal ob angefragt oder angefragt worden). */
export const poolGameOf = (pid: number): number | null =>
  get<{ id: number }>(`SELECT id FROM games WHERE pool=1 AND ${OPEN} AND (p1=? OR p2=?) ORDER BY id DESC LIMIT 1`, pid, pid)?.id ?? null

/** Teilnahmefähige Pool-Mitglieder für `me` (ohne `me`). */
function eligible(me: PlayerRow): number[] {
  const since = now() - config.pool.activeDays * 86_400_000
  return all<{ id: number }>(
    `SELECT p.id FROM players p
      WHERE p.pool=1 AND p.deleted=0 AND p.is_bot=0 AND p.id<>? AND p.lang=? AND COALESCE(p.last_seen, p.created_at)>=?
        AND NOT EXISTS (SELECT 1 FROM games g WHERE g.${OPEN} AND ((g.p1=p.id AND g.p2=?) OR (g.p1=? AND g.p2=p.id)))
        AND NOT EXISTS (SELECT 1 FROM games g WHERE g.pool=1 AND g.${OPEN} AND (g.p1=p.id OR g.p2=p.id))
        AND (SELECT COUNT(*) FROM games g WHERE g.${OPEN} AND (g.p1=p.id OR g.p2=p.id)) < ?`,
    me.id, me.lang, since, me.id, me.id, config.maxActiveGames).map((r) => r.id)
}

export function poolInfo(me: PlayerRow) {
  const mine = get<{ pool: number }>('SELECT pool FROM players WHERE id=?', me.id)
  return { members: eligible(me).length, member: !!mine?.pool, game: poolGameOf(me.id) }
}

export function setPool(me: PlayerRow, on: boolean) {
  run('UPDATE players SET pool=? WHERE id=?', on ? 1 : 0, me.id)
  return poolInfo(me)
}

/** Fragt einen zufälligen teilnahmefähigen Pool-Gegner an (und macht die anfragende Person zum Mitglied). Läuft schon ein Pool-Spiel, wird dessen ID zurückgegeben. */
export function requestOpponent(me: PlayerRow, lang: string): number {
  return tx(() => {
    const open = poolGameOf(me.id)
    if (open !== null) return open
    guardLimit(me.id)
    const pick = eligible(me)
    if (!pick.length) throw new HttpError(409, 'pool_empty')
    const opp = pick[crypto.randomInt(pick.length)]
    run('UPDATE players SET pool=1 WHERE id=?', me.id)
    const id = insertGame(me.id, opp, lang)
    run('UPDATE games SET pool=1 WHERE id=?', id)
    notifyPlayer(opp, 'challenge', id, me.name)
    return id
  })
}

/** Verfall: Der Angefragte ist am Zug, hat noch nie geantwortet und lässt die Anfrage `expireMin` Minuten liegen. Wird jede Minute aufgerufen. */
export function sweepPool(): number {
  return tx(() => {
    const rows = all<{ id: number; p1: number; p2: number }>(
      `SELECT g.id, g.p1, g.p2 FROM games g WHERE g.pool=1 AND g.status='active' AND g.turn=g.p2 AND g.updated_at<?
         AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.game_id=g.id AND a.player_id=g.p2)`, now() - config.pool.expireMin * 60_000)
    for (const g of rows) {
      run("UPDATE games SET status='abandoned', turn=NULL, phase=NULL, end_reason='pool_timeout', updated_at=? WHERE id=?", now(), g.id)
      notifyPlayer(g.p1, 'pool_idle', g.id, nameOf(g.p2))
      notifyPlayer(g.p2, 'pool_expired', g.id, nameOf(g.p1))
    }
    return rows.length
  })
}
