import { withSessionBindingLock } from './session-binding-lock.mjs';
import { initialSessionTitle } from './session-title.mjs';
import { messageDiagnosticError } from './connection-error.mjs';
import { readGroupReasoningOverride } from './group-reasoning.mjs';
import { readBehaviorConfig } from './behavior-config.mjs';

export const WORKSPACE_SESSION_STALE = 'workspace-session-stale';

// 本地补丁（2026-10-26）：按渠道（私聊/群聊）应用模型/思考强度。
// null/缺省 = 继承 bot 设置面板；只有配置了才覆盖。签名变化时重新应用。
const channelModelApplied = new Map();

/**
 * Best-effort：把会话切到该渠道配置的模型/思考强度。
 * - behavior.json → channelModels.direct / .group 里显式配了才覆盖；
 * - 群聊另外尊重主人用 /effort 设过的上限（没设过就继承面板值）；
 * - 不抛错，不认识的强度会跳过。
 * @returns {Promise<'applied'|'already'|'unsupported'|'failed'|'skipped'>}
 */
export async function ensureReasoningDefault(session, sessionId, conversationKey, options) {
  if (!sessionId) return 'skipped';
  if (typeof session?.models !== 'function' || typeof session?.selectModel !== 'function') return 'skipped';
  const isGroup = typeof conversationKey === 'string' && conversationKey.startsWith('group:');
  const channel = isGroup ? 'group' : 'direct';
  let config = {};
  try {
    config = readBehaviorConfig().channelModels?.[channel] ?? {};
  } catch {
    config = {};
  }
  let effort = typeof config.reasoningEffort === 'string' && config.reasoningEffort
    ? config.reasoningEffort
    : null;
  if (!effort && isGroup) {
    effort = await readGroupReasoningOverride().catch(() => null);
  }
  const modelOverride = config.model && typeof config.model === 'object'
    && typeof config.model.provider === 'string' && typeof config.model.model === 'string'
    ? { provider: config.model.provider, model: config.model.model }
    : null;
  const signature = JSON.stringify({ channel, effort, model: modelOverride });
  if (channelModelApplied.get(sessionId) === signature) return 'already';
  if (!effort && !modelOverride) {
    // 继承 bot 面板设置：不主动改，避免把面板里的值又压下去。
    channelModelApplied.set(sessionId, signature);
    return 'skipped';
  }
  const callOptions = options ?? {};
  try {
    const catalog = await session.models(callOptions);
    const current = catalog?.current;
    if (!current?.provider || !current?.model) return 'failed';
    const desiredProvider = modelOverride?.provider ?? current.provider;
    const desiredModel = modelOverride?.model ?? current.model;
    const entry = (catalog?.groups ?? [])
      .find((group) => group?.id === desiredProvider)
      ?.models?.find((model) => model?.id === desiredModel);
    if (!entry) return 'unsupported';
    const supportedEfforts = entry?.reasoning?.efforts ?? [];
    if (effort && !supportedEfforts.some((item) => item?.id === effort)) return 'unsupported';
    if (current.provider === desiredProvider && current.model === desiredModel
      && (effort === null || current.reasoningEffort === effort)) {
      channelModelApplied.set(sessionId, signature);
      return 'already';
    }
    const selected = await session.selectModel({
      provider: desiredProvider,
      model: desiredModel,
      ...(effort ? { reasoningEffort: effort } : {}),
    }, callOptions);
    channelModelApplied.set(sessionId, signature);
    return selected?.selected ? 'applied' : 'failed';
  } catch (error) {
    console.warn('[dsh-im] unable to apply the channel model setting:', error?.message ?? error);
    return 'failed';
  }
}

function workspaceSessionStaleError() {
  const error = new Error('The conversation workspace changed before the prompt was sent.');
  error.code = WORKSPACE_SESSION_STALE;
  return error;
}

/**
 * Read the conversation's effective-workspace generation. A bot-scoped Harness
 * exposes it; anything else (plain fixtures, older Harnesses) yields null and
 * disables the conversation-level fence without changing existing behavior.
 */
function readConversationGeneration(harness, conversationKey) {
  return typeof harness?.conversationWorkspaceGeneration === 'function'
    ? harness.conversationWorkspaceGeneration(conversationKey) ?? null
    : null;
}

function conversationGenerationMoved(harness, conversationKey, generation) {
  if (generation === null) return false;
  return readConversationGeneration(harness, conversationKey) !== generation;
}

/**
 * Wait for a conversation-level workspace switch that is still committing.
 * An explicit /conv publishes its fence before it persists, so a message that
 * is already in flight must settle on the new workspace instead of resolving a
 * session in the one being left behind.
 */
async function awaitPendingConversationSwitch(harness, conversationKey) {
  if (typeof harness?.pendingConversationWorkspaceSwitch !== 'function') return;
  const pending = harness.pendingConversationWorkspaceSwitch(conversationKey);
  if (pending && typeof pending.then === 'function') await pending.catch(() => undefined);
}

function workspaceSession(harness, sessionId, conversationKey) {
  if (typeof harness.workspaceSession === 'function') {
    return conversationKey
      ? harness.workspaceSession(sessionId, conversationKey)
      : harness.workspaceSession(sessionId);
  }
  const session = {
    sessionId,
    sessionExists: (...args) => harness.sessionExists(sessionId, ...args),
    models: (...args) => harness.getSessionModels(sessionId, ...args),
    selectModel: (...args) => harness.selectSessionModel(sessionId, ...args),
    isRunning: (...args) => harness.isSessionRunning(sessionId, ...args),
    hasActiveTurn: (...args) => harness.hasActiveTurn(sessionId, ...args),
    stopActiveTurn: (...args) => harness.stopActiveTurn(sessionId, ...args),
    stopDeferredTurn: (...args) => harness.stopDeferredTurn?.(sessionId, ...args) ?? false,
    steerActiveTurn: (...args) => harness.steerActiveTurn(sessionId, ...args),
    ask: (...args) => harness.ask(sessionId, ...args),
  };
  if (typeof harness.renameSession === 'function') {
    session.renameTitle = (...args) => harness.renameSession(sessionId, ...args);
  }
  return Object.freeze(session);
}

async function sessionExists(session, options) {
  return options === undefined
    ? session.sessionExists()
    : session.sessionExists(options);
}

async function createSession(harness, options) {
  return options === undefined
    ? harness.createSession()
    : harness.createSession(options);
}

/**
 * Resolve, persist, and ask through a session that belongs to the bot's
 * current workspace. A concurrent workspace switch invalidates the scoped
 * session and retries before any prompt is sent to the stale session.
 *
 * `titleText` names the conversation title when the prompt itself is not the
 * user's own words -- a batch submission composes dsh-im's framing sentence and
 * message labels into one prompt, and only the collected text may name the
 * conversation.
 *
 * `sourceGuidance` is the guidance the channel's captured enhancement settings
 * applied, carried to the Host out of band so it can materialize it as session
 * prompt context. It is never re-derived from the prompt, which also carries
 * whatever the user typed.
 */
export async function askInWorkspaceSession({
  harness,
  state,
  key,
  text,
  content,
  prepareContent,
  titleText,
  sourceGuidance,
  contextEnhanced = false,
  createOptions,
  existsOptions,
  askOptions,
  deferredDelivery,
}) {
  const initialTitle = contextEnhanced
    ? initialSessionTitle({
        text: titleText ?? text,
        content,
        files: typeof askOptions === 'object' ? askOptions?.files : undefined,
      })
    : null;
  const renameSignal = createOptions?.signal
    ?? (typeof askOptions === 'object' ? askOptions?.signal : undefined);
  const renameOptions = renameSignal ? { signal: renameSignal } : undefined;
  while (true) {
    const diagnostic = { stage: 'session.prepare', submissionState: 'not-submitted' };
    try {
      const binding = await withSessionBindingLock(state, key, async () => {
        await awaitPendingConversationSwitch(harness, key);
        let sessionId = state.sessionFor(key);
        diagnostic.sessionId = sessionId;
        let session = sessionId ? workspaceSession(harness, sessionId, key) : null;
        if (!session || !(await sessionExists(session, existsOptions))) {
          sessionId = await createSession(harness, {
            conversationKey: key,
            ...(createOptions ?? {}),
          });
          diagnostic.sessionId = sessionId;
          if (await state.setSession(key, sessionId) === false) return null;
          // Binding committed: capture the conversation's effective-workspace
          // generation together with the session, so the prompt below is fenced
          // against a conversation switch that only commits after the bind.
          const conversationGeneration = readConversationGeneration(harness, key);
          session = workspaceSession(harness, sessionId, key);
          if (initialTitle && typeof session.renameTitle === 'function') {
            try {
              await session.renameTitle(initialTitle, renameOptions);
            } catch (error) {
              if (error?.code === WORKSPACE_SESSION_STALE || renameOptions?.signal?.aborted) {
                throw error;
              }
              console.warn('[dsh-im] unable to set the initial Session title:', error?.message ?? error);
            }
          }
          // A switch that committed while the title was being set has already
          // cleared the mapping and must not receive this prompt.
          if (conversationGenerationMoved(harness, key, conversationGeneration)) {
            throw workspaceSessionStaleError();
          }
          return { sessionId, session };
        }
        return { sessionId, session };
      });
      if (!binding) continue;
      diagnostic.sessionId = binding.sessionId;
      // Cheapest reasoning tier by default (owner can still change a session
      // with /reasoning); applied once per session per process.
      await ensureReasoningDefault(
        binding.session,
        binding.sessionId,
        key,
        renameSignal ? { signal: renameSignal } : undefined,
      );
      diagnostic.stage = 'prompt.prepare';
      const artifacts = [];
      const originalOnArtifact = typeof askOptions === 'object'
        && typeof askOptions?.onArtifact === 'function'
        ? askOptions.onArtifact
        : null;
      const artifactOptions = typeof askOptions === 'number'
        ? { timeoutMs: askOptions }
        : { ...askOptions };
      // The guidance the channel's captured settings applied, carried out of
      // band so the Host never has to read configuration out of the prompt.
      artifactOptions.sourceGuidance = sourceGuidance;
      artifactOptions.onArtifact = async (artifact) => {
        artifacts.push(artifact);
        await originalOnArtifact?.(artifact);
      };
      let answer;
      // Prepare session-dependent context after binding, outside the binding
      // lock. A stale-workspace retry must prepare it for the new session too.
      const prompt = prepareContent
        ? await prepareContent({ sessionId: binding.sessionId, content, text })
        : content ?? text;
      try {
        // An alternate Harness adapter may not supply finer ask() diagnostics.
        diagnostic.stage = 'operation';
        diagnostic.submissionState = 'unknown';
        answer = await binding.session.ask(prompt, artifactOptions);
      } catch (error) {
        if (error?.code === 'harness-reply-timeout' && deferredDelivery) {
          try {
            const { coordinator, ...destination } = deferredDelivery();
            await coordinator.trackTimeout(error, { ...destination, key, sessionId: binding.sessionId });
          } catch (registrationError) {
            console.warn('[dsh-im] unable to persist deferred delivery:', registrationError.message);
          }
        }
        throw error;
      }
      return {
        sessionId: binding.sessionId,
        answer,
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
    } catch (error) {
      if (error?.code !== WORKSPACE_SESSION_STALE) throw messageDiagnosticError(error, diagnostic);
    }
  }
}
