#!/usr/bin/env node
// bot-profile.mjs — 给每个 IM 机器人配「唤醒词 / 人设 / 音色」，加新机器人只跑一条命令。
//
// 每个 bot 的配置目录（缺失就走全局默认，行为与以前完全一致）：
//   <DSH_HOME>\integrations\dsh-im\bots\<botId>\bot.json    名字 + 别名（唤醒词）+ 备注
//   <DSH_HOME>\integrations\dsh-im\bots\<botId>\persona.md  这个人设（从 personas\ 复制）
//   <DSH_HOME>\integrations\dsh-im\bots\<botId>\voice.json  这个音色（结构同全局 voice.json）
//
// 用法：
//   node bot-profile.mjs list
//   node bot-profile.mjs show <botId>
//   node bot-profile.mjs init <botId> --name 椎名 --aliases 椎名,希罗,二阶堂希罗 --persona 傲娇助手 --voice gsv --character shiro
//   node bot-profile.mjs name <botId> --name 椎名 [--aliases 椎名,希罗] [--note 备注]
//   node bot-profile.mjs persona <botId> <personas 里的卡名>
//   node bot-profile.mjs voice <botId> [--provider gsv] [--character shiro] [--speed 0.9] [--pitch 15] [--steps 16] [--rate 0]
//   node bot-profile.mjs check [--gsv-characters <目录>]
//   node bot-profile.mjs remove <botId>          # 只删 bot 的覆盖配置，回落到全局人设/音色
//
// 改配置不需要重启：插件每条消息都会重新读文件。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const IM_DIR = join(DSH_HOME, 'integrations', 'dsh-im');
const BOTS_DIR = join(IM_DIR, 'bots');
const PERSONAS_DIR = join(IM_DIR, 'personas');
const GLOBAL_PERSONA = join(IM_DIR, 'persona.md');
const GLOBAL_VOICE = join(IM_DIR, 'voice.json');
const QQ_CONFIG = join(DSH_HOME, 'integrations', 'dsh-qq', 'config.json');

const PROVIDERS = ['sapi', 'onecore', 'kokoro', 'f5', 'gsv'];

function fail(message) {
  console.error(`ERROR ${message}`);
  process.exit(1);
}

function cleanBotId(botId) {
  const clean = typeof botId === 'string' ? botId.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(clean)) fail(`botId 不合法：${JSON.stringify(botId)}`);
  return clean;
}

function botDir(botId) {
  return join(BOTS_DIR, cleanBotId(botId));
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail(`参数 ${arg} 缺少值`);
      flags[key] = value;
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/** 现有 QQ 机器人（只读 config.json，不碰 secret）。 */
function listQqBots() {
  const config = readJson(QQ_CONFIG, null);
  const bots = Array.isArray(config?.bots) ? config.bots : [];
  const workspaces = readJson(join(DSH_HOME, 'integrations', 'dsh-qq', 'workspaces.json'), null);
  return bots.map((bot) => ({
    botId: bot.botId,
    appId: bot.appId,
    ownerOpenid: typeof bot.ownerUserOpenid === 'string' ? bot.ownerUserOpenid : '',
    workspace: workspaces?.workspaces?.[bot.botId] ?? null,
    hasProfile: existsSync(join(BOTS_DIR, String(bot.botId))),
  }));
}

/** 这个 bot 在 DSH 里登记的 owner openid（每个 appId 下 openid 不同，必须按 bot 取）。 */
function qqOwnerFor(botId) {
  return listQqBots().find((bot) => bot.botId === botId)?.ownerOpenid ?? '';
}

function maskOpenid(openid) {
  if (!openid) return '未登记';
  if (openid.length <= 8) return openid;
  return `${openid.slice(0, 6)}…${openid.slice(-4)}`;
}

function listPersonaCards() {
  try {
    return readdirSync(PERSONAS_DIR)
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

function describe(botId) {
  const dir = join(BOTS_DIR, botId);
  const profile = readJson(join(dir, 'bot.json'), null);
  const ownPersona = join(dir, 'persona.md');
  const ownVoice = readJson(join(dir, 'voice.json'), null);
  const globalVoice = readJson(GLOBAL_VOICE, null);
  return {
    botId,
    dir,
    profile,
    personaFile: existsSync(ownPersona) ? ownPersona : GLOBAL_PERSONA,
    ownPersona: existsSync(ownPersona),
    voice: ownVoice ?? globalVoice,
    ownVoice: ownVoice !== null,
  };
}

function cmdList() {
  const bots = listQqBots();
  if (!bots.length) {
    console.log('没有找到 QQ 机器人（integrations/dsh-qq/config.json 为空）');
    return;
  }
  console.log('QQ 机器人：');
  for (const bot of bots) {
    const info = describe(bot.botId);
    const name = info.profile?.name ? `${info.profile.name}` : '（未配置，用全局）';
    const aliases = info.profile?.aliases?.length ? ` 别名：${info.profile.aliases.join('/')}` : '';
    const voice = info.voice ? `${info.voice.provider}/${info.voice.character ?? info.voice.voice}` : '默认';
    const owner = maskOpenid(info.profile?.ownerOpenid ?? bot.ownerOpenid);
    console.log(
      `  ${bot.botId}  appId=${bot.appId}  名字=${name}${aliases}  主人=${owner}  人设=${info.ownPersona ? '私有' : '全局'}  音色=${voice}${info.ownVoice ? '（私有）' : '（全局）'}`,
    );
    console.log(`      工作区：${bot.workspace ?? '未映射'}  配置目录：${info.dir}`);
  }
  const cards = listPersonaCards();
  if (cards.length) console.log(`\n可复用的人设卡（${PERSONAS_DIR}）：${cards.join('、')}`);
}

function cmdShow(botId) {
  const info = describe(botId);
  console.log(JSON.stringify({
    botId: info.botId,
    profile: info.profile,
    personaFile: info.personaFile,
    personaIsPrivate: info.ownPersona,
    voice: info.voice,
    voiceIsPrivate: info.ownVoice,
  }, null, 2));
}

function cmdName(botId, flags) {
  const dir = botDir(botId);
  const current = readJson(join(dir, 'bot.json'), {});
  const ownerFromFlags = typeof flags.owner === 'string' ? flags.owner.trim() : undefined;
  const owner = ownerFromFlags ?? current.ownerOpenid ?? qqOwnerFor(botId);
  const next = {
    version: 1,
    name: (flags.name ?? current.name ?? '').trim().slice(0, 40),
    aliases: (flags.aliases === undefined
      ? (current.aliases ?? [])
      : flags.aliases.split(/[,，、\s]+/))
      .map((alias) => String(alias).trim().slice(0, 40))
      .filter(Boolean),
    ownerOpenid: typeof owner === 'string' ? owner.trim().slice(0, 64) : '',
    note: (flags.note ?? current.note ?? '').slice(0, 200),
  };
  if (!next.name && !next.aliases.length) fail('至少要给 --name 或 --aliases');
  writeJson(join(dir, 'bot.json'), next);
  console.log(`已写 ${join(dir, 'bot.json')}`);
  console.log(`  名字：${next.name || '（未设）'}  别名：${next.aliases.join('、') || '（未设）'}`);
  console.log(`  主人 openid：${next.ownerOpenid || '（未设置，需要 --owner 指定）'}`);
}

function cmdPersona(botId, cardName) {
  const clean = String(cardName ?? '').trim();
  if (!clean) fail('用法：node bot-profile.mjs persona <botId> <卡名>');
  const source = join(PERSONAS_DIR, `${clean}.md`);
  if (!existsSync(source)) {
    const cards = listPersonaCards();
    fail(`找不到人设卡 ${source}${cards.length ? `；现有：${cards.join('、')}` : ''}`);
  }
  const dir = botDir(botId);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'persona.md');
  writeFileSync(target, readFileSync(source, 'utf8'), 'utf8');
  console.log(`已把 personas/${clean}.md 复制为 ${target}`);
}

function cmdVoice(botId, flags) {
  const dir = botDir(botId);
  const ownPath = join(dir, 'voice.json');
  const current = readJson(ownPath, null) ?? readJson(GLOBAL_VOICE, null) ?? {};
  const provider = flags.provider ?? current.provider ?? 'kokoro';
  if (!PROVIDERS.includes(provider)) fail(`provider 必须是 ${PROVIDERS.join('/')}`);
  const next = {
    version: 1,
    provider,
    voice: (flags.voice ?? current.voice ?? provider).toString().trim(),
    character: (flags.character ?? current.character ?? 'default').toString().trim().slice(0, 60),
    endpoint: (flags.endpoint ?? current.endpoint ?? '').toString().trim(),
    steps: Number(flags.steps ?? current.steps ?? 16),
    speed: Number(flags.speed ?? current.speed ?? 1),
    pitch: Number(flags.pitch ?? current.pitch ?? 0),
    rate: Number(flags.rate ?? current.rate ?? 0),
  };
  writeJson(ownPath, next);
  console.log(`已写 ${ownPath}`);
  console.log(`  provider=${next.provider} character=${next.character} speed=${next.speed} pitch=${next.pitch} steps=${next.steps}${next.endpoint ? ` endpoint=${next.endpoint}` : ''}`);
  if (provider === 'gsv') {
    const charactersDir = process.env.GSV_CHARACTERS ?? join('D:\\tools', 'gpt-sovits', 'characters');
    const wav = join(charactersDir, `${next.character}.wav`);
    const txt = join(charactersDir, `${next.character}.txt`);
    if (!existsSync(wav)) {
      console.warn(`  注意：${wav} 不存在——GSV 会回落到默认音色（${join(charactersDir, 'dafeiyu.wav')}）。`);
      console.warn('        补上 <character>.wav（5~10 秒干净人声）+ <character>.txt（对应文本）即可，无需重训。');
    } else if (!existsSync(txt)) {
      console.warn(`  注意：${txt} 不存在——零样本需要参考音对应的文本，缺了会明显跑调。`);
    }
  }
}

function cmdInit(botId, flags) {
  if (!flags.name && !flags.aliases) {
    fail('用法：node bot-profile.mjs init <botId> --name 名字 [--aliases 别名1,别名2] [--persona 卡名] [--voice gsv] [--character 角色]');
  }
  cmdName(botId, flags);
  if (flags.persona) cmdPersona(botId, flags.persona);
  if (flags.voice || flags.character) cmdVoice(botId, flags);
  console.log('\n完成。插件下一条消息就会用上新配置（不需要重启）。');
}

function cmdRemove(botId) {
  const dir = join(BOTS_DIR, cleanBotId(botId));
  if (!existsSync(dir)) {
    console.log(`没有 ${dir}，无需删除`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`已删除 ${dir}；该机器人回落到全局人设 + 全局音色。`);
}

function cmdCheck(flags) {
  const charactersDir = flags['gsv-characters'] ?? process.env.GSV_CHARACTERS ?? join('D:\\tools', 'gpt-sovits', 'characters');
  const problems = [];
  const bots = listQqBots();
  for (const bot of bots) {
    const info = describe(bot.botId);
    const label = `${bot.botId}${info.profile?.name ? `（${info.profile.name}）` : ''}`;
    if (info.ownPersona === false && !existsSync(GLOBAL_PERSONA)) problems.push(`${label}：既没有私有 persona.md，也没有全局 persona.md`);
    const provider = info.voice?.provider;
    if (provider === 'gsv') {
      const character = info.voice?.character;
      const wav = join(charactersDir, `${character}.wav`);
      const txt = join(charactersDir, `${character}.txt`);
      if (!existsSync(wav)) problems.push(`${label}：gsv 音色 ${character} 缺参考音 ${wav}（会回落到 dafeiyu）`);
      else if (!existsSync(txt)) problems.push(`${label}：gsv 音色 ${character} 缺参考文本 ${txt}`);
    }
    if (info.profile && !info.profile.name && !info.profile.aliases?.length) problems.push(`${label}：bot.json 没有名字也没有别名`);
    const registeredOwner = qqOwnerFor(bot.botId);
    if (info.profile && !info.profile.ownerOpenid && registeredOwner && registeredOwner !== '*') {
      problems.push(`${label}：bot.json 缺 ownerOpenid，提示词层认不出主人（可用 --owner 补，或跑 name 命令自动带出）`);
    }
  }
  if (problems.length) {
    for (const problem of problems) console.log(`WARN  ${problem}`);
    process.exit(1);
  }
  console.log(`OK    ${bots.length} 个机器人的人设/唤醒词/音色解析都正常`);
}

const [command, ...rest] = process.argv.slice(2);
const { flags, positional } = parseFlags(rest);
const [first] = positional;

try {
  switch (command) {
    case 'list': cmdList(); break;
    case 'show': if (!first) fail('用法：node bot-profile.mjs show <botId>'); cmdShow(first); break;
    case 'init': if (!first) fail('用法：node bot-profile.mjs init <botId> --name 名字 ...'); cmdInit(first, flags); break;
    case 'name': if (!first) fail('用法：node bot-profile.mjs name <botId> --name 名字'); cmdName(first, flags); break;
    case 'persona': cmdPersona(first, positional[1]); break;
    case 'voice': if (!first) fail('用法：node bot-profile.mjs voice <botId> --provider gsv --character xxx'); cmdVoice(first, flags); break;
    case 'check': cmdCheck(flags); break;
    case 'remove': if (!first) fail('用法：node bot-profile.mjs remove <botId>'); cmdRemove(first); break;
    default:
      console.log('用法：node bot-profile.mjs <list|show|init|name|persona|voice|check|remove> ...');
      console.log('  list                              现有 QQ 机器人 + 各自人设/音色来源');
      console.log('  init <botId> --name 椎名 --aliases 椎名,希罗 --persona 傲娇助手 --voice gsv --character shiro');
      console.log('  persona <botId> <卡名>             换人设（从 integrations/dsh-im/personas）');
      console.log('  voice <botId> --provider gsv --character shiro');
      console.log('  check                             检查每个机器人的配置是否齐全（含 GSV 参考音）');
      console.log('  remove <botId>                    删除私有配置，回落到全局');
      process.exit(command ? 2 : 0);
  }
} catch (error) {
  fail(error?.message ?? String(error));
}
