import React, { useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import TYPERT_REMOTE from './remote.js';

const PACKAGE = 'dsh-agent-control-center';
const ROW_ID = 'agent-control-center';

export const inject = ['remote', 'slots'];

interface DashboardClientContext extends Context {
  remote: TypertClientRemote & { agentControlCenter: { createPairingLink(): Promise<RemoteResult<string>> } };
  slots: {
    inject(name: string, callback: () => void): void;
    register(options: Record<string, unknown>, component: (props: { subject: { kind: string; pkg?: { name: string } } }) => React.ReactNode): void;
  };
}

function PairingAction({ ctx }: { ctx: DashboardClientContext }) {
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function createLink(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const result = await ctx.remote.agentControlCenter.createPairingLink();
      if (!result.ok) {
        setError(`Не удалось создать ссылку (${result.error.code}).`);
        return;
      }
      setLink(result.value);
    } catch (cause) {
      const message = cause instanceof Error ? redactRemoteErrorMessage(cause.message) : '';
      setError(message.includes('has no active Connection')
        ? 'Нет активного Client Connection. Перезагрузите Bundle.'
        : cause instanceof Error && message
          ? `Host Remote завершился ошибкой (${cause.name}): ${message}`
          : 'Host Remote завершился неизвестной ошибкой.');
    } finally {
      setBusy(false);
    }
  }

  return <section aria-label="Agent Control Center">
    <h3>Agent Control Center</h3>
    <p>Одноразовая ссылка действует 2 минуты. Она откроет read-only панель в браузере.</p>
    <button type="button" disabled={busy} onClick={() => void createLink()}>{busy ? 'Создаём ссылку…' : 'Создать ссылку для браузера'}</button>
    {link && <p><a href={link} target="_blank" rel="noreferrer">Открыть Agent Control Center</a></p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

function redactRemoteErrorMessage(message: string): string {
  return message
    .replace(/\b(token|secret|cookie|authorization)\b\s*[=:]\s*[^\s,;]+/gi, '$1=[скрыто]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [скрыто]')
    .replace(/#token=[^\s&]+/gi, '#token=[скрыто]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[скрыто]')
    .slice(0, 180);
}

export function apply(ctxValue: Context): void {
  const ctx = ctxValue as DashboardClientContext;
  let remoteDisposer: (() => void) | undefined;
  let namespaceFiber: ReturnType<Context['inject']> | undefined;
  let disposed = false;

  void ctx.remote.$mount(TYPERT_REMOTE).then(disposer => {
    remoteDisposer = disposer;
    if (disposed) {
      void disposer();
      return;
    }

    // The namespace is created by $mount, so wait for it in a child fiber instead
    // of making the Bundle itself depend on the service it is responsible for.
    namespaceFiber = ctx.inject(['remote.agentControlCenter'], remoteCtxValue => {
      const remoteCtx = remoteCtxValue as DashboardClientContext;
      remoteCtx.slots.inject('plugins.detail.section', () => remoteCtx.slots.register(
        { name: 'plugins.detail.section', id: 'agent-control-center', locale: 'agentControlCenter' },
        ({ subject }) => subject.kind === 'bundle' && subject.pkg?.name === PACKAGE
          ? <PairingAction ctx={remoteCtx} />
          : null,
      ));
    });
    if (disposed) void namespaceFiber.dispose();
  });

  ctx.effect(() => async () => {
    disposed = true;
    await namespaceFiber?.dispose();
    await remoteDisposer?.();
  });
}
