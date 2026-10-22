import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerManagementRpc } from '../../../management-rpc.mjs';
import { onImHostLanguageChange } from '../../../../src/channels/shared/i18n.mjs';
import { startImSwitchServer } from '../../../../src/channels/shared/im-switch-server.mjs';
import { anyChatEnabled } from '../../../../src/channels/shared/im-switch.mjs';
import { resolveRpcAuthority } from '../../rpc-authority.mjs';
import { publicChannelInitializing, publicChannelStartupError } from './startup-error.mjs';
import { createConnectionDiagnostics, diagnosticRpcResult } from '../../../../src/channels/shared/connection-error.mjs';

/**
 * Keep a channel's platform-side command menu in the current host message
 * language. Menus are registered with the platform when a bot connects, so a
 * later language change has to re-send them; channels that publish no menu
 * expose no refresh hook and are left alone.
 */
function followHostLanguage(ctx, channel, controller, logger) {
  if (typeof controller?.refreshCommandMenus !== 'function') return;
  const unsubscribe = onImHostLanguageChange(() => {
    // Never run a slow or failing platform call inside the language switch:
    // subscribers are synchronous and must not delay or break one another.
    void Promise.resolve()
      .then(() => controller.refreshCommandMenus())
      .catch((error) => logger.warn?.(
        `[dsh-im] failed to re-send the ${channel} command menu after a language change`,
        error,
      ));
  });
  ctx.effect(() => unsubscribe, `dsh-im: follow the host language for ${channel} command menus`);
}


/** Marker file that pauses every IM channel without deleting any credentials. */
function imPauseMarker() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'integrations', 'dsh-im', 'paused');
}

function isImPaused() {
  try {
    readFileSync(imPauseMarker(), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Mount the native management RPC before any fallible production initialization. */
export async function installProductionChannel(ctx, config, {
  channel, rpcChannel, createProduction, createHandler, reportStartupError,
}) {
  let startupError = publicChannelInitializing(channel);
  let handler = async () => ({ ok: false, error: startupError });
  const logger = typeof ctx.logger === 'function' ? ctx.logger(`dsh-im:${channel}`) : (ctx.logger ?? console);
  const diagnostics = createConnectionDiagnostics({ channel, logger });
  // The loopback switch page (private/group toggles) is process-wide; starting
  // it from every channel mount is idempotent and must never break startup.
  try {
    startImSwitchServer({ logger });
  } catch (error) {
    logger.warn?.('[dsh-im:switch] switch page bootstrap failed:', error?.message ?? error);
  }
  const disposeRpc = registerManagementRpc(ctx, rpcChannel, async (endpoint, payload, signal) => {
    if (signal?.aborted) {
      return { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.', details: {} } };
    }
    try { return await handler(endpoint, payload, signal); }
    catch (error) {
      // Preserve a final Host diagnostic if an endpoint misses its own catch.
      return diagnosticRpcResult(diagnostics, error, { ok: false, error: { code: `${channel}-operation-failed` } }, { operation: endpoint });
    }
  }, { authority: resolveRpcAuthority(config.rpcAuthority) });
  let production;
  let unregisterDelivery;
  let closing;
  const pausedHandler = async () => ({ ok: false, error: { code: 'dsh-im-paused', message: 'IM is paused.', details: {} } });
  const closeProduction = () => (closing ??= (async () => {
    try {
      await unregisterDelivery?.();
    } finally {
      await production?.close();
      production = undefined;
      unregisterDelivery = undefined;
      handler = pausedHandler;
      closing = undefined;
    }
  })());
  const startProduction = async () => {
    if (production) return true;
    try {
      production = await createProduction();
      unregisterDelivery = config.deliveryService && production.deliveryAdapter
        ? config.deliveryService.registerAdapter(production.deliveryAdapter) : undefined;
      handler = createHandler(production.controller);
      followHostLanguage(ctx, channel, production.controller, logger);
      return true;
    } catch (error) {
      startupError = reportStartupError
        ? reportStartupError(error, false)
        : diagnostics.report(error, { operation: 'startup', stage: 'startup.load', publicError: publicChannelStartupError(channel, error) }).publicError;
      try {
        await closeProduction();
      } catch (cleanupError) {
        if (reportStartupError) reportStartupError(cleanupError, true);
        else diagnostics.report(cleanupError, { operation: 'startup', stage: 'connection.stop', warning: true });
      }
      return false;
    }
  };
  // The bot only keeps a live platform connection while at least one side of
  // the private/group switches is on; both off is a real offline state so the
  // DSH workspace indicator follows it instead of showing a connected bot.
  const shouldRun = () => !isImPaused() && anyChatEnabled();
  try {
    if (!shouldRun()) {
      handler = pausedHandler;
    } else {
      await startProduction();
    }
    ctx.effect(() => closeProduction, `dsh-im: close ${channel} connections`);
    // Poll the pause marker and the chat switches so both can be toggled
    // without restarting DSH.
    const timer = setInterval(() => {
      const active = shouldRun();
      if (!active && production) void closeProduction().catch(() => undefined);
      else if (active && !production) void startProduction().catch(() => undefined);
    }, 5000);
    timer.unref?.();
    ctx.effect(() => () => clearInterval(timer), `dsh-im: watch pause marker and chat switches for ${channel}`);
  } finally {
    // nothing left to clean here: ctx.effect owns shutdown
  }
  return disposeRpc;
}
