// QQ markdown 回复投递：长文尽量按结构边界切分，以 msg_type=2 发送，
// 平台拒绝 markdown 时逐条回退纯文本。
//
// 本地补丁（2026-10-24）：新增 `segments` / `segmentGap` 选项，让聊天型回复
// 可以按「一条一条」发出去（条间随机间隔）。分段由 qq-bridge 的 chat-segments
// 计算，这里只负责逐段投递，仍复用同一套 msg_seq / 被动回复上限 / 纯文本回退逻辑。

import { t } from '../shared/i18n.mjs';
import { ApiError } from '@tencent-connect/qqbot-nodejs';

import { chunkMarkdownParts } from '../shared/markdown-chunks.mjs';
export { chunkMarkdownText } from '../shared/markdown-chunks.mjs';

const MARKDOWN_REJECTION_CODES = new Set([40_034_090]);
const PASSIVE_REPLY_LIMIT = Object.freeze({ c2c: 4, group: 5 });
const PARTIAL_REPLY_NOTICE = () => t('回答较长，后续内容未能通过 QQ 完整发送，请回复“继续”。');

function nextMsgSeq() {
  // 与 SDK getNextMsgSeq 相同的 16-bit 随机 seed；同批分片在 seed 上递增，
  // 保证同一个被动回复 msg_id 内不发生随机碰撞。
  const timePart = Date.now() % 100_000_000;
  const random = Math.floor(Math.random() * 65_536);
  return (timePart ^ random) % 65_536;
}

function isMarkdownRejection(error) {
  return error instanceof ApiError
    && error.httpStatus >= 400
    && error.httpStatus < 500
    && MARKDOWN_REJECTION_CODES.has(Number(error.bizCode));
}

function sendPlainText(bot, target, content, msgSeq) {
  if (typeof bot?.send === 'function') {
    return bot.send({
      target,
      msgType: 0,
      content,
      extra: { msg_seq: msgSeq },
    });
  }
  return bot.sendText(target, content);
}

/** Random pause between chat segments; abortable so shutdown is not delayed. */
export function waitBetweenSegments(gap, signal) {
  const min = Math.max(0, Number(gap?.minMs) || 0);
  const max = Math.max(min, Number(gap?.maxMs) || min);
  const delay = min + Math.floor(Math.random() * (max - min + 1));
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (fn, value) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const timer = setTimeout(() => done(resolve), delay);
    timer.unref?.();
    const onAbort = () => done(reject, signal?.reason ?? new Error('aborted'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * 以 markdown（msg_type=2）发送回复；单条被平台拒绝时回退纯文本（msg_type=0）。
 * 返回每条消息的平台响应，供调用方提取 provider message ids。
 *
 * @param {object} [options]
 * @param {string[]|null} [options.segments]  预先切好的聊天分条（每条一条消息）
 * @param {{minMs:number,maxMs:number}|null} [options.segmentGap]  条间随机间隔
 */
export async function sendMarkdownReply(bot, target, text, {
  logger,
  signal,
  requireComplete = false,
  segments = null,
  segmentGap = null,
} = {}) {
  const chunks = Array.isArray(segments) && segments.length > 0
    ? segments.filter((segment) => typeof segment === 'string' && segment.trim())
      .map((segment) => ({ markdown: segment, plain: segment }))
    : chunkMarkdownParts(text);
  const results = [];
  const firstMsgSeq = nextMsgSeq();
  const passiveLimit = target?.msgId ? PASSIVE_REPLY_LIMIT[target.scope] : null;
  const overflow = passiveLimit !== null && chunks.length > passiveLimit;
  const passiveContentCount = overflow ? passiveLimit - 1 : chunks.length;
  const proactiveTarget = target?.msgId
    ? { scope: target.scope, targetId: target.targetId }
    : target;
  let partialNoticeSent = false;

  const sendPartialNotice = async () => {
    if (partialNoticeSent || !target?.msgId) return;
    partialNoticeSent = true;
    try {
      results.push(await sendPlainText(
        bot,
        target,
        PARTIAL_REPLY_NOTICE(),
        (firstMsgSeq + chunks.length) & 0xFFFF,
      ));
    } catch (error) {
      logger?.warn?.('[dsh-im:qq] unable to send partial reply notice:', error);
    }
  };

  for (const [index, chunk] of chunks.entries()) {
    signal?.throwIfAborted();
    if (index > 0 && segmentGap) await waitBetweenSegments(segmentGap, signal);
    const msgSeq = (firstMsgSeq + index) & 0xFFFF;
    const deliveryTarget = overflow && index >= passiveContentCount
      ? proactiveTarget
      : target;
    if (typeof bot?.send === 'function') {
      try {
        results.push(await bot.send({
          target: deliveryTarget,
          msgType: 2,
          markdown: { content: chunk.markdown },
          extra: { msg_seq: msgSeq },
        }));
        continue;
      } catch (error) {
        if (!isMarkdownRejection(error)) {
          logger?.warn?.(
            '[dsh-im:qq] markdown delivery outcome is uncertain; refusing a duplicate-prone retry:',
            error,
          );
          if (requireComplete || results.length === 0) throw error;
          await sendPartialNotice();
          break;
        }
        logger?.warn?.('[dsh-im:qq] markdown delivery failed; retrying as plain text:', error);
      }
    }
    // Synthetic Markdown can represent an empty fenced-code body even though
    // its plain equivalent is empty. Never turn that into an invalid QQ text
    // message after a definite Markdown rejection (or on legacy text clients).
    if (chunk.plain.length === 0) continue;
    try {
      results.push(await sendPlainText(bot, deliveryTarget, chunk.plain, msgSeq));
    } catch (error) {
      if (requireComplete || results.length === 0) throw error;
      await sendPartialNotice();
      break;
    }
  }
  return results;
}
