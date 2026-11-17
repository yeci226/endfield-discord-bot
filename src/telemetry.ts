import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const DAY = 86400000;
export const taipeiDay = (time: number) => Math.floor((time + 8 * 3600000) / DAY) * DAY - 8 * 3600000;
type GuildRow = { id: string; name: string; members: number };
type Snapshot = { ready: boolean; shards: number[]; session: string; guilds: GuildRow[] };
type Totals = { time: number; servers: number; users: number; top: GuildRow[]; session: string };

export function combineRuntimeWorkers(rows: any[]) {
  const groups=new Map<string,number>();
  return [...rows].sort((a,b)=>a.runtime.worker-b.runtime.worker).map(row=>{
    const resourceOwner=!groups.has(row.processKey);
    if(resourceOwner) groups.set(row.processKey,groups.size);
    return {...row.runtime,processGroup:groups.get(row.processKey),resourceOwner};
  });
}
export function combineSnapshots(rows: Snapshot[], clusters: number, shards: number): Omit<Totals, 'time'> | null {
  if (rows.length !== clusters || rows.some(row => !row?.ready)) return null;
  const ids = rows.flatMap(row => row.shards);
  if (ids.length !== shards || new Set(ids).size !== shards || ids.some(id => !Number.isInteger(id) || id < 0 || id >= shards)) return null;
  const guilds = new Map<string, GuildRow>();
  for (const row of rows) for (const guild of row.guilds) {
    if (!Number.isSafeInteger(guild.members) || guild.members < 0) return null;
    guilds.set(guild.id, guild);
  }
  const all = [...guilds.values()];
  return { servers: all.length, users: all.reduce((sum, g) => sum + g.members, 0),
    top: all.sort((a, b) => b.members - a.members || a.id.localeCompare(b.id)).slice(0, 20),
    session: rows.map(row => row.session).sort().join(',') };
}

export class TelemetryStore {
  db: Database.Database;
  constructor(path: string, now = Date.now()) {
    this.db = new Database(path, { timeout: 3000 });
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS totals (id INTEGER PRIMARY KEY CHECK(id=1), started INTEGER NOT NULL, commands INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, time INTEGER NOT NULL, user TEXT NOT NULL, guild TEXT, name TEXT NOT NULL, duration INTEGER, error INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS command_time ON commands(time);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS user_first ON users(first_seen);
      CREATE TABLE IF NOT EXISTS guilds (id TEXT PRIMARY KEY, present INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS guild_events (time INTEGER NOT NULL, joined INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS guild_event_time ON guild_events(time);
      CREATE TABLE IF NOT EXISTS snapshots (time INTEGER PRIMARY KEY, servers INTEGER NOT NULL, users INTEGER NOT NULL, top TEXT NOT NULL, session TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gaps (start INTEGER NOT NULL, end INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reports (day INTEGER PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', message_id TEXT, retry_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS rollups (grain TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(grain,start));
      CREATE TABLE IF NOT EXISTS telemetry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shard_disconnects (id INTEGER PRIMARY KEY, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_state (id INTEGER PRIMARY KEY, session TEXT NOT NULL, restarts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, until INTEGER NOT NULL);
    `);
    this.db.prepare('INSERT OR IGNORE INTO totals(id,started) VALUES(1,?)').run(now);
  }
  begin(id: string, user: string, guild: string | null, name: string, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO commands(id,time,user,guild,name) VALUES(?,?,?,?,?)').run(id, now, user, guild, name).changes;
      if (!inserted) return false;
      this.db.prepare('UPDATE totals SET commands=commands+1 WHERE id=1').run();
      this.db.prepare('INSERT OR IGNORE INTO users VALUES(?,?)').run(user, now);
      return true;
    })();
  }
  finish(id: string, duration: number, error: boolean) {
    this.db.prepare('UPDATE commands SET duration=?,error=? WHERE id=?').run(Math.round(duration), Number(error), id);
    this.db.prepare('UPDATE rollups SET dirty=1 WHERE start<=(SELECT time FROM commands WHERE id=?) AND end>(SELECT time FROM commands WHERE id=?)').run(id,id);
  }
  guildEvent(id: string, joined: boolean, now = Date.now()) {
    this.db.transaction(() => {
      const previous = this.db.prepare('SELECT present FROM guilds WHERE id=?').get(id) as { present: number } | undefined;
      if (previous?.present === Number(joined) || (!previous && !joined)) return;
      this.db.prepare('INSERT INTO guilds VALUES(?,?) ON CONFLICT(id) DO UPDATE SET present=excluded.present').run(id, Number(joined));
      this.db.prepare('INSERT INTO guild_events VALUES(?,?)').run(now, Number(joined));
    })();
  }
  snapshot(value: Totals, ids: string[]) {
    this.db.transaction(() => {
      const previous = this.db.prepare('SELECT time,session FROM snapshots ORDER BY time DESC LIMIT 1').get() as { time: number; session: string } | undefined;
      if (previous && (value.time - previous.time > 120000 || previous.session !== value.session)) {
        this.db.prepare('INSERT INTO gaps VALUES(?,?)').run(previous.time, value.time);
      }
      this.db.prepare('INSERT OR REPLACE INTO snapshots VALUES(?,?,?,?,?)').run(value.time, value.servers, value.users, JSON.stringify(value.top), value.session);
      this.db.prepare('UPDATE guilds SET present=0').run();
      const insert = this.db.prepare('INSERT INTO guilds VALUES(?,1) ON CONFLICT(id) DO UPDATE SET present=1');
      for (const id of ids) insert.run(id);
    })();
  }
  metrics(end = Date.now(), snapshot?: Totals, start = end - DAY) {
    return this.db.transaction(() => this.readMetrics(end, snapshot, start))();
  }
  private readMetrics(end: number, snapshot: Totals | undefined, start: number) {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE time<=? ORDER BY time DESC LIMIT 1');
    const current = snapshot ?? row.get(end) as Totals | undefined;
    const baseline = row.get(start) as Totals | undefined;
    const baselineValid = baseline && start - baseline.time <= 120000;
    const total = this.db.prepare('SELECT started,commands FROM totals WHERE id=1').get() as { started: number; commands: number };
    const count = (sql: string, ...args: (number | string)[]) => (this.db.prepare(sql).get(...args) as { n: number }).n;
    const stats = this.db.prepare('SELECT count(*) totalCommands24h,coalesce(sum(error),0) totalErrors24h,count(DISTINCT user) uniqueUsers24h,count(DISTINCT guild) uniqueServers24h,round(avg(duration)) avgExecutionMs FROM commands WHERE time>=? AND time<?').get(start, end) as { totalCommands24h: number; totalErrors24h: number; uniqueUsers24h: number; uniqueServers24h: number; avgExecutionMs: number | null };
    const newUsers = count('SELECT count(*) n FROM users WHERE first_seen>=? AND first_seen<?', start, end);
    const gap = count('SELECT count(*) n FROM gaps WHERE start<? AND end>?', end, start) > 0;
    return { ...stats, totalCommands: total.commands - count('SELECT count(*) n FROM commands WHERE time>=?', end),
      totalUniqueUsers: count('SELECT count(*) n FROM users WHERE first_seen<?', end), uniqueUsersDelta24h: newUsers,
      totalServers: current?.servers ?? null, totalUsers: current?.users ?? null,
      serversDelta24h: baselineValid && current ? current.servers - baseline.servers : null,
      usersDelta24h: baselineValid && current ? current.users - baseline.users : null,
      joinedServers24h: count('SELECT count(*) n FROM guild_events WHERE time>=? AND time<? AND joined=1', start, end),
      leftServers24h: count('SELECT count(*) n FROM guild_events WHERE time>=? AND time<? AND joined=0', start, end),
      trackingStartedAt: total.started, windowStart: start, windowEnd: end,
      complete: total.started <= start && !gap && !!current && end - current.time <= 120000 && !!baselineValid,
      snapshotAt: current?.time ?? null,
      v2: { version: 2, commands: this.commandStats(start,end), runtime: null as any, pipeline: null as any, quality: [...(total.started > start ? ['partial_window'] : []), ...(gap ? ['collection_gap'] : []), ...(!current || end-current.time>120000 ? ['stale_snapshot'] : [])] },
      topCommands: this.db.prepare('SELECT name,count(*) count,round(avg(duration)) avgTimeMs FROM commands WHERE time>=? AND time<? GROUP BY name ORDER BY count DESC,name LIMIT 15').all(start, end),
    };
  }
  commandStats(start: number, end: number) {
    const rows = this.db.prepare(`SELECT name,count(*) count,sum(CASE WHEN duration IS NOT NULL AND error=0 THEN 1 ELSE 0 END) completed,
      sum(CASE WHEN duration IS NOT NULL AND error=1 THEN 1 ELSE 0 END) errors,sum(CASE WHEN duration IS NULL THEN 1 ELSE 0 END) unfinished,
      count(DISTINCT user) users,count(DISTINCT guild) guilds,count(duration) durationCount,coalesce(sum(duration),0) durationSum,round(avg(duration)) avgMs
      FROM commands WHERE time>=? AND time<? GROUP BY name ORDER BY count DESC,name`).all(start,end) as any[];
    const durations = this.db.prepare('SELECT name,duration FROM commands WHERE time>=? AND time<? AND duration IS NOT NULL ORDER BY duration').all(start,end) as {name:string;duration:number}[];
    const groups = new Map<string,number[]>();
    for (const d of durations) { const list=groups.get(d.name) || []; list.push(d.duration); groups.set(d.name,list); }
    return rows.map(r => ({...r,p95Ms: groups.get(r.name)?.[Math.ceil((groups.get(r.name)?.length || 0)*0.95)-1] ?? null}));
  }
  meta(key: string, value?: unknown): any {
    if (value !== undefined) this.db.prepare('INSERT INTO telemetry_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
    const row=this.db.prepare('SELECT value FROM telemetry_meta WHERE key=?').get(key) as any;
    return row ? JSON.parse(row.value) : null;
  }
  buildRollups(botId: string, now=Date.now()) {
    const started=(this.db.prepare('SELECT started FROM totals WHERE id=1').get() as any).started;
    for (const grain of ['hour','day']) {
      const span=grain==='day'?DAY:3600000;
      const align=(time:number)=>grain==='day'?taipeiDay(time):Math.floor(time/span)*span;
      for(let start=align(Math.max(started,now-7*DAY));start<now;start+=span) {
        const end=Math.min(start+span,now);
        const previous=this.db.prepare('SELECT end,revision,dirty FROM rollups WHERE grain=? AND start=?').get(grain,start) as any;
        if(previous && !previous.dirty && previous.end===start+span && previous.revision>=start+span+120000) continue;
        // Raw command retention is seven days; never invent an older bucket from missing rows.
        if(start<now-7*DAY && !previous) continue;
        const stats=this.metrics(end,undefined,start);
        const item={botId,grain,start,end,revision:now,stats};
        this.db.prepare('INSERT INTO rollups VALUES(?,?,?,?,?,0,0) ON CONFLICT(grain,start) DO UPDATE SET end=excluded.end,revision=excluded.revision,payload=excluded.payload,synced=0,dirty=0').run(grain,start,end,now,JSON.stringify(item));
      }
    }
  }
  claim(owner: string, now = Date.now()): boolean {
    return this.db.prepare('INSERT INTO lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until=excluded.until WHERE lease.until<? OR lease.owner=excluded.owner').run(owner, now + 55000, now).changes > 0;
  }
  cleanup(now = Date.now()) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM rollups WHERE synced=1 AND (grain='hour' AND end<? OR grain='day' AND end<?)").run(now-7*DAY,now-90*DAY);
      this.db.prepare('DELETE FROM commands WHERE time<?').run(now - 7 * DAY);
      this.db.prepare('DELETE FROM guild_events WHERE time<?').run(now - 7 * DAY);
      this.db.prepare('DELETE FROM snapshots WHERE time<?').run(now - 90 * DAY);
      this.db.prepare('DELETE FROM gaps WHERE end<?').run(now - 90 * DAY);
      this.db.prepare("DELETE FROM reports WHERE day<? AND state='sent'").run(now - 90 * DAY);
      this.db.prepare('DELETE FROM guilds WHERE present=0').run();
    })();
  }
}

let store: TelemetryStore | undefined;
// This wrapper records dispatch, never arguments, message contents or command replies.
export async function trackCommand<T>(subject: any, action: () => Promise<T>, name?: string): Promise<T> {
  const isCommand = subject.isCommand?.() || (!!subject.author && !!name);
  if (!store || !isCommand || (subject.user ?? subject.author)?.bot) return action();
  const start = Date.now();
  let recorded = false;
  try { recorded = store.begin(subject.id, (subject.user ?? subject.author).id, subject.guildId ?? null, subject.commandName ?? name); }
  catch { console.error('[Telemetry] command persistence failed'); }
  let failed = false;
  try { return await action(); } catch (error) { failed = true; throw error; }
  finally {
    if (recorded) try { store.finish(subject.id, Date.now() - start, failed); }
    catch { console.error('[Telemetry] command result persistence failed'); }
  }
}

export function dailyPayload(botName: string, end: number, stats: ReturnType<TelemetryStore['metrics']>, top: GuildRow[]) {
  const n = (value: unknown) => value == null ? '尚無基準' : Number(value).toLocaleString('zh-TW');
  const delta = (value: number | null) => value == null ? '尚無基準' : `${value > 0 ? '+' : ''}${n(value)}`;
  const day = new Date(end - DAY + 8 * 3600000).toISOString().slice(0, 10);
  const embeds = [{ title: `${botName} 每日日誌 · ${day}`, color: 0x5865f2,
    description: `<t:${Math.floor(stats.windowStart / 1000)}:f> ～ <t:${Math.floor(end / 1000)}:f>\n${stats.complete ? '完整 24 小時紀錄' : '部分紀錄：啟用不足 24 小時、分片重啟或期間有資料缺漏'}\n成員總數含機器人及跨伺服器重複成員；獨特使用者為使用過指令的帳號。`,
    fields: [
      { name: '資料收集', value: `${stats.complete ? '完整' : '部分紀錄'} · ${stats.v2.runtime ? `Cluster ${stats.v2.runtime.readyClusters}/${stats.v2.runtime.expectedClusters} · 分片 ${stats.v2.runtime.readyShards}/${stats.v2.runtime.expectedShards}` : '依當日快照'}\n${stats.v2.quality.map(q => ({partial_window:'統計期間不足',collection_gap:'收集曾中斷',stale_snapshot:'快照已過期',incomplete_shards:'分片未完整就緒'}[q] || '紀錄不完整')).join(' / ') || '紀錄完整'}` },
      { name: '伺服器', value: `${n(stats.totalServers)}（${delta(stats.serversDelta24h)}）\n加入 ${n(stats.joinedServers24h)} / 離開 ${n(stats.leftServers24h)}` },
      { name: '使用者總數', value: `${n(stats.totalUsers)}（${delta(stats.usersDelta24h)}）` },
      { name: '累計獨特使用者', value: `${n(stats.totalUniqueUsers)}（+${n(stats.uniqueUsersDelta24h)}）\n24h 活躍 ${n(stats.uniqueUsers24h)}` },
      { name: '指令使用', value: `24h ${n(stats.totalCommands24h)} / 累計 ${n(stats.totalCommands)}` },
    ], footer: { text: `統計起始 ${new Date(stats.trackingStartedAt).toISOString()} · 人數取最近完整快照` } }];
  for (let offset = 0; offset < top.length; offset += 10) {
    const description = top.slice(offset, offset + 10).map((g, i) => `${offset + i + 1}. ${g.name.replace(/[\\*_~`<>|\r\n]/g, ' ').slice(0, 70)} — ${n(g.members)} 人`).join('\n');
    (embeds as any[]).push({ title: `前 20 大伺服器 · ${offset + 1}–${Math.min(offset + 10, top.length)}`, description, color: 0x5865f2 });
  }
  return { allowed_mentions: { parse: [] }, embeds };
}

export function startTelemetry(client: any, cluster: any, botId: string, botName: string, webhook?: string) {
  if (store) return;
  store = new TelemetryStore('telemetry.sqlite');
  const db = store;
  const session = randomUUID();
  const worker = Number(cluster?.id ?? 0);
  db.db.prepare('INSERT INTO worker_state VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET session=excluded.session,restarts=worker_state.restarts+1').run(worker,session);
  const restarts=(db.db.prepare('SELECT restarts FROM worker_state WHERE id=?').get(worker) as any).restarts;
  const delay=monitorEventLoopDelay({resolution:20}); delay.enable();
  let cpu=process.cpuUsage(), sampled=process.hrtime.bigint();
  client.telemetrySnapshot = () => {
    const currentCpu=process.cpuUsage(), currentTime=process.hrtime.bigint();
    const elapsed=Number(currentTime-sampled)/1000;
    const cpuPercent=elapsed>=1000 ? Math.round(((currentCpu.user-cpu.user)+(currentCpu.system-cpu.system))/elapsed*10000)/100 : null;
    cpu=currentCpu; sampled=currentTime;
    const memory=process.memoryUsage();
    const eventLoopDelayMs=Number.isFinite(delay.mean)?Math.round(delay.mean/1e6*100)/100:null; delay.reset();
    return { processKey: String(process.pid),
    runtime: {worker,cpuPercent,rssBytes:memory.rss,heapUsedBytes:memory.heapUsed,uptimeSeconds:Math.floor(process.uptime()),eventLoopDelayMs,restarts,
      shards:[...client.ws.shards.values()].map((sh:any)=>({shard:sh.id,status:sh.status===0?'ready':sh.status===1?'connecting':'disconnected',pingMs:Number.isFinite(sh.ping)&&sh.ping>=0?sh.ping:null,disconnects:(db.db.prepare('SELECT count FROM shard_disconnects WHERE id=?').get(sh.id) as any)?.count || 0}))},
    ready: client.isReady() && [...client.ws.shards.values()].every((s: any) => s.status === 0) && [...client.guilds.cache.values()].every((g: any) => g.available),
    session, shards: [...client.ws.shards.keys()],
    guilds: [...client.guilds.cache.values()].map((g: any) => ({ id: g.id, name: g.name, members: g.memberCount })),
  }; };
  for (const [event, joined] of [['guildCreate', true], ['guildDelete', false]] as const) {
    client.on(event, (guild: any) => {
      if (!client.isReady() || guild.available === false || (joined && guild.joinedTimestamp < Date.now() - 120000)) return;
      try { db.guildEvent(guild.id, joined); } catch { console.error('[Telemetry] guild event persistence failed'); }
    });
  }
  const disconnected = new Map<number, number>();
  client.on('shardDisconnect', (_event: unknown, id: number) => { disconnected.set(id, Date.now()); try { db.db.prepare('INSERT INTO shard_disconnects VALUES(?,1) ON CONFLICT(id) DO UPDATE SET count=count+1').run(id); } catch { console.error('[Telemetry] disconnect persistence failed'); } });
  const recovered = (id: number) => {
    const start = disconnected.get(id);
    if (start !== undefined) {
      try { db.db.prepare('INSERT INTO gaps VALUES(?,?)').run(start, Date.now()); }
      catch { console.error('[Telemetry] gap persistence failed'); }
      disconnected.delete(id);
    }
  };
  client.on('shardResume', recovered);
  client.on('shardReady', recovered);
  if (cluster && cluster.id !== 0) return;
  // Website history sync was removed; drop the queue it left behind.
  try { db.db.prepare('DELETE FROM rollups').run(); } catch {}
  db.db.prepare("UPDATE reports SET state='unknown' WHERE state='sending'").run();
  let busy = false;
  let lastCleanup = 0;
  let synced = false;
  const pipeline = db.meta('pipeline') || {lastSyncSuccess:null,lastSyncFailure:null,consecutiveFailures:0,lastReportSentAt:null};
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (!db.claim(session)) return;
      const collectionStart=Date.now();
      const expectedClusters=cluster?.count ?? 1, expectedShards=cluster?.info?.TOTAL_SHARDS ?? client.options.shardCount ?? 1;
      const results=cluster ? await Promise.allSettled(Array.from({length:expectedClusters},(_,id)=>cluster.broadcastEval((c:any)=>c.telemetrySnapshot?.() ?? {ready:false},{cluster:id,timeout:10000}))) : [{status:'fulfilled',value:[client.telemetrySnapshot()]}];
      const rows:any[]=results.flatMap((r:any)=>r.status==='fulfilled'?(Array.isArray(r.value)?r.value:[r.value]):[]).filter((r:any)=>r?.runtime);
      const now=Date.now();
      const combined=combineSnapshots(rows,expectedClusters,expectedShards);
      const runtime={sampledAt:now,expectedClusters,respondingClusters:rows.length,readyClusters:rows.filter(r=>r.ready).length,expectedShards,
        readyShards:new Set(rows.flatMap(r=>r.runtime.shards.filter((sh:any)=>sh.status==='ready').map((sh:any)=>sh.shard))).size,
        collectionMs:now-collectionStart,workers:combineRuntimeWorkers(rows)};
      const snapshot=combined?{...combined,time:now}:undefined;
      if(snapshot) db.snapshot(snapshot,rows.flatMap(row=>row.guilds.map((g:any)=>g.id)));
      else console.warn('[Telemetry] incomplete shard snapshot; reporting diagnostics with previous totals');
      const currentStats=db.metrics(now,snapshot);
      currentStats.v2.runtime=runtime;
      if(!combined) currentStats.v2.quality.push('incomplete_shards');
      // Freeze the completed day before any network request. Restart cannot create a second report.
      const end = taipeiDay(now);
      const started = (db.db.prepare('SELECT started FROM totals WHERE id=1').get() as { started: number }).started;
      if (started < end) {
        const prior = db.db.prepare('SELECT * FROM snapshots WHERE time<=? ORDER BY time DESC LIMIT 1').get(end) as any;
        const daily=db.metrics(end); daily.v2.runtime=runtime;
        const payload = dailyPayload(botName, end, daily, prior ? JSON.parse(prior.top) : []);
        db.db.prepare('INSERT OR IGNORE INTO reports(day,payload) VALUES(?,?)').run(end, JSON.stringify(payload));
      }
      const report = db.db.prepare("SELECT * FROM reports WHERE state='pending' AND retry_at<=? ORDER BY day LIMIT 1").get(now) as any;
      const hook = webhook || process.env.JLWEBHOOK || process.env.JL_WEBHOOK;
      if (report && hook) {
        const url = new URL(hook); url.searchParams.set('wait', 'true');
        db.db.prepare("UPDATE reports SET state='sending' WHERE day=? AND state='pending'").run(report.day);
        try {
          const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: report.payload, signal: AbortSignal.timeout(12000) });
          if (response.ok) {
            const message = await response.json() as { id: string };
            if (!message.id) throw new Error('Missing message id');
            db.db.prepare("UPDATE reports SET state='sent',message_id=? WHERE day=?").run(message.id, report.day);
            pipeline.lastReportSentAt=Date.now(); db.meta('pipeline',pipeline);
            console.info(`[Telemetry] daily report sent day=${report.day}`);
          } else if (response.status === 429) {
            const limit = await response.json() as { retry_after?: number };
            db.db.prepare("UPDATE reports SET state='pending',retry_at=? WHERE day=?").run(now + Math.max(60000, (limit.retry_after || 60) * 1000), report.day);
          } else {
            db.db.prepare("UPDATE reports SET state=? WHERE day=?").run(response.status >= 500 ? 'unknown' : 'failed', report.day);
            console.error(`[Telemetry] daily delivery HTTP ${response.status}; retained for review`);
          }
        } catch {
          db.db.prepare("UPDATE reports SET state='unknown' WHERE day=?").run(report.day);
          console.error('[Telemetry] daily delivery uncertain; not automatically resending');
        }
      }
      const latest=db.db.prepare('SELECT day,state FROM reports ORDER BY day DESC LIMIT 1').get() as any;
      currentStats.v2.pipeline={...pipeline,webhook:!hook?'not_configured':latest?.state || 'waiting',reportDay:latest?.day ?? null};
      if (now - lastCleanup > DAY) { db.cleanup(now); lastCleanup = now; }
    } catch { console.error('[Telemetry] collection/sync failed; local records retained'); }
    finally { busy = false; }
  };
  console.info(`[Telemetry] enabled bot=${botId} webhook=${!!(webhook || process.env.JLWEBHOOK || process.env.JL_WEBHOOK)}`);
  client.once('clientReady', () => { void tick(); });
  client.once('ready', () => { void tick(); });
  setInterval(() => { void tick(); }, 60000).unref();
  void tick();
}
