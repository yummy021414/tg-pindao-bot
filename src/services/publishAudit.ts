import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export type PublishAuditEvent = {
  ts: string; // ISO
  keyword: string;
  userId?: number;
  channelId?: string;
  source: 'publish' | 'save_and_publish' | 'bot_log' | 'jsonl';
  count?: number;
};

const DATA_DIR = path.join(process.cwd(), 'data');
const JSONL_PATH = path.join(DATA_DIR, 'publish-events.jsonl');
const BOT_LOG_PATH = path.join(DATA_DIR, 'bot.log');

/** 写入结构化发布审计（以后提取优先用这个） */
export function recordPublishEvent(event: Omit<PublishAuditEvent, 'ts'> & { ts?: string }): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const row: PublishAuditEvent = {
      ts: event.ts || new Date().toISOString(),
      keyword: String(event.keyword || '').trim(),
      userId: event.userId,
      channelId: event.channelId ? String(event.channelId) : undefined,
      source: event.source,
      count: event.count
    };
    if (!row.keyword) return;
    fs.appendFileSync(JSONL_PATH, JSON.stringify(row) + '\n', 'utf8');
    console.log(
      `[发布审计] ${row.ts} | ${row.source} | 用户=${row.userId ?? '-'} | 频道=${row.channelId ?? '-'} | 关键词="${row.keyword}" | 文件=${row.count ?? '-'}`
    );
  } catch (e: any) {
    console.error('写入发布审计失败:', e?.message || e);
  }
}

function parseZhCnDateTime(raw: string): Date | null {
  // 兼容: 2026/7/15 12:53:01 | 2026/07/15 12:53:01 | 2026-7-15 12:53:01
  const m = raw.trim().match(
    /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/
  );
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const hh = parseInt(m[4], 10);
  const mm = parseInt(m[5], 10);
  const ss = parseInt(m[6] || '0', 10);
  // 按东八区墙钟 → Instant
  const asUtc = Date.parse(
    `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000Z`
  );
  if (Number.isNaN(asUtc)) return null;
  return new Date(asUtc - 8 * 60 * 60 * 1000);
}

async function readJsonlEvents(start: Date, end: Date, userId?: number): Promise<PublishAuditEvent[]> {
  if (!fs.existsSync(JSONL_PATH)) return [];
  const startMs = start.getTime();
  const endMs = end.getTime() + 59 * 1000 + 999;
  const out: PublishAuditEvent[] = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(JSONL_PATH, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t) as PublishAuditEvent;
      if (!row.keyword || !row.ts) continue;
      if (userId != null && row.userId != null && Number(row.userId) !== Number(userId)) continue;
      const ms = new Date(row.ts).getTime();
      if (Number.isNaN(ms) || ms < startMs || ms > endMs) continue;
      out.push({ ...row, source: row.source || 'jsonl' });
    } catch {
      // ignore bad line
    }
  }
  return out;
}

/**
 * 从 bot.log 还原历史发布：
 * 文本消息 → 路由 mode=publish → 开始发布 成功
 */
async function parseBotLogEvents(start: Date, end: Date): Promise<PublishAuditEvent[]> {
  if (!fs.existsSync(BOT_LOG_PATH)) return [];

  const startMs = start.getTime();
  const endMs = end.getTime() + 59 * 1000 + 999;
  const out: PublishAuditEvent[] = [];

  type Pending = { at: Date; keyword: string; publishMode: boolean };
  let pending: Pending | null = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(BOT_LOG_PATH, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  const tsPrefix = /^\[([^\]]+)\]\s*(.*)$/;

  for await (const line of rl) {
    const m = line.match(tsPrefix);
    if (!m) continue;
    const at = parseZhCnDateTime(m[1]);
    if (!at) continue;
    const body = m[2] || '';

    // 结构化审计行（部署后新日志）
    if (body.includes('[发布审计]')) {
      const kw = body.match(/关键词="(.+?)"/)?.[1]?.trim();
      const ch = body.match(/频道=(\S+)/)?.[1];
      const uid = body.match(/用户=(\S+)/)?.[1];
      const ms = at.getTime();
      if (kw && ms >= startMs && ms <= endMs) {
        out.push({
          ts: at.toISOString(),
          keyword: kw,
          userId: uid && uid !== '-' ? Number(uid) : undefined,
          channelId: ch && ch !== '-' ? ch : undefined,
          source: 'bot_log'
        });
      }
      continue;
    }

    // 文本 / 管理文本
    let km = body.match(/💬 \[文本消息\].*->\s*"(.+)"\s*$/);
    if (!km) km = body.match(/👑 \[管理\].*发送文本:\s*"(.+)"\s*$/);
    if (km) {
      pending = { at, keyword: km[1].trim(), publishMode: false };
      continue;
    }

    if (pending && /\[路由\].*mode=publish/.test(body)) {
      pending.publishMode = true;
      continue;
    }

    // 新格式：一行里直接带关键词
    const direct = body.match(/📢 开始发布\s+(\d+)\s+个媒体到频道\s+(\S+)(?:\s*\|\s*关键词="(.+?)")?/);
    if (direct) {
      const kwFromLine = (direct[3] || '').trim();
      const kw = kwFromLine || (pending?.publishMode ? pending.keyword : '');
      const eventAt = kwFromLine ? at : (pending?.at || at);
      const ms = eventAt.getTime();
      if (kw && ms >= startMs && ms <= endMs) {
        out.push({
          ts: eventAt.toISOString(),
          keyword: kw,
          channelId: direct[2],
          source: 'bot_log',
          count: parseInt(direct[1], 10)
        });
      }
      pending = null;
      continue;
    }

    // 发布失败则丢弃 pending
    if (pending && (/发布.*错误/.test(body) || /发布搜索错误/.test(body))) {
      pending = null;
    }
  }

  return out;
}

/** 合并 jsonl + bot.log，按关键词保留时段内最新一条 */
export async function getPublishEventsInRange(
  start: Date,
  end: Date,
  userId?: number
): Promise<Array<{ keyword: string; publishedAt: string; channelId?: string; matchBy: string }>> {
  const [jsonl, fromLog] = await Promise.all([
    readJsonlEvents(start, end, userId),
    parseBotLogEvents(start, end)
  ]);

  const map = new Map<string, { keyword: string; publishedAt: string; channelId?: string; matchBy: string }>();
  const prefer = (source: string) => (source === 'publish' || source === 'save_and_publish' || source === 'jsonl' ? 2 : 1);

  for (const ev of [...jsonl, ...fromLog]) {
    const key = ev.keyword;
    const row = {
      keyword: key,
      publishedAt: ev.ts,
      channelId: ev.channelId,
      matchBy: ev.source === 'bot_log' ? 'bot_log' : 'audit_log'
    };
    const existing = map.get(key);
    if (!existing) {
      map.set(key, row);
      continue;
    }
    const ep = prefer(existing.matchBy === 'bot_log' ? 'bot_log' : 'jsonl');
    const np = prefer(ev.source);
    if (np > ep || (np === ep && row.publishedAt > existing.publishedAt)) {
      map.set(key, row);
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime()
  );
}
