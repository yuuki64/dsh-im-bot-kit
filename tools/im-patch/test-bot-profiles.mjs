// test-bot-profiles.mjs — 按 bot 区分「唤醒词 / 人设 / 音色」的离线回归测试。
//
// 用临时 DSH_HOME 跑，不碰真实配置；直接 import 已安装插件里的真实模块（不是复制实现）。
//
//   node test-bot-profiles.mjs
//   node test-bot-profiles.mjs --plugin <dsh-im 目录>   # 指定别的安装位置
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const pluginIndex = argv.indexOf('--plugin');
const pluginRoot = pluginIndex >= 0
  ? resolve(argv[pluginIndex + 1])
  : join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@xmanrui', 'dsh-im');

const tempHome = mkdtempSync(join(tmpdir(), 'dsh-bot-profiles-'));
process.env.DSH_HOME = tempHome;

const botA = 'qq_aaaaaa111111111111111111';
const botB = 'qq_bbbbbb222222222222222222';

const imDir = join(tempHome, 'integrations', 'dsh-im');
mkdirSync(join(imDir, 'personas'), { recursive: true });
mkdirSync(join(imDir, 'bots', botB), { recursive: true });
writeFileSync(join(imDir, 'persona.md'), '# 全局人设\n全局默认角色\n', 'utf8');
writeFileSync(join(imDir, 'personas', '椎名.md'), '# 角色卡：椎名\n冷静、简短。\n', 'utf8');
writeFileSync(join(imDir, 'voice.json'), JSON.stringify({ version: 1, provider: 'gsv', voice: 'gsv', character: 'dafeiyu', steps: 16, speed: 0.9, pitch: 15, rate: 0 }, null, 2), 'utf8');
writeFileSync(join(imDir, 'bots', botB, 'bot.json'), JSON.stringify({ version: 1, name: '椎名', aliases: ['希罗', '二阶堂希罗'], ownerOpenid: '00000000000000000000000000000006', ownerName: 'yuuki', note: '' }, null, 2), 'utf8');
writeFileSync(join(imDir, 'bots', botB, 'persona.md'), '# 角色卡：椎名\n冷静、简短。\n', 'utf8');
writeFileSync(join(imDir, 'bots', botB, 'voice.json'), JSON.stringify({ version: 1, provider: 'gsv', voice: 'gsv', character: 'shiro', steps: 16, speed: 0.95, pitch: 8, rate: 0 }, null, 2), 'utf8');

const failures = [];
function check(label, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

try {
  const personaModule = await import(pathToFileURL(join(pluginRoot, 'src', 'channels', 'shared', 'persona.mjs')).href);
  const voiceModule = await import(pathToFileURL(join(pluginRoot, 'src', 'channels', 'shared', 'voice-synth.mjs')).href);

  // --- 人设 / 唤醒词 ---
  const globalGuidance = personaModule.applyPersona('基础引导');
  check('没有 botId 时只用全局人设', globalGuidance.includes('全局默认角色') && !globalGuidance.includes('椎名'));
  check('没有 botId 时没有身份块', !globalGuidance.includes('<dsh_im_identity>'));

  const botAGuidance = personaModule.applyPersona('基础引导', { botId: botA });
  check('bot 没有私有文件时回退全局', botAGuidance.includes('全局默认角色') && !botAGuidance.includes('<dsh_im_identity>'));

  const botBGuidance = personaModule.applyPersona('基础引导', { botId: botB });
  check('bot 私有 persona 生效', botBGuidance.includes('冷静、简短。') && !botBGuidance.includes('全局默认角色'));
  check('唤醒词/别名注入身份块', botBGuidance.includes('<dsh_im_identity>')
    && botBGuidance.includes('椎名') && botBGuidance.includes('希罗') && botBGuidance.includes('二阶堂希罗'));
  check('主人称呼注入（--owner-name）', botBGuidance.includes('主人是 yuuki'));
  check('每个 bot 的主人 openid 独立注入',
    botBGuidance.includes('00000000000000000000000000000006') && !globalGuidance.includes('A318D75E'));
  check('persona 在身份块之后（人设优先级更高）',
    botBGuidance.indexOf('<dsh_im_persona>') > botBGuidance.indexOf('<dsh_im_identity>'));

  // --- 音色 ---
  const globalVoice = await voiceModule.readVoiceSettings();
  check('没有 botId 时读全局音色', globalVoice.character === 'dafeiyu' && globalVoice.speed === 0.9);
  const botBVoice = await voiceModule.readVoiceSettings({ botId: botB });
  check('bot 私有 voice.json 生效', botBVoice.character === 'shiro' && botBVoice.speed === 0.95);
  const botAVoice = await voiceModule.readVoiceSettings({ botId: botA });
  check('没有私有 voice.json 时回退全局', botAVoice.character === 'dafeiyu');

  // --- 写入隔离 ---
  await voiceModule.writeVoiceSettings({ speed: 1.4 }, { botId: botB });
  const afterBot = JSON.parse(readFileSync(join(imDir, 'bots', botB, 'voice.json'), 'utf8'));
  const afterGlobal = JSON.parse(readFileSync(join(imDir, 'voice.json'), 'utf8'));
  check('写 bot 音色只改 bot 文件', afterBot.speed === 1.4 && afterGlobal.speed === 0.9);

  await voiceModule.writeVoiceSettings({ endpoint: 'http://127.0.0.1:17864' }, { botId: botB });
  const withEndpoint = await voiceModule.readVoiceSettings({ botId: botB });
  check('bot 可指向独立的 GSV 实例', withEndpoint.endpoint === 'http://127.0.0.1:17864');
  const noEndpoint = await voiceModule.readVoiceSettings();
  check('全局音色不受 endpoint 影响', noEndpoint.endpoint === '');

  // --- 路径解析 ---
  check('personaPathFor 指向 bot 私有文件',
    personaModule.personaPathFor(botB) === join(imDir, 'bots', botB, 'persona.md'));
  check('personaPathFor 对无配置 bot 指向全局',
    personaModule.personaPathFor(botA) === join(imDir, 'persona.md'));
  check('voiceSettingsPath 指向 bot 私有文件',
    voiceModule.voiceSettingsPath(botB) === join(imDir, 'bots', botB, 'voice.json'));
  check('voiceSettingsPath 对无配置 bot 指向全局',
    voiceModule.voiceSettingsPath(botA) === join(imDir, 'voice.json'));

  // --- 非法 botId 不得越权 ---
  const evil = personaModule.applyPersona('基础', { botId: '../../evil' });
  check('非法 botId 被忽略（不越权读文件）', evil.includes('全局默认角色') && !evil.includes('<dsh_im_identity>'));
} catch (error) {
  check(`模块加载/执行：${error?.message ?? error}`, false);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('');
if (failures.length) {
  console.error(`失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('全部通过：按 bot 解析人设 / 唤醒词 / 音色，且写入互不影响');
