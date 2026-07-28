const fs = require('fs');
const path = require('path');

function toInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return n;
}

function resolveDbJsonPath() {
  const projectRoot = path.join(__dirname, '..');
  const rawDbPath = process.env.DATABASE_PATH || path.join(projectRoot, 'data', 'bot.db');
  const absDbPath = path.isAbsolute(rawDbPath) ? rawDbPath : path.join(projectRoot, rawDbPath);
  return absDbPath.replace(/\.db$/i, '.json');
}

function replaceSuffix(text, from, to) {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (!from) return text;
  if (text.endsWith(from)) {
    return `${text.slice(0, -from.length)}${to}`;
  }
  return text;
}

function main() {
  const sourceAdminId = toInt(process.env.SOURCE_ADMIN_ID, 'SOURCE_ADMIN_ID');
  const targetAdminId = toInt(process.env.TARGET_ADMIN_ID, 'TARGET_ADMIN_ID');
  const keywordSuffixFrom = process.env.KEYWORD_SUFFIX_FROM || '';
  const keywordSuffixTo = process.env.KEYWORD_SUFFIX_TO || '';
  const captionSuffixFrom = process.env.CAPTION_SUFFIX_FROM || '';
  const captionSuffixTo = process.env.CAPTION_SUFFIX_TO || '';
  const includeReviews = (process.env.INCLUDE_REVIEWS || 'false').toLowerCase() === 'true';
  const dryRun = (process.env.DRY_RUN || 'false').toLowerCase() === 'true';
  const skipIfExists = (process.env.SKIP_IF_EXISTS || 'true').toLowerCase() === 'true';

  if (sourceAdminId === targetAdminId) {
    throw new Error('SOURCE_ADMIN_ID and TARGET_ADMIN_ID cannot be the same');
  }

  const dbJsonPath = resolveDbJsonPath();
  if (!fs.existsSync(dbJsonPath)) {
    throw new Error(`Database file not found: ${dbJsonPath}`);
  }

  const raw = fs.readFileSync(dbJsonPath, 'utf8');
  const db = JSON.parse(raw);
  if (!Array.isArray(db.media)) {
    throw new Error('Invalid database format: media array missing');
  }

  const sourceItems = db.media.filter(item => {
    if (item.uploaded_by !== sourceAdminId) return false;
    if (!includeReviews && item.is_review) return false;
    return true;
  });

  if (sourceItems.length === 0) {
    console.log('No source media found. Nothing to migrate.');
    return;
  }

  const existingKeys = new Set();
  if (skipIfExists) {
    db.media
      .filter(item => item.uploaded_by === targetAdminId)
      .forEach(item => {
        const key = `${item.uploaded_by}|${item.file_id}|${item.keyword}|${item.batchId || ''}|${item.is_review ? 1 : 0}`;
        existingKeys.add(key);
      });
  }

  let nextId = db.media.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
  const cloned = [];
  let skipped = 0;

  for (const item of sourceItems) {
    const newKeyword = replaceSuffix(item.keyword, keywordSuffixFrom, keywordSuffixTo);
    const newCaptionRaw = replaceSuffix(item.caption || '', captionSuffixFrom, captionSuffixTo);
    const newCaption = newCaptionRaw && newCaptionRaw.trim().length > 0 ? newCaptionRaw : undefined;

    const dedupeKey = `${targetAdminId}|${item.file_id}|${newKeyword}|${item.batchId || ''}|${item.is_review ? 1 : 0}`;
    if (skipIfExists && existingKeys.has(dedupeKey)) {
      skipped += 1;
      continue;
    }

    const copy = {
      ...item,
      id: nextId++,
      uploaded_by: targetAdminId,
      keyword: newKeyword,
      caption: newCaption,
      // New admin publishes to an independent channel set.
      channel_id: undefined,
      is_published: false,
      source_chat_id: undefined,
      source_msg_id: undefined
    };

    cloned.push(copy);
    existingKeys.add(dedupeKey);
  }

  const backupPath = `${dbJsonPath}.backup-${Date.now()}.json`;
  console.log(`Source items: ${sourceItems.length}`);
  console.log(`Cloned items: ${cloned.length}`);
  console.log(`Skipped (dedupe): ${skipped}`);
  console.log(`Dry run: ${dryRun ? 'yes' : 'no'}`);

  if (dryRun) {
    console.log('Dry run only. No files written.');
    return;
  }

  fs.copyFileSync(dbJsonPath, backupPath);
  db.media.push(...cloned);
  fs.writeFileSync(dbJsonPath, JSON.stringify(db, null, 2), 'utf8');

  console.log(`Backup created: ${backupPath}`);
  console.log(`Database updated: ${dbJsonPath}`);
}

try {
  main();
} catch (err) {
  console.error('[admin-migrate-replace-suffix] failed:', err.message);
  process.exit(1);
}
