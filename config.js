// config.js
const ADMIN_IDS_ENV = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => Number(x.trim()))
  .filter(Boolean);

module.exports = {
  // TOKEN BOT (WAJIB DARI ENV)
  BOT_TOKEN: process.env.BOT_TOKEN,

  // CHANNEL WAJIB (PAKAI @username, BUKAN URL)
  CHANNELS: [
    '@moneyseekersreal',
    '@withdrawalmoneyseekers'
  ],

  // WEB MISI
  MISSION_URL: process.env.MISSION_URL || 'https://sfl.gl/v1xmf7',

  // CHANNEL LAPORAN WD
  WITHDRAW_TARGET: '@withdrawalmoneyseekers',

  // BACKUP (OPSIONAL)
  BACKUP_TARGET: process.env.BACKUP_TARGET || '',

  // ADMIN IDS
  ADMIN_IDS: ADMIN_IDS_ENV,

  // AUTO BACKUP
  BACKUP_INTERVAL_MINUTES: Number(process.env.BACKUP_INTERVAL_MINUTES || 60),

  // MIN WD
  MIN_WITHDRAW: Number(process.env.MIN_WITHDRAW || 30000),
};