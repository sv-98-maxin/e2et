export type AuthMode = 'auto' | 'profile' | 'imported';
export type BrowserMode = 'auto' | 'existing' | 'chrome' | 'managed';

export interface ReplaySelectionInput {
  /** CLI 参数优先；缺省读 env.E2ET_REPLAY_AUTH。 */
  auth?: string;
  /** CLI 参数优先；缺省读 env.E2ET_REPLAY_BROWSER。 */
  browser?: string;
  /** 本次显式 --auth-state。继承 env.E2ET_AUTH_STATE 时不要设置。 */
  authState?: string;
}

export interface ReplaySelectionEnvironment {
  E2ET_REPLAY_AUTH?: string;
  E2ET_REPLAY_BROWSER?: string;
  E2ET_AUTH_STATE?: string;
  E2ET_CDP_URL?: string;
}

export interface ReplayCapabilities {
  profileAvailable: boolean;
  existingAvailable: boolean;
}

export interface ReplaySelection {
  auth: 'profile' | 'imported';
  browser: 'chrome' | 'existing' | 'managed';
  /** 最终有效 state；undefined 表示 profile 或默认 imported 路径。 */
  authState?: string;
}

export class ReplaySelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplaySelectionError';
  }
}

export function resolveReplaySelection(
  input: ReplaySelectionInput,
  env: ReplaySelectionEnvironment = {},
  capabilities: ReplayCapabilities,
): ReplaySelection {
  // CLI 显式 state 是同次 imported 选择；覆盖继承 auth，但显式 auth=profile +
  // state 仍由下面的组合校验拒绝。未显式覆盖的空环境值保留，由 enum 校验报错。
  const requestedAuth = input.auth ?? (input.authState !== undefined
    ? 'imported'
    : env.E2ET_REPLAY_AUTH ?? 'auto');
  const requestedBrowser = input.browser ?? env.E2ET_REPLAY_BROWSER ?? 'auto';
  if (requestedAuth !== 'auto' && requestedAuth !== 'profile' && requestedAuth !== 'imported') {
    throw new ReplaySelectionError(`auth 枚举不合法: ${String(requestedAuth)}`);
  }
  if (requestedBrowser !== 'auto' && requestedBrowser !== 'existing'
    && requestedBrowser !== 'chrome' && requestedBrowser !== 'managed') {
    throw new ReplaySelectionError(`browser 枚举不合法: ${String(requestedBrowser)}`);
  }

  if (input.authState !== undefined && input.authState.trim() === '') {
    throw new ReplaySelectionError('--auth-state 不能为空');
  }
  let authState = input.authState !== undefined ? input.authState : env.E2ET_AUTH_STATE;
  const clearsInheritedState = requestedAuth === 'profile' || requestedBrowser === 'chrome';
  if (clearsInheritedState && input.authState !== undefined) {
    throw new ReplaySelectionError('显式 --auth-state 不能与 profile/chrome 模式混用');
  }
  if (clearsInheritedState) authState = undefined;
  if (authState !== undefined && authState.trim() === '') {
    throw new ReplaySelectionError('E2ET_AUTH_STATE 是空字符串（显式空值不是合法 state 输入）');
  }

  if (requestedAuth === 'profile' && (requestedBrowser === 'existing' || requestedBrowser === 'managed')) {
    throw new ReplaySelectionError(`browser ${requestedBrowser} 不能配 auth profile`);
  }
  if (requestedBrowser === 'chrome' && requestedAuth === 'imported') {
    throw new ReplaySelectionError('browser chrome 只能配 auth profile|auto');
  }

  let auth: AuthMode = authState?.trim() && requestedAuth === 'auto'
    ? 'imported'
    : requestedAuth;
  let browser: ReplaySelection['browser'];
  if (requestedBrowser === 'auto') {
    if (auth === 'profile') {
      browser = 'chrome';
    } else if (auth === 'imported') {
      browser = capabilities.existingAvailable ? 'existing' : 'managed';
    } else if (capabilities.profileAvailable) {
      browser = 'chrome';
      auth = 'profile';
    } else {
      browser = capabilities.existingAvailable ? 'existing' : 'managed';
      auth = 'imported';
    }
  } else {
    browser = requestedBrowser;
  }
  if (browser === 'chrome') auth = 'profile';
  else if (auth === 'auto') auth = 'imported';

  return {
    auth: auth as ReplaySelection['auth'],
    browser,
    ...(authState !== undefined ? { authState } : {}),
  };
}
