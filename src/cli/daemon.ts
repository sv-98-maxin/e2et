import { resolveSocketPath } from '../daemon/session-meta.js';
import { runDaemon } from '../daemon/daemon.js';
import type { AuthMode } from '../auth-resolve.js';
import type { BrowserMode } from '../browser/daemon-client.js';
import { EXIT_USAGE } from './context.js';

const ENV_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function runDaemonCommand(argv: string[]): Promise<number> {
  const id = argv[0];
  if (!id || id.startsWith('-')) {
    console.error('usage: e2et __daemon <session_id> --env <label> --socket <path>');
    return EXIT_USAGE;
  }
  const rest = argv.slice(1);
  let env = 'default';
  let socketPath = '';
  let authMode: AuthMode = 'auto';
  let browserMode: BrowserMode = 'auto';
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--env') { env = rest[++i]; continue; }
    if (rest[i] === '--socket') { socketPath = rest[++i]; continue; }
    if (rest[i] === '--auth') { authMode = rest[++i] as AuthMode; continue; }
    if (rest[i] === '--browser') { browserMode = rest[++i] as BrowserMode; continue; }
    if (rest[i].startsWith('--env=')) { env = rest[i].slice(5); continue; }
    if (rest[i].startsWith('--socket=')) { socketPath = rest[i].slice(9); continue; }
    if (rest[i].startsWith('--auth=')) { authMode = rest[i].slice(7) as AuthMode; continue; }
    if (rest[i].startsWith('--browser=')) { browserMode = rest[i].slice(10) as BrowserMode; continue; }
  }
  if (!socketPath) {
    socketPath = resolveSocketPath(id, process.env);
  }
  if (!ENV_LABEL_RE.test(env ?? '')) {
    console.error('env 只允许字母数字开头，后续可为字母数字、点、下划线、连字符');
    return EXIT_USAGE;
  }
  if (authMode !== 'auto' && authMode !== 'profile' && authMode !== 'imported') {
    console.error('auth 只接受 auto|profile|imported');
    return EXIT_USAGE;
  }
  await runDaemon(id, { env, socketPath, authMode, browserMode });
  return 0;
}
