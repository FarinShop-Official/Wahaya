// index.js
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path'); // kalau belum ada
// DB di file JSON
const DB_PATH = path.join(__dirname, 'data.json');
let db = { users: {} };

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, 'utf8');
      db = JSON.parse(raw || '{}');
      if (!db.users) db.users = {};
    } else {
      db = { users: {} };
      saveDb();
    }
  } catch (err) {
    console.error('Gagal load DB, gunakan baru:', err.message);
    db = { users: {} };
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Gagal save DB:', err.message);
  }
}

loadDb();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const unzipper = require('unzipper');

// ======================
// ADMIN UPLOAD ZIP DB
// ======================
const ZIP_TEMP_PATH = path.join(__dirname, 'upload.zip');

let waitingZipAdmin = new Set();

// command admin
bot.command('uploadzip', async (ctx) => {
  const adminId = String(ctx.from.id);
  if (!ADMIN_IDS.includes(adminId)) {
    return ctx.reply('⛔ Perintah ini hanya untuk admin.');
  }

  waitingZipAdmin.add(adminId);
  await ctx.reply(
    '📦 Silakan kirim file ZIP berisi <b>data.json</b>\n\n' +
    '⚠️ Jangan ada folder di dalam ZIP.',
    { parse_mode: 'HTML' }
  );
});

// terima document
bot.on('document', async (ctx) => {
  const adminId = String(ctx.from.id);
  if (!waitingZipAdmin.has(adminId)) return;

  waitingZipAdmin.delete(adminId);

  const doc = ctx.message.document;
  if (!doc.file_name.endsWith('.zip')) {
    return ctx.reply('❌ File harus ZIP (.zip)');
  }

  try {
    await ctx.reply('⏳ Mengunduh file ZIP...');

    const link = await ctx.telegram.getFileLink(doc.file_id);
    const res = await fetch(link.href);
    const buffer = await res.arrayBuffer();

    fs.writeFileSync(ZIP_TEMP_PATH, Buffer.from(buffer));

    await ctx.reply('📂 Mengekstrak ZIP...');

    await fs.createReadStream(ZIP_TEMP_PATH)
      .pipe(unzipper.Extract({ path: __dirname }))
      .promise();

    if (!fs.existsSync(DB_PATH)) {
      throw new Error('data.json tidak ditemukan di ZIP');
    }

    // reload DB
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    db = JSON.parse(raw || '{}');
    if (!db.users) db.users = {};
    saveDb();

    await ctx.reply('✅ <b>DB berhasil di-upload & dimuat!</b>', {
      parse_mode: 'HTML'
    });

    // cleanup
    fs.unlinkSync(ZIP_TEMP_PATH);

  } catch (err) {
    console.error(err);
    await ctx.reply('❌ Gagal upload ZIP:\n' + err.message);
  }
});

const Jimp = require('jimp');
const CARD_TEMPLATE_PATH = path.join(__dirname, 'kartu_moneyseekers.png'); 
// ganti nama file sesuai nama gambar template kamu
const CARD_FONT_PATH     = path.join(__dirname, 'fonts', 'days.fnt'); // font bitmap
const BOT_AVATAR_PATH = path.join(__dirname, 'assets', 'bot_avatar.png');
// isi dengan gambar yang sama persis kayak avatar bot kamu
const {
  BOT_TOKEN,
  CHANNEL_LINKS,
  MISSION_URL,
  ADMIN_IDS,
  WITHDRAW_TARGET,
  BACKUP_TARGET,
  BACKUP_INTERVAL_MINUTES,
  MIN_WITHDRAW
} = require('./config');

if (!BOT_TOKEN || BOT_TOKEN === 'ISI_TOKEN_BOT') {
  console.error('ERROR: BOT_TOKEN belum diisi di config.js atau ENV!');
  process.exit(1);
}

const userCommands = [
  { command: 'start', description: 'Mulai bot' },
];

const adminCommands = [
  { command: 'start', description: 'Mulai bot' },
  { command: 'upload.zip', description: 'Share ke user' },
  { command: 'broadcast', description: 'Share ke user' },
  { command: 'backup_all', description: 'Backup All data' },
  { command: 'addsaldo', description: 'Tambah Saldo User' },
];

// Gambar welcome untuk /start
const WELCOME_IMAGE_PATH = path.join(__dirname, 'welcome.jpg');
// Bonus saldo per teman valid (referral)
const REFERRAL_BONUS = 3000;

const bot = new Telegraf(BOT_TOKEN);

// ======================
// UTIL & GLOBAL
// ======================

function linkToChatIdentifier(link) {
  if (!link) return '';
  if (link.startsWith('@') || link.startsWith('-100')) return link;
  try {
    if (!link.startsWith('http')) return link;
    const url = new URL(link);
    let p = url.pathname || '';
    p = p.replace(/^\//, '');
    p = p.split('/')[0];
    p = p.split('?')[0];
    if (!p) return link;
    if (p.startsWith('+')) return p;
    return '@' + p;
  } catch {
    return link;
  }
}

function normalizeChatTarget(v) {
  if (!v) return '';
  if (v.startsWith('http')) return linkToChatIdentifier(v);
  return v;
}

const CHANNEL_CHAT_IDS = CHANNEL_LINKS.map(linkToChatIdentifier);
const WITHDRAW_CHAT = normalizeChatTarget(WITHDRAW_TARGET);
const BACKUP_CHAT = normalizeChatTarget(BACKUP_TARGET);

// username bot (untuk link referral)
let BOT_USERNAME = null;
(async () => {
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username;
    console.log('Bot username loaded:', BOT_USERNAME);
  } catch (e) {
    console.error('Gagal memuat username bot:', e.message);
  }
})();

// ======================
// Broadcast helper
// ======================
async function broadcastToAllUsers(bot, fromAdminId, text) {
  const userIds = Object.keys(db.users || {});
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const uid of userIds) {
    const user = db.users[uid];

    // kalau sudah ditandai blocked, lewatin saja
    if (user && user.blocked) {
      skipped++;
      continue;
    }

    try {
      await bot.telegram.sendMessage(uid, text, {
        parse_mode: 'HTML'
      });
      sent++;
    } catch (e) {
      const msg = String(e.message || '');

      // user blokir bot / chat hilang → tandai blocked & skip ke depannya
      if (
        msg.includes('bot was blocked by the user') ||
        msg.includes('chat not found') ||
        msg.includes('user is deactivated')
      ) {
        console.log(`User ${uid} sudah blokir/hapus bot, ditandai blocked`);
        if (user) {
          user.blocked = true;
          saveDb();
        }
        skipped++;
      } else {
        console.error('Gagal kirim broadcast ke', uid, e);
        failed++;
      }
    }

    // jeda dikit biar ga spam API
    await sleep(40);
  }

  // kirim laporan ke admin
  const report =
`<b>✅ Broadcast selesai</b>
Total user di DB : <b>${userIds.length}</b>
Berhasil terkirim : <b>${sent}</b>
Dilewati (blocked/hapus) : <b>${skipped}</b>
Gagal lain : <b>${failed}</b>`;

  try {
    await bot.telegram.sendMessage(fromAdminId, report, {
      parse_mode: 'HTML'
    });
  } catch (e) {
    console.error('Gagal kirim laporan broadcast ke admin:', e.message);
  }
}

// pastikan struktur user
function getUser(userId) {
  const key = String(userId);
  if (!db.users[key]) {
    db.users[key] = {};
  }
  const u = db.users[key];

  if (!u.joinedChannels) u.joinedChannels = {};
  if (u.openedWeb === undefined) u.openedWeb = false;
  if (u.verified === undefined) u.verified = false;
  if (u.balance === undefined) u.balance = 0;
  if (u.inviterId === undefined) u.inviterId = null;
  if (u.state === undefined) u.state = null;
  if (u.tempWithdraw === undefined) u.tempWithdraw = null;
  if (!Array.isArray(u.withdrawHistory)) u.withdrawHistory = [];
  if (!u.lastMissionDate) u.lastMissionDate = null;
  if (u.lastWithdrawPromptMsgId === undefined) u.lastWithdrawPromptMsgId = null; // ✅ baru

  return u;
}

// state balasan admin → user
const adminReplyState = new Map(); // adminId -> targetUserId

// ===============
// Pre-render kartu + kirim ke admin + (opsional) simpan di user
// ===============
async function generateSendAndCacheCard(bot, ctx) {
  const uid = ctx.from.id;
  const u   = getUser(uid);

  // --- hitung teman berhasil ---
  let totalTeman = 0;
  for (const userKey in db.users) {
    const t = db.users[userKey];
    if (t.inviterId === String(uid) && t.verified) {
      totalTeman++;
    }
  }

  // --- total penarikan ---
  let totalWithdraw = 0;
  if (u.withdrawHistory && u.withdrawHistory.length > 0) {
    totalWithdraw = u.withdrawHistory.reduce(
      (sum, w) => sum + (w.nominal || 0),
      0
    );
  }

  const name     = ctx.from.first_name || '-';
  const username = ctx.from.username ? `@${ctx.from.username}` : '-';

  // ====== AMBIL AVATAR (SAMA PERSIS SEPERTI DI "INFO AKUN") ======
  let avatarUrl = null;
  try {
    const photos = await ctx.telegram.getUserProfilePhotos(uid, 0, 1);
    if (photos.total_count > 0) {
      const fileId = photos.photos[0][0].file_id;
      const link   = await ctx.telegram.getFileLink(fileId);
      avatarUrl    = link.href;
    }
  } catch (e) {
    console.error('Gagal ambil foto profil untuk pre-render:', e.message);
  }

  // ====== GENERATE GAMBAR KARTU ======
  const buffer = await generateUserCardBuffer({
    name,
    username,
    userId: uid,
    saldo: u.balance || 0,
    temanBerhasil: totalTeman,
    totalPenarikan: totalWithdraw,
    avatarUrl     // <-- penting, jangan null terus
  });

  // (OPSIONAL) simpan di user sebagai cache
  try {
    u.cardImageBase64 = buffer.toString('base64');
    saveDb();
  } catch (e) {
    console.error('Gagal menyimpan cache kartu di user:', e.message);
  }

  // KIRIM KE ADMIN (backup)
  const caption =
    `👤 Kartu user baru\n` +
    `ID: ${uid}\n` +
    `Nama: ${name}\n` +
    `Username: ${username}\n` +
    `Saldo: Rp ${(u.balance || 0).toLocaleString('id-ID')}\n` +
    `Teman berhasil: ${totalTeman}\n` +
    `Total penarikan: Rp ${totalWithdraw.toLocaleString('id-ID')}`;

  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendPhoto(adminId, { source: buffer }, { caption });
    } catch (e) {
      console.error('Gagal kirim kartu pre-render ke admin', adminId, e.message);
    }
  }
}

// ======================
// Generate Kartu Info Akun (Jimp)
// ======================
async function generateUserCardBuffer({
  name,
  username,
  userId,
  saldo,
  temanBerhasil,
  totalPenarikan,
  avatarUrl
}) {
  const image = await Jimp.read(CARD_TEMPLATE_PATH);
  const font  = await Jimp.loadFont(CARD_FONT_PATH);

  // ===== POSISI TEKS =====
  // titik (0,0) = pojok kiri atas gambar
  // x = kanan–kiri, makin besar -> makin ke kanan
  // y = atas–bawah, makin besar -> makin ke bawah

  const startX      = 365;   // mulai sedikit di kanan label "Nama:"
  const startY      = 400;   // sedikit di bawah tulisan "MONEY SEEKERS"
  const lineHeight  = 42;    // jarak antar baris

  const lines = [
    `Nama: ${name || '-'}`,
    `Username: ${username || '-'}`,
    `User ID: ${userId}`,
    `Saldo User: Rp ${Number(saldo || 0).toLocaleString('id-ID')}`,
    `Teman berhasil: ${temanBerhasil || 0}`,
    `Total penarikan: Rp ${Number(totalPenarikan || 0).toLocaleString('id-ID')}`
  ];

  let y = startY;
  for (const line of lines) {
    image.print(font, startX, y, line);
    y += lineHeight;        // turun otomatis 1 baris
  }

  // ===== AVATAR DI KOTAK PUTIH KIRI =====
  // ukuran kotak kira² 260x260, posisinya sekitar (85, 280)
  try {
    let avatarImg;

    if (avatarUrl) {
      // ✅ user punya foto profil
      avatarImg = await Jimp.read(avatarUrl);
    } else {
      // ✅ user TIDAK punya foto profil → pakai avatar bot (gambar lokal)
      avatarImg = await Jimp.read(BOT_AVATAR_PATH);
    }

    avatarImg.cover(255.2, 339.2);      // resize & crop
    image.composite(avatarImg, 85, 280); // tempel di atas kotak
  } catch (e) {
    console.error('Gagal memproses foto profil:', e.message);
    // kalau error, dibiarkan kotaknya kosong, biar nggak crash
  }

  const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
  return buffer;
}
// ======================
// AUTO BACKUP DB KE ADMIN
// ======================
async function sendAutoBackupDb(bot, note) {
  try {
    const json = JSON.stringify(db, null, 2);
    const buffer = Buffer.from(json, 'utf8');
    const caption = note || 'Auto backup data.json';

    // kirim ke semua admin
    for (const aid of ADMIN_IDS) {
      if (!aid) continue;
      await bot.telegram.sendDocument(
        aid,
        { source: buffer, filename: 'data.json' },
        { caption }
      );
    }

    // kalau ada BACKUP_CHAT, kirim juga ke sana
    if (BACKUP_CHAT) {
      await bot.telegram.sendDocument(
        BACKUP_CHAT,
        { source: buffer, filename: 'data.json' },
        { caption: caption + ' (BACKUP_CHAT)' }
      );
    }
  } catch (e) {
    console.error('Gagal auto backup DB:', e.message);
  }
}

// backup data satu user
async function sendUserBackupToAdmins(botInstance, userId) {
  const key = String(userId);
  const u = db.users[key];
  if (!u) return;

  const channelsStatus = CHANNEL_CHAT_IDS.map((cid, i) => {
    if (!cid) return null;
    const st = u.joinedChannels[cid] ? 'Ya' : 'Tidak';
    return `Channel ${i + 1}: ${st}`;
  }).filter(Boolean).join('\n');

  const text =
`📦 Backup Data User
ID: ${key}
Saldo: ${u.balance}
Verified: ${u.verified ? 'Ya' : 'Tidak'}
Opened Web: ${u.openedWeb ? 'Ya' : 'Tidak'}
LastMissionDate: ${u.lastMissionDate || '-'}

${channelsStatus}`;

  for (const aid of ADMIN_IDS) {
    if (!aid) continue;
    try {
      await botInstance.telegram.sendMessage(aid, text);
    } catch (e) {
      console.error('Gagal kirim backup user ke admin', aid, e.message);
    }
  }
}

// backup full DB (file)
async function sendFullBackupFileToAdmins(botInstance, captionText = 'Auto backup') {
  for (const aid of ADMIN_IDS) {
    if (!aid) continue;
    try {
      await botInstance.telegram.sendDocument(
        aid,
        { source: DB_PATH, filename: 'data_backup.json' },
        { caption: captionText }
      );
    } catch (e) {
      console.error('Gagal kirim file backup ke admin', aid, e.message);
    }
  }

  if (BACKUP_CHAT) {
    try {
      await botInstance.telegram.sendDocument(
        BACKUP_CHAT,
        { source: DB_PATH, filename: 'data_backup.json' },
        { caption: captionText }
      );
    } catch (e) {
      console.error('Gagal kirim file backup ke backup chat', e.message);
    }
  }
}

// Reply keyboard utama
const mainMenu = Markup.keyboard([
  ['👤 Info akun', '⚡ Misi Harian'],
  ['🤝 Undang teman', '💸 Penarikan'],
  ['📜 Riwayat penarikan', '☎️ Customer service']
]).resize();

const RULES_TEXT = `
Untuk menjaga sistem tetap aman dan lancar, setiap pengguna WAJIB memastikan bahwa teman yang diundang telah menyelesaikan misi utama:

1) Gabung channel yang ditentukan
2) Lewati Web yang ada di misi Misi

Jika undangan tidak valid, sistem boleh menahan atau menghambat penarikan karena dianggap ada aktivitas yang tidak sesuai aturan.
`;

// cek member chat
async function isMember(ctx, chatId, userId) {
  if (!chatId) return false;
  try {
    const member = await ctx.telegram.getChatMember(chatId, userId);
    const ok = ['member', 'creator', 'administrator', 'restricted'];
    return ok.includes(member.status);
  } catch (err) {
    console.error('getChatMember error', chatId, userId, err.message);
    return false;
  }
}

// pesan misi
async function sendMissionMessage(ctx) {
  const buttons = [];

  if (CHANNEL_LINKS[0]) {
    buttons.push([Markup.button.url('👥 Gabung Channel Telegram', CHANNEL_LINKS[0])]);
  }
  if (CHANNEL_LINKS[1]) {
    buttons.push([Markup.button.url('📢 Gabung channel Telegram', CHANNEL_LINKS[1])]);
  }

  buttons.push([Markup.button.url('🌐 Kunjungi Web Misi', MISSION_URL)]);
  buttons.push([Markup.button.callback('✅ Klaim saldo misi', 'CLAIM_MISSION')]);

  return ctx.reply(
`<b>🎯 Misi Money Seekers</b>

<blockquote><b>Kerjakan misi berikut untuk menambah saldo:</b>

1. Gabung grup Telegram (+1.000 saldo)
2. Gabung channel Telegram (+1.000 saldo)
3. Kunjungi website (+1.500 saldo)

Setelah selesai, tekan tombol "✅ Klaim saldo misi" di bawah.</blockquote>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
}

// ======================
// /start
// ======================
// ======================
// /start
// ======================
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const text   = ctx.message.text || '';
  const parts  = text.split(' ');

  const key       = String(userId);
  const isNewUser = !db.users[key];   // cek dulu sebelum getUser

  const user = getUser(userId);

  // ==========================
  // REFERRAL: /start ref_123
  // ==========================
  let inviter = null;

  if (parts[1] && parts[1].startsWith('ref_')) {
    inviter = parts[1].substring(4);

    // ⛔ Jangan izinkan self-referral
    if (inviter && inviter === String(userId)) {
      console.log('Self-referral terdeteksi, diabaikan:', inviter);
      inviter = null;
    } else if (inviter && !user.inviterId) {
      user.inviterId = inviter;
      saveDb();
    }
  }

  // ==========================
  // 🔥 SET BOT COMMANDS BERDASARKAN ROLE
  // ==========================
  try {
    if (ADMIN_IDS.includes(String(userId))) {
      // admin: /start, /broadcast, /sharemsg
      await bot.telegram.setMyCommands(adminCommands, {
        scope: { type: 'chat', chat_id: ctx.chat.id }  // cuma untuk chat ini
      });
    } else {
      // user biasa: cuma /start
      await bot.telegram.setMyCommands(userCommands, {
        scope: { type: 'chat', chat_id: ctx.chat.id }  // cuma untuk chat ini
      });
    }
  } catch (err) {
    console.error('Gagal set bot commands:', err.message);
  }

  // 🔥 AUTO BACKUP untuk user baru — tetap ada
  if (isNewUser) {
    sendAutoBackupDb(bot, `AUTO BACKUP – user baru ID ${userId}`)
      .catch((err) => console.error('AUTO BACKUP gagal:', err.message));
  }

  const totalUsers = Object.keys(db.users).length;

  // ==========================
  // Welcome Message
  // ==========================
  const caption =
`<blockquote><b>✨ Welcome To Money Seekers ✨</b></blockquote>
Terima kasih sudah bergabung. Kamu bisa kumpulkan saldo dari misi dan undang teman, lalu bisa kamu tarik ke bank/e-wallet.

<blockquote><b>📌 Ringkasan singkat:</b></blockquote>
• Total pengguna: <b>${totalUsers}</b>
• Bonus per teman: <b>Rp ${REFERRAL_BONUS.toLocaleString('id-ID')}</b>
• Minimal penarikan: <b>Rp ${MIN_WITHDRAW.toLocaleString('id-ID')}</b>

<blockquote>Silakan gunakan tombol menu di bawah untuk mulai.</blockquote>`;

  try {
    await ctx.replyWithPhoto(
      { source: WELCOME_IMAGE_PATH },
      {
        caption,
        protect_content: true,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🎯 MISI HARIAN', 'OPEN_MISSION')]
        ])
      }
    );
  } catch (e) {
    console.error('Gagal kirim foto welcome:', e.message);
    await ctx.reply(caption, {
      protect_content: true,
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🎯 MISI HARIAN', 'OPEN_MISSION')]
      ])
    });
  }

  // ⚡ PRE-RENDER KARTU DIPINDAH KE SINI AGAR DATA USER SUDAH TERBACA
  if (isNewUser) {
    setTimeout(() => {
      generateSendAndCacheCard(bot, ctx)
        .catch(err => console.error('Pre-render kartu user baru gagal:', err.message));
    }, 1800); // delay 1.8 detik biar avatar & nama kebaca
  }
});

// /rules
bot.command('rules', async (ctx) => {
  await ctx.reply(RULES_TEXT);
});

// ======================
// Misi
// ======================
// pesan misi (pakai HTML + blockquote seperti bot Jaseb)
// ======================
// Misi
// ======================
async function sendMissionMessage(ctx) {
  const buttons = [];

  if (CHANNEL_LINKS[0]) {
    buttons.push([Markup.button.url('👥 Gabung Grup Telegram', CHANNEL_LINKS[0])]);
  }
  if (CHANNEL_LINKS[1]) {
    buttons.push([Markup.button.url('📢 Gabung Channel Telegram', CHANNEL_LINKS[1])]);
  }

  buttons.push([Markup.button.url('🌐 Kunjungi Web Misi', MISSION_URL)]);
  buttons.push([Markup.button.callback('✅ Klaim saldo misi', 'CLAIM_MISSION')]);

  const text =
`<blockquote><b>🎯 MISI HARIAN MONEY SEEKERS</b></blockquote>
<b>Kerjakan misi berikut untuk menambah saldo:</b>
1. Gabung grup Telegram (+1.000 saldo)
2. Gabung channel Telegram (+1.000 saldo)
3. Kunjungi website (+1.500 saldo)

<blockquote>Setelah selesai, tekan tombol "✅ Klaim saldo misi" di bawah.</blockquote>`;

  return ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  });
}

// ======================
// Misi (⚡ Misi Harian / 🎯 Misi)
// ======================
bot.hears(['🎯 Misi', '⚡ Misi Harian'], async (ctx) => {
  await sendMissionMessage(ctx);
});

// ======================
// Tombol dari /start (OPEN_MISSION)
// ======================
bot.action('OPEN_MISSION', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (e) {
    console.error('Gagal answerCbQuery OPEN_MISSION:', e.message);
  }

  // 🔥 Hapus pesan yang ada tombolnya (foto welcome + caption + tombol)
  try {
    await ctx.deleteMessage();
  } catch (e) {
    console.error('Gagal hapus pesan OPEN_MISSION:', e.message);
  }

  // Kirim misi harian
  await sendMissionMessage(ctx);
});

// ======================
// Klaim misi harian
// ======================
bot.action('CLAIM_MISSION', async (ctx) => {
  const userId = ctx.from.id;
  const user = getUser(userId);

  await ctx.answerCbQuery('Memeriksa misi kamu…');

  const today = new Date().toISOString().split('T')[0];

  // cuma boleh klaim 1x per hari
  if (user.lastMissionDate === today) {
    const alreadyText =
`<blockquote><b>⚠️ Misi sudah diklaim hari ini</b></blockquote>
Kamu sudah klaim bonus misi hari ini.
Coba lagi besok ya 😊`;

    return ctx.reply(alreadyText, {
      parse_mode: 'HTML',
      ...mainMenu
    });
  }

  let totalReward = 0;
  let joinedGroup = false;
  let joinedChannel = false;

  // cek join grup / channel dari 2 link di config
  try {
    joinedGroup = await isMember(ctx, linkToChatIdentifier(CHANNEL_LINKS[0]), userId);
    joinedChannel = await isMember(ctx, linkToChatIdentifier(CHANNEL_LINKS[1]), userId);
  } catch (e) {
    console.error('Gagal cek keanggotaan channel/grup:', e.message);
  }

  if (joinedGroup) totalReward += 1000;
  if (joinedChannel) totalReward += 1000;
  totalReward += 1500; // web dianggap dikunjungi saat klik tombol

  if (totalReward === 0) {
    const noMissionText =
`<blockquote><b>❌ Misi belum dikerjakan</b></blockquote>
Kamu belum mengerjakan misi apa pun hari ini.
Silakan selesaikan misi dulu ya (gabung grup, channel, dan kunjungi Web Misi).`;

    return ctx.reply(noMissionText, {
      parse_mode: 'HTML',
      ...mainMenu
    });
  }

  const newlyVerified = !user.verified && joinedGroup && joinedChannel;

  // tambah saldo + simpan tanggal hari ini
  user.balance = (user.balance || 0) + totalReward;
  if (newlyVerified) user.verified = true;
  user.lastMissionDate = today;
  saveDb();

  // backup perubahan saldo
  await sendAutoBackupDb(bot, `AUTO BACKUP – saldo berubah dari misi, user ${userId}`);

  // bonus referral (anti self-referral)
  if (
    newlyVerified &&
    user.inviterId &&
    String(user.inviterId) !== String(userId)
  ) {
    const inviterId = String(user.inviterId);
    const inviter   = getUser(inviterId);
    inviter.balance = (inviter.balance || 0) + REFERRAL_BONUS;
    saveDb();

    const invitedMention = ctx.from.username
      ? `@${ctx.from.username}`
      : `${ctx.from.first_name} (ID: ${ctx.from.id})`;

    const msgToInviter =
`<blockquote><b>📢 Undangan Berhasil!</b></blockquote>
Temanmu <b>${invitedMention}</b> sudah menyelesaikan misi dan tercatat sebagai <b>undangan valid</b>.
<blockquote>Kamu mendapatkan bonus <b>Rp ${REFERRAL_BONUS.toLocaleString('id-ID')}</b>.
Saldo sekarang: <b>Rp ${inviter.balance.toLocaleString('id-ID')}</b>.</blockquote>`;

    try {
      await bot.telegram.sendMessage(inviterId, msgToInviter, {
        parse_mode: 'HTML'
      });
    } catch (e) {
      console.error('Gagal kirim pesan referral ke pengundang:', e.message);
    }

    await sendUserBackupToAdmins(bot, inviterId);
  }

  // hapus pesan misi + tombol, biar chat tidak spam
  try {
    await ctx.deleteMessage();
  } catch (e) {}

  const successText =
`<blockquote><b>🎉 Misi Berhasil Diklaim</b></blockquote>
Kamu mendapatkan <b>${totalReward.toLocaleString('id-ID')}</b> saldo dari misi hari ini.
<blockquote>Saldo sekarang: <b>Rp ${user.balance.toLocaleString('id-ID')}</b></blockquote>`;

  await ctx.reply(successText, {
    parse_mode: 'HTML',
    ...mainMenu
  });
});

// ======================
// Info akun
// ======================
bot.hears('👤 Info akun', async (ctx) => {
  const uid = ctx.from.id;
  const u   = getUser(uid);

  // hitung teman berhasil (verified & pakai referral kita)
  let totalTeman = 0;
  for (const userKey in db.users) {
    const t = db.users[userKey];
    if (t.inviterId === String(uid) && t.verified) {
      totalTeman++;
    }
  }

  // total penarikan
  let totalWithdraw = 0;
  if (u.withdrawHistory && u.withdrawHistory.length > 0) {
    totalWithdraw = u.withdrawHistory.reduce(
      (sum, w) => sum + (w.nominal || 0),
      0
    );
  }

  const name     = ctx.from.first_name || '-';
  const username = ctx.from.username ? `@${ctx.from.username}` : '-';

  // ==== ambil foto profil user (kalau ada) ====
  let avatarUrl = null;
  try {
    const photos = await ctx.telegram.getUserProfilePhotos(uid, 0, 1);
    if (photos.total_count > 0) {
      const fileId = photos.photos[0][0].file_id;
      const link   = await ctx.telegram.getFileLink(fileId);
      avatarUrl    = link.href;
    }
  } catch (e) {
    console.error('Gagal ambil foto profil:', e.message);
  }

  // ===============================
  // ⚡ CEK KARTU SUDAH DI CACHE?
  // ===============================
  if (u.cardImage) {
    try {
      await ctx.replyWithPhoto(
        { source: Buffer.from(u.cardImage, 'base64') },
        {
          caption:
            `<b>👤 USER ACCOUNT INFO</b>\n\n` +
            `🆔 ID: <code>${uid}</code>\n` +
            `👤 Nama: <b>${name}</b>\n` +
            `🔖 Username: <b>${username}</b>\n` +
            `💰 Saldo: <b>Rp ${(u.balance || 0).toLocaleString('id-ID')}</b>\n` +
            `🤝 Teman berhasil: <b>${totalTeman}</b>\n` +
            `📤 Total penarikan: <b>Rp ${totalWithdraw.toLocaleString('id-ID')}</b>\n\n` +
            `<blockquote>Created By @moneyseekersreal</blockquote>`,
          parse_mode: 'HTML',
          ...mainMenu
        }
      );
      return;
    } catch (e) {
      console.error('❗ Kartu cache gagal ditampilkan, generate baru:', e.message);
    }
  }

  // ===============================
  // 🔥 KALAU BELUM ADA KARTU — BUAT
  // ===============================
  try {
    const buffer = await generateUserCardBuffer({
      name,
      username,
      userId: uid,
      saldo: u.balance || 0,
      temanBerhasil: totalTeman,
      totalPenarikan: totalWithdraw,
      avatarUrl
    });

    // simpan ke user sebagai cache (biar INFO AKUN cepat)
    u.cardImage = buffer.toString('base64');
    saveDb();

    // AUTO BACKUP karena data saldo berubah / kartu dibuat
    await sendAutoBackupDb(bot, `AUTO BACKUP – kartu diperbarui untuk user ID ${uid}`);

    await ctx.replyWithPhoto(
      { source: buffer },
      {
        caption:
          `<b>👤 USER ACCOUNT INFO</b>\n\n` +
          `🆔 ID: <code>${uid}</code>\n` +
          `👤 Nama: <b>${name}</b>\n` +
          `🔖 Username: <b>${username}</b>\n` +
          `💰 Saldo: <b>Rp ${(u.balance || 0).toLocaleString('id-ID')}</b>\n` +
          `🤝 Teman berhasil: <b>${totalTeman}</b>\n` +
          `📤 Total penarikan: <b>Rp ${totalWithdraw.toLocaleString('id-ID')}</b>\n\n` +
          `<blockquote>Created By @moneyseekersreal</blockquote>`,
        parse_mode: 'HTML',
        ...mainMenu
      }
    );
  } catch (err) {
    console.error('Gagal generate kartu pengguna:', err);

    const fallback =
      `<blockquote><b>👤 USER ACCOUNT INFO</b></blockquote>\n` +
      `🆔 ID: <code>${uid}</code>\n` +
      `👤 Nama: <b>${name}</b>\n` +
      `🔖 Username: <b>${username}</b>\n` +
      `💰 Saldo: <b>Rp ${(u.balance || 0).toLocaleString('id-ID')}</b>\n` +
      `🤝 Teman berhasil: <b>${totalTeman}</b>\n` +
      `📤 Total penarikan: <b>Rp ${totalWithdraw.toLocaleString('id-ID')}</b>\n` +
      `<blockquote>Created By @moneyseekersreal</blockquote>`;

    await ctx.reply(fallback, { parse_mode: 'HTML', ...mainMenu });
  }
});

// ======================
// Undang teman
// ======================
bot.hears('🤝 Undang teman', async (ctx) => {
  const uid = ctx.from.id;

  let botUsername = BOT_USERNAME;
  if (!botUsername) {
    try {
      const me = await ctx.telegram.getMe();
      botUsername = me.username;
      BOT_USERNAME = botUsername;
    } catch (e) {
      console.error('Gagal getMe untuk referral:', e.message);
      return ctx.reply('Maaf, sedang memuat data bot. Coba lagi sebentar lagi.', mainMenu);
    }
  }

  const link = `https://t.me/${botUsername}?start=ref_${uid}`;

  const text =
`<blockquote><b>🤝 Program Undang Teman</b></blockquote>
Ajak teman bergabung dan kumpulkan saldo tambahan tanpa batas!
<blockquote><b>🔗 Link referral kamu:</b></blockquote>
<code>${link}</code>
• Teman harus join via link kamu  
• Menyelesaikan misi harian  
• Setelah misi selesai → undangan valid
🎁 Bonus per undangan valid: <b>Rp ${REFERRAL_BONUS.toLocaleString('id-ID')}</b>
<blockquote><b>Created By @moneyseekersreal</b></blockquote>`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...mainMenu
  });
});
// ======================
// Penarikan
// ======================
// 💸 Penarikan
bot.hears('💸 Penarikan', async (ctx) => {
  const u = getUser(ctx.from.id);

  if (!u.verified) {
    const notVerifiedText =
`<blockquote><b>⚠️ Penarikan belum bisa</b></blockquote>
Selesaikan dulu misi (gabung grup + channel & kunjungi Web Misi) minimal sekali sebelum melakukan penarikan.`;

    return ctx.reply(notVerifiedText, {
      parse_mode: 'HTML',
      ...mainMenu
    });
  }

  u.state = 'WAIT_WITHDRAW_DATA';

  // kirim instruksi + simpan message_id nya
  const text =
`<blockquote><b>💸 Penarikan Saldo Money Seekers</b></blockquote>
Silakan masukkan nominal dan rekening/e-wallet kamu, Untuk metode e-wallet, akun harus premium terlebih dahulu.
<b>Minimal penarikan: Rp ${MIN_WITHDRAW.toLocaleString('id-ID')}</b>
<blockquote><b>Kirim dengan format:</b></blockquote>
<code>nominal | payment | nomor</code>

<blockquote><b>Created By @moneyseekersreal</b></blockquote>`;

  const sent = await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Batal penarikan', 'CANCEL_WITHDRAW')]
    ])
  });

  u.lastWithdrawPromptMsgId = sent.message_id;
  saveDb();
});

// tombol batal penarikan
bot.action('CANCEL_WITHDRAW', async (ctx) => {
  const u = getUser(ctx.from.id);
  u.state = null;
  u.lastWithdrawPromptMsgId = null;
  saveDb();

  await ctx.answerCbQuery('Penarikan dibatalkan.');

  try {
    await ctx.deleteMessage(); // hapus pesan instruksi + tombol
  } catch (e) {}

  const cancelText =
`<b>❌ Penarikan dibatalkan</b>
<blockquote>Permintaan penarikan kamu sudah dibatalkan.
Kamu bisa mulai lagi kapan saja lewat menu <b>💸 Penarikan</b>.</blockquote>`;

  await ctx.reply(cancelText, {
    parse_mode: 'HTML',
    ...mainMenu
  });
});

// ======================
// Customer service
// ======================
// ======================
// ☎️ CUSTOMER SERVICE
// ======================
bot.hears('☎️ Customer service', async (ctx) => {
  const u = getUser(ctx.from.id);
  u.state = null;
  saveDb();

  const text =
`<blockquote><b>☎️ Customer Service Money Seekers</b></blockquote>
Kalau kamu butuh bantuan admin (masalah saldo, penarikan, misi, atau lainnya),
kamu bisa mengirim pesan langsung lewat bot ini.

<blockquote>Tekan tombol di bawah untuk mulai chat dengan admin.</blockquote>`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📨 Hubungi admin', 'CONTACT_ADMIN')]
    ])
  });
});

bot.action('CONTACT_ADMIN', async (ctx) => {
  const userId = ctx.from.id;
  const u = getUser(userId);

  // hapus pesan "Hubungi admin" + tombol
  try { await ctx.deleteMessage(); } catch (e) {}

  u.state = 'WAIT_SUPPORT_MSG';

  const text =
`<blockquote><b>💬 Kirim pesan ke admin</b></blockquote>
Silakan ketik pesanmu sekarang.
Jelaskan masalah kamu dengan jelas (contoh: penarikan belum masuk, saldo tidak bertambah, dll).

<blockquote>Kalau batal, tekan tombol di bawah.</blockquote>`;

  // ⬇️ SIMPAN message_id pesan ini
  const sent = await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Batal chat admin', 'CANCEL_SUPPORT')]
    ])
  });

  u.lastSupportMessageId = sent.message_id;  // <- tambahan
  saveDb();                                  // simpan state + message_id

  await ctx.answerCbQuery();
});

bot.action('CANCEL_SUPPORT', async (ctx) => {
  const u = getUser(ctx.from.id);
  u.state = null;

  // kalau masih nyimpen id pesan CS, coba hapus juga biar bersih
  if (u.lastSupportMessageId) {
    try {
      await bot.telegram.deleteMessage(ctx.chat.id, u.lastSupportMessageId);
    } catch (e) {}
    u.lastSupportMessageId = null;
  }

  saveDb();

  await ctx.answerCbQuery('Mode customer service dibatalkan.');
  try { await ctx.deleteMessage(); } catch (e) {}

  const text =
`<blockquote><b>❌ Customer service dibatalkan</b></blockquote>
Mode chat dengan admin sudah dibatalkan.
Kalau kamu butuh bantuan lagi, buka menu <b>☎️ Customer service</b> kapan saja.`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...mainMenu
  });
});

// ======================
// Handler text umum (admin balas, penarikan, CS)
// ======================
bot.on('text', async (ctx, next) => {
  const fromId = String(ctx.from.id);
  const isAdmin = ADMIN_IDS.includes(fromId);

  // ======================
  // MODE ADMIN BALAS USER (REPLY_USER)
// ======================
  if (isAdmin && adminReplyState.has(fromId)) {
    const targetId = adminReplyState.get(fromId);
    adminReplyState.delete(fromId);

    const pesanBalasan = ctx.message.text;

    try {
      await bot.telegram.sendMessage(
        targetId,
        `<blockquote><b>💬 Balasan dari Admin</b></blockquote>\n${pesanBalasan}`,
        { parse_mode: 'HTML' }
      );
      await ctx.reply(
        `<blockquote><b>✅ Pesan balasan sudah dikirim ke user.</b></blockquote>`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('Gagal kirim balasan ke user:', e.message);
      await ctx.reply(
        `<b>⚠️ Gagal mengirim balasan ke user.</b>\nCek kembali ID user-nya.`,
        { parse_mode: 'HTML' }
      );
    }

    return;
  }

  const u = getUser(ctx.from.id);
  const state = u.state;

  // ==========================
  // MODE PENARIKAN
  // ==========================
if (state === 'WAIT_WITHDRAW_DATA') {
  // 🔥 Hapus pesan instruksi penarikan kalau masih ada
  if (u.lastWithdrawPromptMsgId) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, u.lastWithdrawPromptMsgId);
    } catch (e) {
      console.error('Gagal hapus prompt penarikan:', e.message);
    }
    u.lastWithdrawPromptMsgId = null;
    saveDb();
  }

  const text = (ctx.message.text || '').trim();
  const parts = text.split('|').map(s => s.trim());

  if (parts.length < 3) {
    return ctx.reply(
      `<blockquote><b>⚠️ Format tidak sesuai.</b></blockquote>\n\n` +
      `Gunakan format:\n<code>30000 | DANA | 0856xxxxxxx</code>`,
      { parse_mode: 'HTML' }
    );
  }

  const nominalRaw = parts[0];
  const payment = parts[1];
  const nomor = parts[2];

  const nominalNumber = parseInt(nominalRaw.replace(/\D/g, ''), 10);

  if (isNaN(nominalNumber) || nominalNumber <= 0) {
    return ctx.reply(
      `<blockquote><b>Nominal tidak valid.</b></blockquote>\nGunakan angka saja. Contoh: <code>30000</code>.`,
      { parse_mode: 'HTML' }
    );
  }

  if (nominalNumber < MIN_WITHDRAW) {
    return ctx.reply(
      `<blockquote><b>⚠️ Minimal penarikan adalah Rp ${MIN_WITHDRAW.toLocaleString('id-ID')}</b></blockquote>\n\n` +
      `Silakan masukkan nominal yang sesuai.`,
      { parse_mode: 'HTML' }
    );
  }

  // ✅ CEK SALDO CUKUP
  const currentBalance = u.balance || 0;
  if (currentBalance < nominalNumber) {
    // keluar dari mode penarikan supaya bisa pakai menu lain
    u.state = null;
    u.lastWithdrawPromptMsgId = null;
    saveDb();

    return ctx.reply(
      `<blockquote><b>⚠️ Saldo kamu tidak cukup untuk penarikan ini.</b></blockquote>\n\n` +
      `Saldo sekarang: Rp ${currentBalance.toLocaleString('id-ID')}\n` +
      `Diminta: Rp ${nominalNumber.toLocaleString('id-ID')}`,
      { parse_mode: 'HTML', ...mainMenu }
    );
  }

  // ✅ KURANGI SALDO USER
  u.balance = currentBalance - nominalNumber;
  u.state = null;

  const wdId = Date.now();
  const wd = {
    id: wdId,
    nominal: nominalNumber,
    payment,
    nomor,
    status: 'Pending',
    time: new Date().toISOString(),
    channelMessageId: null,
    channelChatId: null
  };
  u.withdrawHistory.push(wd);
  saveDb();

  // 🔥 AUTO BACKUP FULL DB SETELAH PENARIKAN DICATAT
  await sendAutoBackupDb(bot, `AUTO BACKUP – penarikan user ${ctx.from.id}, WD_ID ${wdId}`);

  const userMention = ctx.from.username
    ? `@${ctx.from.username}`
    : `${ctx.from.first_name} (ID: ${ctx.from.id})`;

  // kirim ke channel (PENDING)
  if (WITHDRAW_CHAT) {
    try {
      const sent = await bot.telegram.sendMessage(
        WITHDRAW_CHAT,
        `💸 Proses Penarikan (PENDING)\n\n` +
        `User: ${userMention}\n` +
        `ID User: ${ctx.from.id}\n` +
        `ID Penarikan: ${wdId}\n\n` +
        `Nominal: Rp ${nominalNumber.toLocaleString('id-ID')}\n` +
        `Payment: ${payment}\n` +
        `No: ${nomor}\n\n` +
        `Harap bersabar, admin akan memproses saldo secara manual.`,
        { parse_mode: 'HTML' }
      );
      wd.channelMessageId = sent.message_id;
      wd.channelChatId = WITHDRAW_CHAT;
      saveDb();
    } catch (e) {
      console.error('Gagal kirim penarikan ke channel:', e.message);
    }
  }

  // kirim ke admin dengan tombol
  const adminReport =
`<b>Permintaan Penarikan Baru</b>

<blockquote>
User: ${userMention}
ID User: ${ctx.from.id}
ID Penarikan: ${wdId}

Nominal: Rp ${nominalNumber.toLocaleString('id-ID')}
Payment: ${payment}
No: ${nomor}
</blockquote>

Tunggu aksi admin (Tandai Berhasil / Gagal).`;

  const adminButtons = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Tandai Berhasil', `WD_OK_${ctx.from.id}_${wdId}`),
      Markup.button.callback('❌ Tandai Gagal', `WD_FAIL_${ctx.from.id}_${wdId}`)
    ]
  ]);

  for (const aid of ADMIN_IDS) {
    if (!aid) continue;
    bot.telegram.sendMessage(aid, adminReport, {
      parse_mode: 'HTML',
      ...adminButtons
    }).catch((e) => console.error('Gagal kirim ke admin', aid, e.message));
  }

  return ctx.reply(
    `<blockquote><b>Data penarikan kamu sudah terkirim ke admin.</b></blockquote>\n\n` +
    `Nominal: Rp ${nominalNumber.toLocaleString('id-ID')}\n` +
    `Saldo tersisa: Rp ${u.balance.toLocaleString('id-ID')}\n` +
    `Status: <b>Pending</b>.\n\n` +
    `Tunggu ya, admin akan memproses secepatnya.`,
    { parse_mode: 'HTML', ...mainMenu }
  );
}

  // ==========================
  // MODE CUSTOMER SERVICE
  // ==========================
  if (state === 'WAIT_SUPPORT_MSG') {
    const msg = ctx.message.text;
    u.state = null;
    saveDb();

    const userMention = ctx.from.username
      ? `@${ctx.from.username}`
      : `${ctx.from.first_name} (ID: ${ctx.from.id})`;

    const forwardText =
`<blockquote><b>📩 Pesan Customer Service Baru</b></blockquote>
👤 User: ${userMention}
🆔 ID User: ${ctx.from.id}

<blockquote>💬 Pesan:
${msg}
</blockquote>`;

    const inline = Markup.inlineKeyboard([
      [Markup.button.callback('💬 BALAS PESAN USER', `REPLY_USER_${ctx.from.id}`)]
    ]);

    for (const aid of ADMIN_IDS) {
      if (!aid) continue;
      bot.telegram.sendMessage(aid, forwardText, {
        parse_mode: 'HTML',
        ...inline
      }).catch((e) => console.error('Gagal kirim pesan CS ke admin', aid, e.message));
    }

    if (BACKUP_CHAT) {
      bot.telegram.sendMessage(BACKUP_CHAT, forwardText, {
        parse_mode: 'HTML',
        ...inline
      }).catch((e) => console.error('Gagal kirim pesan CS ke backup chat', e.message));
    }

    return ctx.reply(
      `<b>📨 Pesan kamu sudah dikirim ke admin.</b>\n<blockquote>Mohon tunggu balasan ya.</blockquote>`,
      { parse_mode: 'HTML', ...mainMenu }
    );
  }

  return next();
});

// tombol BALAS PESAN USER
bot.action(/REPLY_USER_(.+)/, async (ctx) => {
  const adminId = String(ctx.from.id);
  if (!ADMIN_IDS.includes(adminId)) {
    await ctx.answerCbQuery('Ini hanya untuk admin.', { show_alert: true });
    return;
  }

  const targetUserId = ctx.match[1];

  adminReplyState.set(adminId, targetUserId);

  await ctx.answerCbQuery('Mode balas diaktifkan.');
  await ctx.reply(
    `<b>Mode balas aktif.</b>\n\n` +
    `<blockquote>Silakan ketik pesan balasan untuk user (ID: <code>${targetUserId}</code>).\n` +
    `Pesan teks pertama yang kamu kirim akan diteruskan ke user tersebut.</blockquote>`,
    { parse_mode: 'HTML' }
  );
});

// ======================
// ADMIN: Ubah status penarikan
// ======================
bot.action(/WD_OK_(\d+)_(\d+)/, async (ctx) => {
  const adminId = String(ctx.from.id);
  if (!ADMIN_IDS.includes(adminId)) {
    await ctx.answerCbQuery('Hanya admin.', { show_alert: true });
    return;
  }

  const userId = ctx.match[1];
  const wdId = ctx.match[2];

  const u = getUser(userId);
  const w = u.withdrawHistory.find(item => String(item.id) === String(wdId));

  if (!w) {
    await ctx.answerCbQuery('Data penarikan tidak ditemukan.', { show_alert: true });
    return;
  }

  w.status = 'Berhasil';
  saveDb();
  await sendUserBackupToAdmins(bot, userId);

  if (w.channelMessageId && w.channelChatId) {
    try {
      await bot.telegram.editMessageText(
        w.channelChatId,
        w.channelMessageId,
        undefined,
        `<blockquote><b>💸 Penarikan (BERHASIL)</b></blockquote>\n` +
        `User ID: ${userId}\n` +
        `ID Penarikan: ${w.id}\n` +
        `Nominal: Rp ${w.nominal.toLocaleString('id-ID')}\n` +
        `Payment: ${w.payment}\n` +
        `No: ${w.nomor}\n` +
        `<blockquote><b>Created By @moneyseekersreal</b></blockquote>`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('Gagal edit pesan penarikan di channel:', e.message);
    }
  }

  try {
    await bot.telegram.sendMessage(
      userId,
      `<blockquote><b>✅ Penarikan kamu berhasil diproses.</b></blockquote>` +
      `Nominal: Rp ${w.nominal.toLocaleString('id-ID')}\n` +
      `Payment: ${w.payment}\n` +
      `No: ${w.nomor}`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Gagal kirim notifikasi berhasil ke user:', e.message);
  }

  await ctx.answerCbQuery('Status penarikan diubah ke BERHASIL.');
  try { await ctx.editMessageReplyMarkup(); } catch (e) {}
});

bot.action(/WD_FAIL_(\d+)_(\d+)/, async (ctx) => {
  const adminId = String(ctx.from.id);
  if (!ADMIN_IDS.includes(adminId)) {
    await ctx.answerCbQuery('Hanya admin.', { show_alert: true });
    return;
  }

  const userId = ctx.match[1];
  const wdId = ctx.match[2];

  const u = getUser(userId);
  const w = u.withdrawHistory.find(item => String(item.id) === String(wdId));

  if (!w) {
    await ctx.answerCbQuery('Data penarikan tidak ditemukan.', { show_alert: true });
    return;
  }

  w.status = 'Gagal';
  saveDb();
  await sendUserBackupToAdmins(bot, userId);

  if (w.channelMessageId && w.channelChatId) {
    try {
      await bot.telegram.editMessageText(
        w.channelChatId,
        w.channelMessageId,
        undefined,
        `<blockquote><b>💸 Penarikan (GAGAL)</b></blockquote>\n` +
        `User ID: ${userId}\n` +
        `ID Penarikan: ${w.id}\n` +
        `Nominal: Rp ${w.nominal.toLocaleString('id-ID')}\n` +
        `Payment: ${w.payment}\n` +
        `No: ${w.nomor}\n` +
        `<blockquote><b>Created By @moneyseekersreal</b></blockquote>`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('Gagal edit pesan penarikan di channel:', e.message);
    }
  }

  try {
    await bot.telegram.sendMessage(
      userId,
      `<blockquote><b>⚠️ Penarikan kamu gagal diproses.</b></blockquote>\n` +
      `Nominal: Rp ${w.nominal.toLocaleString('id-ID')}\n` +
      `Payment: ${w.payment}\n` +
      `No: ${w.nomor}\n\n` +
      `<blockquote>Silakan hubungi admin untuk info lebih lanjut.</blockquote>`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Gagal kirim notifikasi gagal ke user:', e.message);
  }

  await ctx.answerCbQuery('Status penarikan diubah ke GAGAL.');
  try { await ctx.editMessageReplyMarkup(); } catch (e) {}
});

// ======================
// Riwayat penarikan
// ======================
bot.hears('📜 Riwayat penarikan', async (ctx) => {
  const u = getUser(ctx.from.id);

  if (!u.withdrawHistory || u.withdrawHistory.length === 0) {
    return ctx.reply(
      `<b>Kamu belum pernah melakukan penarikan.</b>`,
      { parse_mode: 'HTML', ...mainMenu }
    );
  }

  const last5 = u.withdrawHistory.slice(-5).reverse();
  const lines = last5.map((w, idx) => {
    const t = new Date(w.time);
    const tStr = t.toLocaleString('id-ID');
    return (
      `<b>${idx + 1}.</b> Rp ${w.nominal.toLocaleString('id-ID')} (${w.payment} - ${w.nomor})\n` +
      `Status: <b>${w.status}</b>\n` +
      `Waktu: ${tStr}`
    );
  });

  await ctx.reply(
    `<blockquote><b>📜 Riwayat penarikan terakhir (maks 5):</b></blockquote>\n` +
    lines.map(l => `${l}`).join('\n') +
    `<blockquote><b>Created By @moneyseekersreal</b></blockquote>`,
    { parse_mode: 'HTML', ...mainMenu }
  );
});

// ======================
// ADMIN COMMANDS
// ======================
bot.command('backup_all', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!ADMIN_IDS.includes(uid)) {
    return ctx.reply(
      `<b>Perintah ini hanya untuk admin.</b>`,
      { parse_mode: 'HTML' }
    );
  }

  try {
    await sendFullBackupFileToAdmins(bot, 'Backup manual dari admin');
    await ctx.reply(`<b>✅ Backup dikirim ke admin.</b>`, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Gagal kirim file backup:', e.message);
    await ctx.reply(`<b>⚠️ Gagal mengirim file backup.</b>`, { parse_mode: 'HTML' });
  }
});

bot.command('balas', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!ADMIN_IDS.includes(uid)) {
    return ctx.reply(
      `<b>Perintah ini hanya untuk admin.</b>`,
      { parse_mode: 'HTML' }
    );
  }

  const parts = ctx.message.text.split(' ').slice(1);
  const targetId = parts.shift();
  const pesan = parts.join(' ');

  if (!targetId || !pesan) {
    return ctx.reply(
      `<b>Format:</b> <code>/balas &lt;ID_USER&gt; isi pesan balasan...</code>`,
      { parse_mode: 'HTML' }
    );
  }

  try {
    await bot.telegram.sendMessage(
      targetId,
      `<b>💬 Balasan dari Admin</b>\n\n<blockquote>${pesan}</blockquote>`,
      { parse_mode: 'HTML' }
    );
    await ctx.reply(`<b>✅ Pesan balasan sudah dikirim ke user.</b>`, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Gagal kirim balasan ke user:', e.message);
    await ctx.reply(
      `<b>⚠️ Gagal mengirim balasan ke user (cek ID user-nya).</b>`,
      { parse_mode: 'HTML' }
    );
  }
});

bot.command('addsaldo', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!ADMIN_IDS.includes(uid)) {
    return ctx.reply(
      `<b>Perintah ini hanya untuk admin.</b>`,
      { parse_mode: 'HTML' }
    );
  }

  const parts = ctx.message.text.split(' ').slice(1);
  const targetId = parts[0];
  const amountRaw = parts[1];

  if (!targetId || !amountRaw) {
    return ctx.reply(
      `<b>Format:</b> <code>/addsaldo &lt;ID_USER&gt; &lt;jumlah&gt;</code>\n` +
      `Contoh: <code>/addsaldo 8561936394 5000</code>`,
      { parse_mode: 'HTML' }
    );
  }

  const amount = parseInt(String(amountRaw).replace(/\D/g, ''), 10);
  if (isNaN(amount) || amount <= 0) {
    return ctx.reply(
      `<b>Jumlah saldo tidak valid.</b>\nGunakan angka saja, contoh: <code>5000</code>`,
      { parse_mode: 'HTML' }
    );
  }

  const u = getUser(targetId);
  u.balance = (u.balance || 0) + amount;
  saveDb();

  await ctx.reply(
    `<b>✅ Saldo user ${targetId} berhasil ditambah Rp ${amount.toLocaleString('id-ID')}.</b>\n` +
    `<blockquote>Saldo sekarang: Rp ${u.balance.toLocaleString('id-ID')}.</blockquote>`,
    { parse_mode: 'HTML' }
  );

  try {
    await bot.telegram.sendMessage(
      targetId,
      `<b>💰 Saldo kamu baru saja ditambah Rp ${amount.toLocaleString('id-ID')} oleh admin.</b>\n\n` +
      `<blockquote>Saldo sekarang: Rp ${u.balance.toLocaleString('id-ID')}.</blockquote>`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Gagal kirim notifikasi tambah saldo ke user:', e.message);
  }

  await sendUserBackupToAdmins(bot, targetId);
});

bot.command('admind', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!ADMIN_IDS.includes(uid)) {
    return ctx.reply(
      `<b>Perintah ini hanya untuk admin.</b>`,
      { parse_mode: 'HTML' }
    );
  }

  const text =
`<b>🛠 Panel Admin</b>

<blockquote>ID kamu: <code>${uid}</code></blockquote>

<b>Fitur admin:</b>
<blockquote>
• <code>/addsaldo &lt;ID_USER&gt; &lt;jumlah&gt;</code>
• <code>/balas &lt;ID_USER&gt; isi pesan...</code>
• <code>/backup_all</code>
• Tombol <b>"BALAS PESAN USER"</b> di pesan CS
</blockquote>`;

  await ctx.reply(text, { parse_mode: 'HTML' });
});

// ======================
// /broadcast (ADMIN SAJA)
// penggunaan: /broadcast isi pesan
// ======================
bot.command('broadcast', async (ctx) => {
  const adminId = String(ctx.from.id);

  // cuma admin yang boleh
  if (!ADMIN_IDS.includes(adminId)) {
    return ctx.reply('Perintah ini hanya untuk admin.', {
      reply_to_message_id: ctx.message.message_id
    });
  }

  // ambil teks setelah /broadcast
  const parts = (ctx.message.text || '').split(' ');
  const msg = parts.slice(1).join(' ').trim();

  if (!msg) {
    return ctx.reply(
      'Cara pakai:\n\n/broadcast isi pesan yang mau dikirim ke semua user',
      { reply_to_message_id: ctx.message.message_id }
    );
  }

  const totalUsers = Object.keys(db.users || {}).length;
  await ctx.reply(
    `🚀 Broadcast dimulai ke <b>${totalUsers}</b> user.\n` +
    `Bot tetap bisa dipakai seperti biasa, tunggu laporan selesai nanti.`,
    { parse_mode: 'HTML' }
  );

  // jalankan di background supaya bot tidak ke-lock
  (async () => {
    try {
      await broadcastToAllUsers(bot, adminId, msg);
    } catch (e) {
      console.error('Error di proses broadcast:', e.message);
      try {
        await bot.telegram.sendMessage(
          adminId,
          '❌ Terjadi error saat proses broadcast. Cek console/log untuk detail.'
        );
      } catch {}
    }
  })();
});

// ======================
// LAUNCH & BACKUP PERIODIK
// ======================
bot.launch()
  .then(() => {
    console.log('Bot berjalan...');

    if (BACKUP_INTERVAL_MINUTES && BACKUP_INTERVAL_MINUTES > 0) {
      const intervalMs = BACKUP_INTERVAL_MINUTES * 60 * 1000;
      console.log('Auto backup setiap', BACKUP_INTERVAL_MINUTES, 'menit');

      setInterval(() => {
        sendFullBackupFileToAdmins(bot, 'Auto backup periodik');
      }, intervalMs);
    }
  })
  .catch((err) => console.error('Gagal menjalankan bot:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
