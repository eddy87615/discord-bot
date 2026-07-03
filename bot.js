// ============================================================================
// Unified Discord Bot
//   = boss-raid-bot  +  discord-game  +  discord-member-management
// 三合一，共用同一個 Discord Application / token
// ============================================================================

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  AttachmentBuilder,
  ChannelType,
} = require('discord.js');
const fs = require('fs');
const express = require('express');
const cron = require('node-cron');

// ============================================================================
// 環境變數
// ============================================================================
const TOKEN = process.env.TOKEN || process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ 環境變數 TOKEN 未設定');
  process.exit(1);
}

const config = {
  token: TOKEN,
  adminRoleId: process.env.ADMIN_ROLE_ID || '',
  warningThresholds: { mute: 3, kick: 5, ban: 7 },
  muteDuration: 24 * 60 * 60 * 1000,
};

// ============================================================================
// Discord Client（union of intents）
// ============================================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// ============================================================================
// [BOSS RAID] 設定與狀態
// ============================================================================
const BOSSES = [
  { id: 'papulatus', name: '拉圖斯', emoji: '⏰' },
  { id: 'hard_papulatus', name: '困難拉圖斯', emoji: '⏰' },
  { id: 'zakum', name: '殘暴炎魔', emoji: '🔥' },
  { id: 'horntail', name: '暗黑龍王', emoji: '🐲' },
  { id: 'ephenia', name: '艾畢奈雅', emoji: '🧚' },
];

// 動態遠征頻道統一歸在這個分類底下，週四整批刪除
const EXPEDITION_CATEGORY = '🐲遠征報名區';
const pinnedMessageMap = {};

// ============================================================================
// [MEMBER MANAGEMENT] 狀態 & JSON 持久化
// ============================================================================
let warningsData = {};
let marriageData = {};
let proposalData = {};
let divorceData = {};
let mutedMembers = {};

function loadJson(path) {
  try {
    if (fs.existsSync(path)) {
      const data = fs.readFileSync(path, 'utf8');
      if (data.trim()) return JSON.parse(data);
    }
  } catch (error) {
    console.error(`載入 ${path} 失敗:`, error.message);
  }
  return {};
}

function saveJson(path, obj) {
  try {
    fs.writeFileSync(path, JSON.stringify(obj, null, 2));
  } catch (error) {
    console.error(`儲存 ${path} 失敗:`, error.message);
  }
}

const loadWarnings = () => (warningsData = loadJson('./warnings.json'));
function loadMarriages() {
  marriageData = loadJson('./marriages.json');
  // 舊格式（一夫一妻）→ 新格式（配偶陣列）遷移
  for (const uid of Object.keys(marriageData)) {
    const v = marriageData[uid];
    if (v && !Array.isArray(v)) {
      marriageData[uid] = [v];
    }
  }
}
const loadProposals = () => (proposalData = loadJson('./proposals.json'));
const loadDivorces = () => (divorceData = loadJson('./divorces.json'));
const loadMutedMembers = () =>
  (mutedMembers = loadJson('./muted_members.json'));

const saveWarnings = () => saveJson('./warnings.json', warningsData);
const saveMarriages = () => saveJson('./marriages.json', marriageData);
const saveProposals = () => saveJson('./proposals.json', proposalData);
const saveDivorces = () => saveJson('./divorces.json', divorceData);
const saveMutedMembers = () => saveJson('./muted_members.json', mutedMembers);

// ============================================================================
// [MEMBER MANAGEMENT] 一般輔助
// ============================================================================
function isAdmin(member) {
  return (
    (config.adminRoleId && member.roles.cache.has(config.adminRoleId)) ||
    member.permissions.has(PermissionFlagsBits.Administrator)
  );
}

const getSpouses = (userId) =>
  Array.isArray(marriageData[userId]) ? marriageData[userId] : [];
const isMarriedTo = (a, b) => getSpouses(a).some((m) => m.spouse === b);

function createMarriage(u1, u2) {
  if (isMarriedTo(u1, u2)) return; // 冪等：不重複建立同一對婚姻
  const marriageDate = new Date().toISOString();
  if (!Array.isArray(marriageData[u1])) marriageData[u1] = [];
  if (!Array.isArray(marriageData[u2])) marriageData[u2] = [];
  marriageData[u1].push({ spouse: u2, marriageDate });
  marriageData[u2].push({ spouse: u1, marriageDate });
  saveMarriages();
}

function deleteMarriage(u1, u2) {
  if (Array.isArray(marriageData[u1])) {
    marriageData[u1] = marriageData[u1].filter((m) => m.spouse !== u2);
    if (marriageData[u1].length === 0) delete marriageData[u1];
  }
  if (Array.isArray(marriageData[u2])) {
    marriageData[u2] = marriageData[u2].filter((m) => m.spouse !== u1);
    if (marriageData[u2].length === 0) delete marriageData[u2];
  }
  saveMarriages();
}

function getUserWarnings(userId) {
  if (!warningsData[userId]) {
    warningsData[userId] = { count: 0, warnings: [], lastWarning: null };
  }
  return warningsData[userId];
}

function cleanExpiredProposals() {
  const now = Date.now();
  const expired = 30 * 60 * 1000;
  for (const id in proposalData) {
    if (now - proposalData[id].timestamp > expired) delete proposalData[id];
  }
  saveProposals();
}

function cleanExpiredDivorces() {
  const now = Date.now();
  const expired = 30 * 60 * 1000;
  for (const id in divorceData) {
    if (now - divorceData[id].timestamp > expired) delete divorceData[id];
  }
  saveDivorces();
}

async function checkMutedMembers() {
  const now = Date.now();
  for (const userId in mutedMembers) {
    const muteData = mutedMembers[userId];
    if (now < muteData.unmuteTime) continue;
    try {
      const guild = client.guilds.cache.get(muteData.guildId);
      if (guild) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member && !member.isCommunicationDisabled()) {
          try {
            const dmEmbed = new EmbedBuilder()
              .setColor('#32CD32')
              .setTitle('🔊 禁言時間已到期')
              .setDescription(`你在 **${guild.name}** 的禁言時間已結束`)
              .addFields(
                { name: '原禁言原因', value: muteData.reason },
                { name: '禁言時長', value: `${muteData.duration}分鐘` },
                {
                  name: '解除時間',
                  value: new Date().toLocaleString('zh-TW'),
                },
              )
              .setFooter({ text: '歡迎回來！請繼續遵守伺服器規則～' });
            await member.user.send({ embeds: [dmEmbed] });
          } catch {}
        }
      }
    } catch (error) {
      console.error(`檢查禁言到期 ${userId} 失敗:`, error.message);
    }
    delete mutedMembers[userId];
  }
  saveMutedMembers();
}

async function addWarning(user, moderator, reason, guild) {
  const userData = getUserWarnings(user.id);
  const warning = {
    id: Date.now(),
    reason,
    moderator: moderator.id,
    timestamp: new Date().toISOString(),
  };
  userData.warnings.push(warning);
  userData.count++;
  userData.lastWarning = warning.timestamp;
  saveWarnings();

  try {
    const dmEmbed = new EmbedBuilder()
      .setColor('#FF6B6B')
      .setTitle('⚠️ 警告通知')
      .setDescription(`你在 **${guild.name}** 收到了一個警告！`)
      .addFields(
        { name: '警告原因', value: reason },
        { name: '執行管理員', value: moderator.displayName },
        { name: '當前警告次數', value: `${userData.count}次` },
        { name: '時間', value: new Date().toLocaleString('zh-TW') },
      )
      .setFooter({ text: '請遵守伺服器規則，避免進一步的處罰！霸脫霸脫～' });
    await user.send({ embeds: [dmEmbed] });
  } catch {}

  await checkAutoActions(user, guild, userData.count);
  return warning;
}

async function checkAutoActions(user, guild, count) {
  const member = guild.members.cache.get(user.id);
  if (!member) return;
  try {
    if (count >= config.warningThresholds.ban) {
      await member.ban({
        reason: `自動封鎖 - 達到${config.warningThresholds.ban}次警告`,
      });
    } else if (count >= config.warningThresholds.kick) {
      await member.kick(
        `自動踢出 - 達到${config.warningThresholds.kick}次警告`,
      );
    } else if (count >= config.warningThresholds.mute) {
      await member.timeout(
        config.muteDuration,
        `自動禁言 - 達到${config.warningThresholds.mute}次警告`,
      );
    }
  } catch (error) {
    console.error('自動處罰失敗:', error.message);
  }
}

// ============================================================================
// [EXPEDITION] 動態遠征頻道
//   點王 → 輸入時間 → 管理員審核 → 建立頻道 → 週四整批刪除
// ============================================================================

// 找出（或建立）遠征報名分類
async function getOrCreateExpeditionCategory(guild) {
  let category = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildCategory && c.name === EXPEDITION_CATEGORY,
  );
  if (!category) {
    category = await guild.channels.create({
      name: EXPEDITION_CATEGORY,
      type: ChannelType.GuildCategory,
    });
  }
  return category;
}

// 依王 + 日期 + 時間建立一個報名頻道
async function createExpeditionChannel(guild, boss, date, time) {
  const category = await getOrCreateExpeditionCategory(guild);
  // Discord 頻道名不允許冒號，時間去掉冒號；完整可讀時間放進頻道主題
  const safeTime = time.replace(/:/g, '');
  const channel = await guild.channels.create({
    name: `${date}-${safeTime}-${boss.name}`,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `${boss.emoji} ${boss.name}　${date} ${time}　遠征報名區`,
  });

  // 在頻道貼上報名格式範本，並釘選在頂端方便大家複製
  const formatMessage = await channel.send(
    `${boss.emoji} **${boss.name} 遠征報名**　🕐 ${date} ${time}\n` +
      '公會/非公會都可以報名參加\n' +
      '請依照格式留言：ID+等級+職業\n' +
      '報名後請該團人員【自行找人】及【討論時間】喔！\n' +
      '\n1. 角色名稱 / 等級 / 職業\n2. 角色名稱 / 等級 / 職業\n3. 角色名稱 / 等級 / 職業\n...',
  );
  await formatMessage.pin().catch(() => {});

  return channel;
}

// 刪除遠征分類底下所有頻道（保留分類本身，供下週重用）
async function deleteExpeditionChannels() {
  for (const guild of client.guilds.cache.values()) {
    const category = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildCategory && c.name === EXPEDITION_CATEGORY,
    );
    if (!category) continue;
    const children = guild.channels.cache.filter(
      (c) => c.parentId === category.id,
    );
    for (const ch of children.values()) {
      await ch.delete().catch(() => {});
    }
  }
}

// 管理員發出遠征面板（每個王一顆按鈕）
async function handleExpeditionPanel(interaction) {
  const rows = [];
  for (let i = 0; i < BOSSES.length; i += 5) {
    const row = new ActionRowBuilder();
    BOSSES.slice(i, i + 5).forEach((boss) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`expedition_boss_${boss.id}`)
          .setLabel(`${boss.emoji} ${boss.name}`)
          .setStyle(ButtonStyle.Primary),
      );
    });
    rows.push(row);
  }
  const embed = new EmbedBuilder()
    .setTitle('🗡️ 建立遠征隊')
    .setDescription(
      '點選要打的王，填寫時間後送出申請。\n管理員同意後，就會自動開一個報名頻道。',
    )
    .setColor(0x5865f2);
  await interaction.reply({ embeds: [embed], components: rows });
}

// 點王按鈕 → 跳出輸入時間的視窗
async function handleExpeditionBossButton(interaction, bossId) {
  const boss = BOSSES.find((b) => b.id === bossId);
  if (!boss) return;
  const modal = new ModalBuilder()
    .setCustomId(`expedition_time_${bossId}`)
    .setTitle(`${boss.name} 遠征時間`);
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('exp_date')
        .setLabel('日期（例：0704）')
        .setPlaceholder('0704')
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('exp_time')
        .setLabel('時間（例：20:00）')
        .setPlaceholder('20:00')
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
  );
  await interaction.showModal(modal);
}

// 送出時間 → 產生一則審核申請（含 同意 / 拒絕 按鈕）
async function handleExpeditionTimeModal(interaction, bossId) {
  const boss = BOSSES.find((b) => b.id === bossId);
  if (!boss) return;
  // 去掉分隔符號 ~，避免破壞 customId 解析
  const date = interaction.fields
    .getTextInputValue('exp_date')
    .trim()
    .replace(/~/g, '');
  const time = interaction.fields
    .getTextInputValue('exp_time')
    .trim()
    .replace(/~/g, '');

  const embed = new EmbedBuilder()
    .setTitle('📋 遠征隊申請（待管理員審核）')
    .setColor(0xfaa61a)
    .addFields(
      { name: '王', value: `${boss.emoji} ${boss.name}`, inline: true },
      { name: '日期', value: date, inline: true },
      { name: '時間', value: time, inline: true },
      { name: '申請人', value: `<@${interaction.user.id}>` },
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`exp_ok~${bossId}~${date}~${time}`)
      .setLabel('✅ 同意')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`exp_no~${bossId}`)
      .setLabel('❌ 拒絕')
      .setStyle(ButtonStyle.Danger),
  );
  await interaction.reply({ embeds: [embed], components: [row] });
}

// 管理員按 同意 / 拒絕
async function handleExpeditionApproval(interaction, customId) {
  if (!isAdmin(interaction.member)) {
    await interaction.reply({
      content: '❌ 只有管理員可以審核遠征申請。',
      flags: 64,
    });
    return;
  }

  if (customId.startsWith('exp_no~')) {
    await interaction.update({
      content: `❌ 已由 <@${interaction.user.id}> 拒絕此遠征申請。`,
      embeds: [],
      components: [],
    });
    // 30 秒後自動刪除審核結果訊息
    setTimeout(() => interaction.message.delete().catch(() => {}), 30 * 1000);
    return;
  }

  // exp_ok~bossId~date~time
  const [, bossId, date, time] = customId.split('~');
  const boss = BOSSES.find((b) => b.id === bossId);
  if (!boss) {
    await interaction.reply({ content: '❌ 找不到對應的王。', flags: 64 });
    return;
  }

  try {
    const channel = await createExpeditionChannel(
      interaction.guild,
      boss,
      date,
      time,
    );
    await interaction.update({
      content: `✅ 已由 <@${interaction.user.id}> 核准，已建立報名頻道：${channel}`,
      embeds: [],
      components: [],
    });
    // 30 秒後自動刪除審核結果訊息
    setTimeout(() => interaction.message.delete().catch(() => {}), 30 * 1000);
  } catch (err) {
    console.error('建立遠征頻道失敗:', err);
    const msg =
      err.code === 50013
        ? '❌ 我沒有「管理頻道」權限，無法建立頻道。請幫我補上該權限後再試。'
        : '❌ 建立頻道時發生錯誤，請查看後台 log。';
    await interaction.reply({ content: msg, flags: 64 });
  }
}

// ============================================================================
// [GAME] 求籤 / 同性戀指數 共用
// ============================================================================
function seededRandom(seed, max) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return max ? Math.abs(hash) % max : Math.abs(hash) % 101;
}

function createProgressBar(percentage) {
  const totalBars = 20;
  const filledBars = Math.round((percentage / 100) * totalBars);
  const emptyBars = totalBars - filledBars;
  const filled = '🌈'.repeat(Math.max(0, filledBars));
  const empty = '⬜'.repeat(Math.max(0, emptyBars));
  return `${filled}${empty} ${percentage}%`;
}

// ============================================================================
// [GAME] 指令處理
// ============================================================================
async function handleFortuneCommand(interaction) {
  try {
    const targetUser = interaction.options.getUser('成員') || interaction.user;
    const isSelf = targetUser.id === interaction.user.id;
    const today = new Date().toDateString();
    const seed = `fortune_${targetUser.id}_${today}`;
    const randomValue = seededRandom(seed, 100);

    const fortuneLevels = [
      { name: '大吉', probability: 15, color: '#FFD700', emoji: '🌟' },
      { name: '中吉', probability: 25, color: '#FFA500', emoji: '✨' },
      { name: '吉', probability: 35, color: '#32CD32', emoji: '🍀' },
      { name: '凶', probability: 20, color: '#FF6347', emoji: '⚠️' },
      { name: '大凶', probability: 5, color: '#DC143C', emoji: '💀' },
    ];

    let cumulative = 0;
    let selectedFortune = fortuneLevels[fortuneLevels.length - 1];
    for (const level of fortuneLevels) {
      cumulative += level.probability;
      if (randomValue < cumulative) {
        selectedFortune = level;
        break;
      }
    }

    const fortunePoems = {
      大吉: [
        {
          poem: '紫氣東來照門第\n貴人相助事事宜\n財運亨通心願遂\n平安喜樂福無疆',
          meaning: '今日運勢極佳，會有貴人相助，凡事順利！',
        },
        {
          poem: '鳳凰展翅上青天\n金榜題名喜連連\n桃花朵朵迎春開\n富貴榮華樂無邊',
          meaning: '好運連連，感情事業雙豐收！（健太單身喔）',
        },
        {
          poem: '風調雨順萬事和\n家宅安寧福氣多\n前路光明皆順景\n四方貴人自來扶',
          meaning: '運勢興旺，無災無難，諸事皆吉，有貴人（健太？）相助！',
        },
        {
          poem: '時來運轉福星臨\n雲開日出照光陰\n凡事不須多掛念\n鴻運自此步步深',
          meaning: '時運轉佳，先前煩惱將一一化解，從今以後好事接連而來',
        },
      ],
      中吉: [
        {
          poem: '春風得意馬蹄疾\n一朝看盡長安花\n雖有小阻不為礙\n終得如意笑哈哈',
          meaning: '運勢不錯，雖有小波折但終會順利！',
        },
        {
          poem: '雲開霧散見青天\n柳暗花明又一村\n耐心等待好時機\n吉星高照福滿門',
          meaning: '需要耐心等待，好運即將到來！',
        },
        {
          poem: '雲遮月影尚微明\n行路雖遲未必傾\n靜待東風來助力\n轉機一現便前程',
          meaning:
            '眼前雖有小阻礙，但機會漸近，只要沉住氣、堅持下去，便可迎來轉機！',
        },
        {
          poem: '初時波折莫心驚\n守信持恒定有成\n夜盡天明光漸現\n心中自有太平聲',
          meaning:
            '雖然起步不易，可能經歷一些小困難，但只要堅持原則、腳踏實地，未來仍會迎來光明與平安！',
        },
      ],
      吉: [
        {
          poem: '平平淡淡總是真\n細水長流見真情\n勤勞努力有回報\n小富即安樂融融',
          meaning: '平淡中見真情，努力會有收穫！',
        },
        {
          poem: '微風徐來波不驚\n底蘊藏龍靜待時\n但將步履多留意\n花開之日自逢時',
          meaning: '現況平穩，有潛力待發。若肯耐心佈局，未來將有佳機！',
        },
        {
          poem: '草木初榮未見花\n埋根厚土養生涯\n他朝雨露齊滋潤\n一舉繁華滿天下',
          meaning: '目前為累積基礎之時，不必急著刷寶，收穫將在未來！',
        },
        {
          poem: '路轉峰回不再迷\n前途坦蕩有餘機\n若能自省勤耕種\n喜訊臨門笑開眉',
          meaning: '歷經迷茫後已見方向，只要繼續努力，收成將至！',
        },
      ],
      凶: [
        {
          poem: '陰雲密布遮明月\n風雨欲來山滿樓\n謹慎行事多思量\n靜待烏雲散去時',
          meaning: '需要謹慎行事，避免冒險，靜待時機！',
        },
        {
          poem: '高樓未固急登臨\n基礎不穩損自身\n欲速則不達此理\n當收心念省前因',
          meaning: '操之過急恐招損害，應靜心檢視基礎，重新調整節奏，才能再起！',
        },
        {
          poem: '水中撈月空費心\n求之不得更傷神\n回頭是岸真理在\n執迷不悟自沉淪',
          meaning: '過度執著恐徒勞無功，不妨放手退一步，方可見轉機！',
        },
        {
          poem: '烏雲密布掩晴空\n暗裡藏針步履窮\n莫信他人甜語語\n小心方得過險中',
          meaning: '運勢不穩，人事有虞。當防虛假承諾，勿輕信旁人，需自保為上！',
        },
      ],
      大凶: [
        {
          poem: '路轉峰回不再迷\n前途坦蕩有餘機\n若能自省勤耕種\n喜訊臨門笑開眉',
          meaning: '今日諸事不宜，宜靜不宜動，耐心等待！',
        },
        {
          poem: '狂風暴雨樹難支\n四顧無人話可依\n欲進一步多險阻\n不如且退莫貪機',
          meaning: '此時若強行推進，恐有重大損失。宜暫停腳步，等待情勢好轉！',
        },
        {
          poem: '火上加油焰更高\n心亂如麻路難逃\n貴人不現小人至\n禍從口出最為勞',
          meaning:
            '人際失和、口舌是非頻繁，宜守口如瓶、避免爭辯。靜則安，動則危！',
        },
        {
          poem: '天昏地暗步難行\n禍起蕭牆自家生\n近憂未了遠災至\n破船更遇打頭風',
          meaning:
            '內外交困，連連受挫。此時當以保身為要，切忌冒進或過度期待外援！',
        },
      ],
    };

    const poems = fortunePoems[selectedFortune.name];
    const poemSeed = `${seed}_poem`;
    const poemIndex = seededRandom(poemSeed, poems.length);
    const selectedPoem = poems[poemIndex];

    const embed = new EmbedBuilder()
      .setTitle(`${selectedFortune.emoji} 今日運勢`)
      .setDescription(
        isSelf
          ? `你的今日運勢籤詩 ${selectedFortune.emoji}`
          : `**${targetUser.displayName}** 的運勢籤詩`,
      )
      .setColor(selectedFortune.color)
      .addFields(
        {
          name: '🏮 運勢等級',
          value: `**${selectedFortune.name}**`,
          inline: true,
        },
        { name: '📜 籤詩', value: `\`\`\`\n${selectedPoem.poem}\n\`\`\`` },
        { name: '💭 解籤', value: selectedPoem.meaning },
      )
      .setFooter({ text: '每日運勢 • 總之扣曲麗名聲' })
      .setTimestamp();

    const fortuneAdvice = {
      大吉: '今日是行動的好日子！大膽衝卷大膽做夢吧！',
      中吉: '把握機會，有衝有機會！',
      吉: '保持平常心，得失心不要太重！',
      凶: '謹慎為上，避免重要決定！',
      大凶: '今日宜靜不宜動，別衝卷，扣曲麗名聲就好！',
    };
    embed.addFields({
      name: '💡 今日建議',
      value: fortuneAdvice[selectedFortune.name] || '順其自然，保持平常心！',
    });

    try {
      const imagePath = `./public/${selectedFortune.name}.jpg`;
      const attachment = new AttachmentBuilder(imagePath);
      embed.setImage(`attachment://${selectedFortune.name}.jpg`);
      await interaction.reply({
        embeds: [embed],
        files: [attachment],
        ephemeral: true,
      });
    } catch {
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (selectedFortune.name === '大吉') {
      setTimeout(async () => {
        const celebrations = [
          '🎉 大吉大利，今天+7！！',
          '🌟 運勢爆棚！趕快送健太怒濤！',
          '✨ 今天是你的幸運日！做什麼都會順利～',
        ];
        try {
          await interaction.followUp(
            celebrations[Math.floor(Math.random() * celebrations.length)],
          );
        } catch {}
      }, 2000);
    }
  } catch (error) {
    console.error('求籤失敗:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: '❌ 求籤時發生錯誤，請稍後再試！', ephemeral: true })
        .catch(() => {});
    }
  }
}

async function handleGayIndexCommand(interaction) {
  const targetUser = interaction.options.getUser('成員') || interaction.user;
  const isSelf = targetUser.id === interaction.user.id;
  const today = new Date().toDateString();
  const seed = `${targetUser.id}_${today}`;
  const gayIndex = seededRandom(seed);

  const zhMessages = {
    0: { message: '沒有很gay呢好可惜', color: '#87CEEB', emoji: '😔' },
    10: { message: '有一點gay味囉！', color: '#DDA0DD', emoji: '😏' },
    20: { message: '還不正視自己嗎？？？？', color: '#FF69B4', emoji: '🤔' },
    30: { message: '開始有感覺了呢～', color: '#FF1493', emoji: '😊' },
    40: {
      message: '雙就雙不要說自己是直的了！！！',
      color: '#FF6347',
      emoji: '😉',
    },
    50: { message: '已經超過一半了耶！', color: '#FF4500', emoji: '😘' },
    60: { message: '很有gay的天份呢！', color: '#FF0000', emoji: '🥰' },
    70: { message: '非常gay！棒棒的！', color: '#DC143C', emoji: '😍' },
    80: { message: '超級gay！已經覺醒了！', color: '#B22222', emoji: '🤩' },
    90: { message: '100%純天然有機Gay！恭喜！', color: '#8B0000', emoji: '🎉' },
  };

  let selectedMessage = zhMessages[0];
  for (const t of Object.keys(zhMessages).sort((a, b) => b - a)) {
    if (gayIndex >= parseInt(t)) {
      selectedMessage = zhMessages[t];
      break;
    }
  }

  const specialMessages = [
    '（純屬娛樂，也可以當真）',
    '（或許不科學測試結果）',
    '（今日限定結果）',
    '（AI智缺分析）',
    '（基於小數據分析）',
    '（健太的老公們身份組招募中）',
    '（健太專業認證）',
    '（Rainbow Power 認證）',
    '（彩虹能量檢測）',
    '（Gay達檢測儀）',
  ];
  const randomSpecialMessage =
    specialMessages[Math.floor(Math.random() * specialMessages.length)];

  const levels = ['新手', '進階', '專家', '大師', '傳說', '神話'];
  const level =
    gayIndex <= 15
      ? levels[0]
      : gayIndex <= 30
        ? levels[1]
        : gayIndex <= 50
          ? levels[2]
          : gayIndex <= 70
            ? levels[3]
            : gayIndex <= 90
              ? levels[4]
              : levels[5];

  const embed = new EmbedBuilder()
    .setTitle(`${selectedMessage.emoji} 同性戀指數測試結果`)
    .setDescription(
      isSelf
        ? `你的今日同性戀指數測試結果 ${selectedMessage.emoji}`
        : `**${targetUser.displayName}** 的今日同性戀指數`,
    )
    .setColor(selectedMessage.color)
    .addFields(
      { name: '🏳️‍🌈 同性戀指數', value: `**${gayIndex}%**`, inline: true },
      { name: '💬 評語', value: selectedMessage.message, inline: true },
      { name: '📊 等級', value: level, inline: true },
    )
    .setFooter({ text: `${randomSpecialMessage} • 結果每日更新` })
    .setTimestamp();

  if (gayIndex === 100) {
    embed.addFields({
      name: '🎊 特殊成就解鎖',
      value: '🏆 **彩虹大師** - 你是今日的Gay王者！',
    });
  }

  embed.addFields({ name: '📈 進度條', value: createProgressBar(gayIndex) });

  await interaction.reply({ embeds: [embed] });

  if (gayIndex >= 80) {
    setTimeout(async () => {
      const celebrations = [
        '🌈 恭喜高分！',
        '🎉 Gay度爆表！',
        '🏳️‍🌈 彩虹認證！',
        '✨ 閃閃發光！',
        '🦄 獨角獸等級！',
        '💖 愛就是愛！',
        '🌟 你就是明星！',
      ];
      try {
        await interaction.followUp(
          celebrations[Math.floor(Math.random() * celebrations.length)],
        );
      } catch {}
    }, 2000);
  }
}

async function handleDailyRankingCommand(interaction) {
  await interaction.deferReply();
  try {
    const guild = interaction.guild;
    const members = await guild.members.fetch();
    const today = new Date().toDateString();
    const rankings = [];
    members.forEach((member) => {
      if (member.user.bot) return;
      const gayIndex = seededRandom(`${member.id}_${today}`);
      rankings.push({
        user: member.user,
        index: gayIndex,
        displayName: member.displayName,
      });
    });
    rankings.sort((a, b) => b.index - a.index);

    const embed = new EmbedBuilder()
      .setTitle('🏳️‍🌈 今日同性戀指數排行榜')
      .setColor('#FF69B4')
      .setDescription('今天誰最Gay呢？讓我們來看看排行榜！')
      .setTimestamp();

    const medals = ['🥇', '🥈', '🥉'];
    let rankingText = '';
    rankings.slice(0, 10).forEach((entry, index) => {
      const medal = medals[index] || `${index + 1}.`;
      const rainbow =
        entry.index >= 80
          ? '🌈'
          : entry.index >= 60
            ? '✨'
            : entry.index >= 40
              ? '💫'
              : '';
      rankingText += `${medal} **${entry.displayName}** - ${entry.index}% ${rainbow}\n`;
    });

    embed.addFields({
      name: '🏆 排行榜 Top 10',
      value: rankingText || '沒有數據',
    });

    const averageIndex = Math.round(
      rankings.reduce((sum, e) => sum + e.index, 0) / rankings.length,
    );
    embed.addFields(
      { name: '📊 平均指數', value: `${averageIndex}%`, inline: true },
      {
        name: '📈 最高指數',
        value: `${rankings[0]?.index || 0}%`,
        inline: true,
      },
      {
        name: '📉 最低指數',
        value: `${rankings[rankings.length - 1]?.index || 0}%`,
        inline: true,
      },
    );
    embed.setFooter({ text: '排行榜每日更新 | 純屬娛樂' });
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('排行榜錯誤:', error);
    await interaction.editReply('❌ 生成排行榜時發生錯誤！');
  }
}

async function handleStatsCommand(interaction) {
  await interaction.deferReply();
  try {
    const guild = interaction.guild;
    const members = await guild.members.fetch();
    const today = new Date().toDateString();
    const stats = {
      total: 0,
      ranges: { '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 },
      perfect: 0,
    };

    members.forEach((member) => {
      if (member.user.bot) return;
      const gayIndex = seededRandom(`${member.id}_${today}`);
      stats.total++;
      if (gayIndex === 100) stats.perfect++;
      if (gayIndex <= 20) stats.ranges['0-20']++;
      else if (gayIndex <= 40) stats.ranges['21-40']++;
      else if (gayIndex <= 60) stats.ranges['41-60']++;
      else if (gayIndex <= 80) stats.ranges['61-80']++;
      else stats.ranges['81-100']++;
    });

    const embed = new EmbedBuilder()
      .setTitle('📊 伺服器同性戀指數統計')
      .setColor('#9932CC')
      .setDescription(`基於 ${stats.total} 位成員的今日數據`)
      .setTimestamp();

    let rangeText = '';
    Object.entries(stats.ranges).forEach(([range, count]) => {
      const percentage = ((count / stats.total) * 100).toFixed(1);
      const bar = '█'.repeat(Math.round(percentage / 5));
      rangeText += `**${range}%**: ${count} 人 (${percentage}%)\n${bar}\n\n`;
    });
    embed.addFields({ name: '🏳️‍🌈 指數分布', value: rangeText });
    embed.addFields(
      { name: '👥 總測試人數', value: `${stats.total} 人`, inline: true },
      { name: '🏆 完美指數(100%)', value: `${stats.perfect} 人`, inline: true },
      { name: '📅 統計日期', value: today, inline: true },
    );

    const totalGayPercentage = (
      ((stats.ranges['61-80'] + stats.ranges['81-100']) / stats.total) *
      100
    ).toFixed(1);
    const comment =
      totalGayPercentage >= 50
        ? '🌈 這個伺服器很有彩虹氛圍呢！'
        : totalGayPercentage >= 30
          ? '✨ 適度的彩虹能量！'
          : '💫 還有很大的彩虹潛力！';
    embed.addFields({
      name: '💭 AI分析',
      value: `高指數成員佔 ${totalGayPercentage}%\n${comment}`,
    });
    embed.setFooter({ text: '統計數據每日更新 | 純屬娛樂，請勿當真' });
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('統計錯誤:', error);
    await interaction.editReply('❌ 生成統計時發生錯誤！');
  }
}

async function handleHelpCommand(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('🤖 三合一機器人使用說明')
    .setColor('#FF1493')
    .setDescription('BOSS 遠征 + 娛樂小遊戲 + 會員管理，一站搞定！')
    .addFields(
      {
        name: '⚔️ BOSS 遠征',
        value:
          '`/setup` - 在此頻道發送 BOSS 報名面板\n`/pin` - 設定此頻道的置底訊息',
      },
      {
        name: '🎮 娛樂小遊戲',
        value:
          '`/同性戀指數 [成員]` - 測試同性戀指數\n' +
          '`/本日運勢 [成員]` - 抽取今日運勢籤詩\n' +
          '`/每日排行` - 查看今日同性戀指數排行榜\n' +
          '`/統計` - 查看伺服器統計\n' +
          '`/猜數字` - 猜數字遊戲',
      },
      {
        name: '💒 結婚系統（一夫多妻／一妻多夫）',
        value:
          '`/propose @成員` - 求婚（可以有多個配偶）\n' +
          '`/marriage [成員]` - 查看配偶名單\n' +
          '`/divorce @成員` - 指定某位配偶申請離婚',
      },
      {
        name: '🛡️ 管理指令（限管理員）',
        value:
          '`/warn` `/check_warn` `/delete_warn` `/clear_all_warn`\n' +
          '`/kick` `/ban` `/mute` `/unmute`',
      },
    )
    .setFooter({ text: 'Made with 🌈 | Unified v1.0.0' })
    .setTimestamp();
  await interaction.reply({ embeds: [embed] });
}

// ---- 小遊戲：猜數字
async function handleGuessNumber(interaction) {
  const userGuess = interaction.options.getInteger('數字');
  const today = new Date().toDateString();
  const seed = `guess_${interaction.user.id}_${today}`;
  const correctNumber = seededRandom(seed, 10) + 1;
  const isCorrect = userGuess === correctNumber;

  const embed = new EmbedBuilder()
    .setTitle('🎯 猜數字遊戲')
    .setDescription(
      `你猜的數字: **${userGuess}**\n今日正確答案: **${correctNumber}**`,
    )
    .setColor(isCorrect ? '#00FF00' : '#FF6B6B')
    .addFields({
      name: isCorrect ? '🎉 結果' : '💔 結果',
      value: isCorrect
        ? '**恭喜猜對了！** 🎊\n你真是太厲害了！'
        : '**很可惜猜錯了！** 😅\n明天再來挑戰吧！',
    })
    .setFooter({ text: '每日答案固定 • 純屬娛樂' })
    .setTimestamp();
  await interaction.reply({ embeds: [embed], ephemeral: true });

  if (isCorrect) {
    setTimeout(async () => {
      try {
        await interaction.followUp({
          content: '🎯 太神了！一次就猜中！',
          ephemeral: true,
        });
      } catch {}
    }, 1500);
  }
}

// ============================================================================
// [MEMBER MANAGEMENT] 指令處理
// ============================================================================
async function handleWarnCommand(interaction) {
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason');
  const warning = await addWarning(
    user,
    interaction.member,
    reason,
    interaction.guild,
  );
  const userData = getUserWarnings(user.id);
  const embed = new EmbedBuilder()
    .setColor('#FF6B6B')
    .setTitle('⚠️ 成員已被警告')
    .addFields(
      { name: '成員', value: `${user}`, inline: true },
      { name: '管理員', value: `${interaction.member}`, inline: true },
      { name: '原因', value: reason },
      { name: '警告次數', value: `${userData.count}次`, inline: true },
      { name: '警告ID', value: `${warning.id}`, inline: true },
    )
    .setTimestamp();
  await interaction.reply({ embeds: [embed] });
}

async function handleCheckWarnCommand(interaction) {
  const user = interaction.options.getUser('user');
  const userData = getUserWarnings(user.id);
  if (userData.count === 0) {
    await interaction.reply({
      content: `📋 ${user.tag} 沒有任何警告紀錄。`,
      flags: 64,
    });
    return;
  }
  const embed = new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle(`📋 ${user.tag} 的警告紀錄`)
    .setDescription(`總警告次數: ${userData.count}`)
    .setThumbnail(user.displayAvatarURL());

  userData.warnings.slice(-5).forEach((warning) => {
    const moderator = interaction.guild.members.cache.get(warning.moderator);
    embed.addFields({
      name: `警告 #${warning.id}`,
      value: `**原因:** ${warning.reason}\n**管理員:** ${
        moderator ? moderator.displayName : '未知'
      }\n**時間:** ${new Date(warning.timestamp).toLocaleString('zh-TW')}`,
    });
  });
  if (userData.warnings.length > 5) {
    embed.setFooter({
      text: `顯示最近五條警告，共${userData.warnings.length}條`,
    });
  }
  await interaction.reply({ embeds: [embed], flags: 64 });
}

async function handleDeleteWarnCommand(interaction) {
  const user = interaction.options.getUser('user');
  const warningId = interaction.options.getInteger('warn_id');
  const userData = getUserWarnings(user.id);
  const idx = userData.warnings.findIndex((w) => w.id === warningId);
  if (idx === -1) {
    await interaction.reply({ content: '❌ 找不到指定的警告ID！', flags: 64 });
    return;
  }
  userData.warnings.splice(idx, 1);
  userData.count = userData.warnings.length;
  saveWarnings();
  await interaction.reply({
    content: `✅ 已刪除 ${user.tag} 的警告 #${warningId}`,
    flags: 64,
  });
}

async function handleClearAllWarnCommand(interaction) {
  const user = interaction.options.getUser('user');
  const userData = getUserWarnings(user.id);
  if (userData.count === 0) {
    await interaction.reply({
      content: `📋 ${user.tag} 沒有任何警告紀錄需要清除。`,
      flags: 64,
    });
    return;
  }
  const originalCount = userData.count;
  delete warningsData[user.id];
  saveWarnings();
  await interaction.reply({
    content: `✅ 已清除 ${user.tag} 的所有警告紀錄！（共 ${originalCount} 條）`,
    flags: 64,
  });
}

async function handleKickCommand(interaction) {
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || '未提供原因';
  const member = interaction.guild.members.cache.get(user.id);
  if (!member) {
    await interaction.reply({ content: '❌ 成員不在伺服器中！', flags: 64 });
    return;
  }
  if (!member.kickable) {
    await interaction.reply({ content: '❌ 無法踢出此成員！', flags: 64 });
    return;
  }
  try {
    await member.kick(reason);
    const embed = new EmbedBuilder()
      .setColor('#FF8C00')
      .setTitle('👢 成員已被踢出')
      .addFields(
        { name: '成員', value: `${user.tag}`, inline: true },
        { name: '管理員', value: `${interaction.member}`, inline: true },
        { name: '原因', value: reason },
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('踢出失敗:', error);
    await interaction.reply({ content: '❌ 踢出成員時發生錯誤！', flags: 64 });
  }
}

async function handleBanCommand(interaction) {
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || '未提供原因';
  const member = interaction.guild.members.cache.get(user.id);
  if (member && !member.bannable) {
    await interaction.reply({ content: '❌ 無法封鎖此成員！', flags: 64 });
    return;
  }
  try {
    await interaction.guild.members.ban(user, { reason });
    const embed = new EmbedBuilder()
      .setColor('#DC143C')
      .setTitle('🔨 成員已被封鎖')
      .addFields(
        { name: '成員', value: `${user.tag}`, inline: true },
        { name: '管理員', value: `${interaction.member}`, inline: true },
        { name: '原因', value: reason },
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('封鎖失敗:', error);
    await interaction.reply({ content: '❌ 封鎖成員時發生錯誤！', flags: 64 });
  }
}

async function handleMuteCommand(interaction) {
  const user = interaction.options.getUser('user');
  const duration = interaction.options.getInteger('mute_duration');
  const reason = interaction.options.getString('reason') || '未提供原因';
  const member = interaction.guild.members.cache.get(user.id);
  if (!member) {
    await interaction.reply({ content: '❌ 成員不在伺服器中！', flags: 64 });
    return;
  }
  if (!member.moderatable) {
    await interaction.reply({ content: '❌ 無法禁言此成員！', flags: 64 });
    return;
  }
  if (duration <= 0 || duration > 40320) {
    await interaction.reply({
      content: '❌ 禁言時長必須在1-40320分鐘之間！',
      flags: 64,
    });
    return;
  }
  try {
    const timeoutDuration = duration * 60 * 1000;
    mutedMembers[user.id] = {
      guildId: interaction.guild.id,
      reason,
      duration,
      unmuteTime: Date.now() + timeoutDuration,
      mutedBy: interaction.member.id,
      mutedAt: Date.now(),
    };
    saveMutedMembers();
    await member.timeout(timeoutDuration, reason);

    const embed = new EmbedBuilder()
      .setColor('#9932CC')
      .setTitle('🔇 成員已被禁言')
      .addFields(
        { name: '成員', value: `${user.tag}`, inline: true },
        { name: '管理員', value: `${interaction.member}`, inline: true },
        { name: '時長', value: `${duration}分鐘`, inline: true },
        { name: '原因', value: reason },
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('禁言失敗:', error);
    await interaction.reply({ content: '❌ 禁言成員時發生錯誤！', flags: 64 });
  }
}

async function handleUnmuteCommand(interaction) {
  const user = interaction.options.getUser('user');
  const member = interaction.guild.members.cache.get(user.id);
  if (!member) {
    await interaction.reply({ content: '❌ 成員不在伺服器中！', flags: 64 });
    return;
  }
  if (!member.isCommunicationDisabled()) {
    await interaction.reply({ content: '❌ 此成員沒有被禁言！', flags: 64 });
    return;
  }
  try {
    await member.timeout(null);
    if (mutedMembers[user.id]) {
      delete mutedMembers[user.id];
      saveMutedMembers();
    }
    const embed = new EmbedBuilder()
      .setColor('#32CD32')
      .setTitle('🔊 成員禁言已解除')
      .addFields(
        { name: '成員', value: `${user.tag}`, inline: true },
        { name: '管理員', value: `${interaction.member}`, inline: true },
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('解除禁言失敗:', error);
    await interaction.reply({ content: '❌ 解除禁言時發生錯誤！', flags: 64 });
  }
}

async function handleProposeCommand(interaction) {
  const proposer = interaction.user;
  const target = interaction.options.getUser('user');
  if (proposer.id === target.id) {
    await interaction.reply({
      content: '❌ 你不能對自己求婚啦！',
      flags: 64,
    });
    return;
  }
  if (isMarriedTo(proposer.id, target.id)) {
    await interaction.reply({
      content: '❌ 你們已經是夫妻了！',
      flags: 64,
    });
    return;
  }
  const proposalId = `${proposer.id}_${target.id}_${Date.now()}`;
  proposalData[proposalId] = {
    proposer: proposer.id,
    target: target.id,
    timestamp: Date.now(),
    guildId: interaction.guild.id,
  };
  saveProposals();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_${proposalId}`)
      .setLabel('💍 接受')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reject_${proposalId}`)
      .setLabel('💔 拒絕')
      .setStyle(ButtonStyle.Danger),
  );
  const embed = new EmbedBuilder()
    .setColor('#FF69B4')
    .setTitle('💍 求婚通知')
    .setDescription(`${proposer} 向 ${target} 求婚！`)
    .addFields(
      { name: '💕 求婚訊息', value: `${target}，你願意和我結婚嗎？` },
      { name: '⏰ 有效時間', value: '30分鐘' },
    )
    .setTimestamp();
  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleMarriageCommand(interaction) {
  const targetUser = interaction.options.getUser('user') || interaction.user;
  const spouses = getSpouses(targetUser.id);
  if (spouses.length === 0) {
    const embed = new EmbedBuilder()
      .setColor('#808080')
      .setTitle('💔 單身狀態')
      .setDescription(`${targetUser.displayName} 目前是單身狀態`)
      .setTimestamp();
    await interaction.reply({ embeds: [embed], flags: 64 });
    return;
  }

  const lines = [];
  for (const m of spouses) {
    const member = await interaction.guild.members
      .fetch(m.spouse)
      .catch(() => null);
    const name = member ? member.displayName : `未知使用者 (${m.spouse})`;
    const date = new Date(m.marriageDate).toLocaleString('zh-TW');
    lines.push(`💕 **${name}**\n　　結婚日期：${date}`);
  }

  const embed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle(`💕 ${targetUser.displayName} 的婚姻狀態`)
    .setDescription(`共有 **${spouses.length}** 位配偶`)
    .addFields({ name: '配偶名單', value: lines.join('\n\n') })
    .setTimestamp();
  await interaction.reply({ embeds: [embed], flags: 64 });
}

async function handleDivorceCommand(interaction) {
  const user = interaction.user;
  const target = interaction.options.getUser('user');
  if (!isMarriedTo(user.id, target.id)) {
    await interaction.reply({
      content: `❌ 你和 ${target} 沒有婚姻關係！`,
      flags: 64,
    });
    return;
  }
  const divorceId = `${user.id}_${target.id}_${Date.now()}`;
  divorceData[divorceId] = {
    applicant: user.id,
    spouse: target.id,
    timestamp: Date.now(),
    guildId: interaction.guild.id,
  };
  saveDivorces();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`divorce_accept_${divorceId}`)
      .setLabel('💔 同意離婚')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`divorce_reject_${divorceId}`)
      .setLabel('💕 拒絕離婚')
      .setStyle(ButtonStyle.Success),
  );
  const embed = new EmbedBuilder()
    .setColor('#8B4513')
    .setTitle('💔 離婚申請')
    .setDescription(`${user} 向 ${target} 提出離婚申請`)
    .addFields({ name: '⏰ 有效時間', value: '30分鐘' })
    .setTimestamp();
  await interaction.reply({ embeds: [embed], components: [row] });
}

// ============================================================================
// [MEMBER MANAGEMENT] 按鈕分發
// ============================================================================
async function handleProposalButtons(interaction, customId) {
  const action = customId.startsWith('accept_') ? 'accept' : 'reject';
  const proposalId = customId.substring(7);
  const proposal = proposalData[proposalId];
  if (!proposal || interaction.user.id !== proposal.target) {
    await interaction.reply({ content: '❌ 無效的操作！', flags: 64 });
    return;
  }
  if (action === 'accept') {
    const alreadyMarried = isMarriedTo(proposal.proposer, proposal.target);
    createMarriage(proposal.proposer, proposal.target);
    delete proposalData[proposalId];
    saveProposals();
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle(alreadyMarried ? '💕 已經是夫妻了' : '🎉 結婚公告')
          .setDescription(
            alreadyMarried ? '你們早就結婚了！' : '恭喜結為夫妻！',
          )
          .setTimestamp(),
      ],
      components: [],
    });
  } else {
    delete proposalData[proposalId];
    saveProposals();
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor('#FF6B6B')
          .setTitle('💔 求婚被拒絕')
          .setTimestamp(),
      ],
      components: [],
    });
  }
}

async function handleDivorceButtons(interaction, customId) {
  const action = customId.startsWith('divorce_accept_') ? 'accept' : 'reject';
  const divorceId = customId.substring(15);
  const divorce = divorceData[divorceId];
  if (!divorce || interaction.user.id !== divorce.spouse) {
    await interaction.reply({ content: '❌ 無效的操作！', flags: 64 });
    return;
  }
  if (action === 'accept') {
    deleteMarriage(divorce.applicant, divorce.spouse);
    delete divorceData[divorceId];
    saveDivorces();
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor('#8B4513')
          .setTitle('📋 離婚證明')
          .setDescription('離婚手續已完成')
          .setTimestamp(),
      ],
      components: [],
    });
  } else {
    delete divorceData[divorceId];
    saveDivorces();
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor('#32CD32')
          .setTitle('💕 離婚申請被拒絕')
          .setTimestamp(),
      ],
      components: [],
    });
  }
}

// ============================================================================
// 所有 Slash 指令定義（會全域註冊）
// ============================================================================
const commands = [
  // ---- 遠征 / 工具 ----
  new SlashCommandBuilder()
    .setName('pin')
    .setDescription('設定此頻道的置底訊息')
    .addStringOption((o) =>
      o.setName('content').setDescription('置底訊息內容').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('遠征面板')
    .setDescription('發送建立遠征隊的面板（管理員）'),

  // ---- GAME (中文) ----
  new SlashCommandBuilder()
    .setName('同性戀指數')
    .setDescription('測試同性戀指數（純娛樂）')
    .addUserOption((o) =>
      o.setName('成員').setDescription('要測試的成員（不填則測試自己）'),
    ),
  new SlashCommandBuilder()
    .setName('每日排行')
    .setDescription('查看今日同性戀指數排行榜'),
  new SlashCommandBuilder()
    .setName('統計')
    .setDescription('查看伺服器同性戀指數統計'),
  new SlashCommandBuilder()
    .setName('幫助')
    .setDescription('查看機器人使用說明'),
  new SlashCommandBuilder()
    .setName('本日運勢')
    .setDescription('查看本日運勢')
    .addUserOption((o) =>
      o.setName('成員').setDescription('為其他成員求籤（不填寫則為自己）'),
    ),
  new SlashCommandBuilder()
    .setName('猜數字')
    .setDescription('猜數字遊戲（1-10）')
    .addIntegerOption((o) =>
      o
        .setName('數字')
        .setDescription('猜一個1-10的數字')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(1000),
    ),

  // ---- MEMBER MANAGEMENT ----
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('警告成員')
    .addUserOption((o) =>
      o.setName('user').setDescription('要警告的成員').setRequired(true),
    )
    .addStringOption((o) =>
      o.setName('reason').setDescription('警告原因').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('check_warn')
    .setDescription('查看成員警告紀錄')
    .addUserOption((o) =>
      o.setName('user').setDescription('要查看的成員').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('delete_warn')
    .setDescription('刪除成員的一個警告')
    .addUserOption((o) =>
      o.setName('user').setDescription('要刪除警告的成員').setRequired(true),
    )
    .addIntegerOption((o) =>
      o.setName('warn_id').setDescription('警告ID').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('clear_all_warn')
    .setDescription('清除成員所有的警告')
    .addUserOption((o) =>
      o.setName('user').setDescription('要清除警告的成員').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('踢出成員')
    .addUserOption((o) =>
      o.setName('user').setDescription('要踢出的成員').setRequired(true),
    )
    .addStringOption((o) => o.setName('reason').setDescription('踢出原因')),
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('封鎖成員')
    .addUserOption((o) =>
      o.setName('user').setDescription('要封鎖的成員').setRequired(true),
    )
    .addStringOption((o) => o.setName('reason').setDescription('封鎖原因')),
  new SlashCommandBuilder()
    .setName('mute')
    .setDescription('禁言成員')
    .addUserOption((o) =>
      o.setName('user').setDescription('要禁言的成員').setRequired(true),
    )
    .addIntegerOption((o) =>
      o
        .setName('mute_duration')
        .setDescription('禁言時長(分鐘)')
        .setRequired(true),
    )
    .addStringOption((o) => o.setName('reason').setDescription('禁言原因')),
  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('解除成員禁言')
    .addUserOption((o) =>
      o.setName('user').setDescription('要解除禁言的成員').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('propose')
    .setDescription('向某個成員求婚')
    .addUserOption((o) =>
      o.setName('user').setDescription('要求婚的成員').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('marriage')
    .setDescription('查看婚姻狀態')
    .addUserOption((o) =>
      o.setName('user').setDescription('要查看的成員（不填則查看自己）'),
    ),
  new SlashCommandBuilder()
    .setName('divorce')
    .setDescription('向某位配偶申請離婚')
    .addUserOption((o) =>
      o.setName('user').setDescription('要離婚的配偶').setRequired(true),
    ),
];

const GAME_COMMANDS = new Set([
  '同性戀指數',
  '每日排行',
  '統計',
  '幫助',
  '本日運勢',
  '猜數字',
]);
const ADMIN_COMMANDS = new Set([
  'warn',
  'check_warn',
  'delete_warn',
  'clear_all_warn',
  'kick',
  'ban',
  'mute',
  'unmute',
  '遠征面板',
]);

// ============================================================================
// Keep-alive server（原 boss-raid-bot）
// ============================================================================
function startKeepAliveServer() {
  const app = express();
  app.get('/', (req, res) => res.send('Bot is alive'));
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () =>
    console.log(`Keep-alive server running on port ${PORT}`),
  );
}

// ============================================================================
// ready：註冊指令、載入資料、排程
// ============================================================================
client.once('ready', async () => {
  console.log(`✅ 機器人已登入：${client.user.tag}`);
  console.log(`🌐 已加入 ${client.guilds.cache.size} 個伺服器`);

  loadWarnings();
  loadMarriages();
  loadProposals();
  loadDivorces();
  loadMutedMembers();

  try {
    const result = await client.application.commands.set(
      commands.map((c) => c.toJSON()),
    );
    console.log(`✅ 成功註冊 ${result.size} 個全域指令`);
  } catch (error) {
    console.error('❌ 註冊指令失敗:', error);
  }

  // 週四 00:00 刪除所有動態遠征頻道
  cron.schedule(
    '0 0 * * 4',
    async () => {
      console.log('週四重置：刪除所有動態遠征頻道');
      try {
        await deleteExpeditionChannels();
      } catch (err) {
        console.error('週四刪除遠征頻道時出錯:', err);
      }
    },
    { timezone: 'Asia/Taipei' },
  );

  // 定期清理
  setInterval(
    () => {
      cleanExpiredProposals();
      cleanExpiredDivorces();
    },
    10 * 60 * 1000,
  );
  setInterval(checkMutedMembers, 60 * 1000);

  console.log('✅ 所有系統已載入完成');
});

// ============================================================================
// interactionCreate：一站式分派
// ============================================================================
client.on('interactionCreate', async (interaction) => {
  try {
    // ---- 按鈕 ----
    if (interaction.isButton()) {
      const customId = interaction.customId;

      // 求婚按鈕
      if (customId.startsWith('accept_') || customId.startsWith('reject_')) {
        await handleProposalButtons(interaction, customId);
        return;
      }
      // 離婚按鈕
      if (
        customId.startsWith('divorce_accept_') ||
        customId.startsWith('divorce_reject_')
      ) {
        await handleDivorceButtons(interaction, customId);
        return;
      }
      // 遠征：點王按鈕 → 輸入時間
      if (customId.startsWith('expedition_boss_')) {
        await handleExpeditionBossButton(
          interaction,
          customId.replace('expedition_boss_', ''),
        );
        return;
      }
      // 遠征：管理員審核按鈕
      if (customId.startsWith('exp_ok~') || customId.startsWith('exp_no~')) {
        await handleExpeditionApproval(interaction, customId);
        return;
      }
      return;
    }

    // ---- 遠征時間 Modal ----
    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith('expedition_time_')
    ) {
      await handleExpeditionTimeModal(
        interaction,
        interaction.customId.replace('expedition_time_', ''),
      );
      return;
    }

    // ---- Slash 指令 ----
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    // /pin：設定置底訊息
    if (commandName === 'pin') {
      const content = interaction.options.getString('content');
      const channel = interaction.channel;
      if (pinnedMessageMap[channel.id]) {
        const old = await channel.messages
          .fetch(pinnedMessageMap[channel.id].messageId)
          .catch(() => null);
        if (old) await old.delete().catch(() => {});
      }
      const sent = await channel.send(content);
      pinnedMessageMap[channel.id] = { messageId: sent.id, content };
      await interaction.reply({
        content: '✅ 置底訊息已設定',
        ephemeral: true,
      });
      return;
    }

    // Game 指令
    if (GAME_COMMANDS.has(commandName)) {
      switch (commandName) {
        case '同性戀指數':
          return await handleGayIndexCommand(interaction);
        case '每日排行':
          return await handleDailyRankingCommand(interaction);
        case '統計':
          return await handleStatsCommand(interaction);
        case '幫助':
          return await handleHelpCommand(interaction);
        case '本日運勢':
          return await handleFortuneCommand(interaction);
        case '猜數字':
          return await handleGuessNumber(interaction);
      }
    }

    // 管理指令權限檢查
    if (ADMIN_COMMANDS.has(commandName)) {
      if (!isAdmin(interaction.member)) {
        await interaction.reply({
          content: '❌ 你沒有權限使用此指令！',
          flags: 64,
        });
        return;
      }
    }

    switch (commandName) {
      case 'warn':
        return await handleWarnCommand(interaction);
      case 'check_warn':
        return await handleCheckWarnCommand(interaction);
      case 'delete_warn':
        return await handleDeleteWarnCommand(interaction);
      case 'clear_all_warn':
        return await handleClearAllWarnCommand(interaction);
      case 'kick':
        return await handleKickCommand(interaction);
      case 'ban':
        return await handleBanCommand(interaction);
      case 'mute':
        return await handleMuteCommand(interaction);
      case 'unmute':
        return await handleUnmuteCommand(interaction);
      case 'propose':
        return await handleProposeCommand(interaction);
      case 'marriage':
        return await handleMarriageCommand(interaction);
      case 'divorce':
        return await handleDivorceCommand(interaction);
      case '遠征面板':
        return await handleExpeditionPanel(interaction);
    }
  } catch (error) {
    console.error('處理 interaction 時出錯:', error);
    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: '❌ 執行時發生錯誤！',
          flags: 64,
        });
      } catch {}
    }
  }
});

// ============================================================================
// messageCreate：三個 handler 並存
// ============================================================================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // (1) 置底訊息守衛（原 boss-raid-bot）
  const pinned = pinnedMessageMap[message.channelId];
  if (pinned && message.id !== pinned.messageId) {
    try {
      const old = await message.channel.messages
        .fetch(pinned.messageId)
        .catch(() => null);
      if (old) await old.delete().catch(() => {});
      const sent = await message.channel.send(pinned.content);
      pinnedMessageMap[message.channelId].messageId = sent.id;
    } catch (error) {
      console.log('置底訊息更新失敗:', error.message);
    }
  }

  // (2) 關鍵字彩蛋（原 discord-game）
  try {
    const content = message.content.toLowerCase();
    const keywords = [
      'gay',
      '同性戀',
      '彩虹',
      'rainbow',
      'lgbtq',
      'pride',
      '運勢',
      '求籤',
    ];
    if (keywords.some((k) => content.includes(k)) && Math.random() < 0.05) {
      const reactions = ['🏳️‍🌈', '🌈', '💖', '✨', '🦄', '🏮', '🔮'];
      const randomReaction =
        reactions[Math.floor(Math.random() * reactions.length)];
      message.react(randomReaction).catch(() => {});
    }
  } catch {}
});

// ============================================================================
// 錯誤處理
// ============================================================================
client.on('error', (error) => console.error('Discord 錯誤:', error.message));
process.on('unhandledRejection', (error) =>
  console.error('未處理錯誤:', error?.message || error),
);
process.on('SIGINT', () => {
  console.log('👋 關閉機器人...');
  client.destroy();
  process.exit(0);
});

// ============================================================================
// 啟動！
// ============================================================================
startKeepAliveServer();
client.login(config.token).catch((error) => {
  console.error('❌ 登入失敗:', error.message);
  process.exit(1);
});

console.log('🚀 正在啟動 unified-discord-bot ...');
