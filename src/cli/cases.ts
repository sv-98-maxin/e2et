import * as path from 'node:path';
import { resolveSystemChrome } from '../browser/managed-browser.js';
import { profileMasterExists } from '../browser/profile-browser.js';
import { configuredCdpAvailable } from '../browser/daemon-client.js';
import {
  resolveReplaySelection,
  ReplaySelectionError,
  type ReplaySelection,
} from '../shared/replay-env.js';
import {
  readFullCase, readStoredCase,
  isCaseName, isLoadFailure,
} from '../cases/snapshot.js';
import { verifyCase as serviceVerifyCase, type VerificationEnvironment } from '../cases/replay.js';
import { caseLibraryRoot as serviceCaseLibraryRoot, listCases as serviceListCases, landCase as serviceLandCase } from '../cases/library.js';
import { emitOk, emitError, diag, EXIT_USAGE, EXIT_VALIDATION, type Deps } from './context.js';
import { parseArgs } from './args.js';
import { commandDefinitions } from './commands.js';
import { AcceptanceInputError, readAcceptanceInput, type AcceptanceInput } from '../report/acceptance.js';
import { irDigest } from '../render/render.js';
import type { CaseSnapshot } from '../cases/snapshot.js';

function getArgs(name: string, sub?: string) {
  return commandDefinitions().find((c) => c.name === name && c.subcommand === sub)?.args ?? [];
}

function emitLoadFailure(d: Deps, failure: { load_error: { code: string; message: string; hint?: string } }): number {
  return emitError(d, failure.load_error.code, failure.load_error.message, failure.load_error.hint);
}

async function replaySelectionFromArgs(
  values: Record<string, string>,
  d: Deps,
): Promise<{ selection: ReplaySelection } | { error: string }> {
  const hasExplicitState = Object.hasOwn(values, '--auth-state');
  try {
    const input = {
      ...(values['--auth'] !== undefined ? { auth: values['--auth'] } : {}),
      ...(values['--browser'] !== undefined ? { browser: values['--browser'] } : {}),
      ...(hasExplicitState ? { authState: values['--auth-state'] } : {}),
    };
    const profileAvailable = Boolean(resolveSystemChrome(d.env) && profileMasterExists(d.env));
    let selection = resolveReplaySelection(input, d.env, {
      profileAvailable,
      existingAvailable: false,
    });
    const requestedBrowser = input.browser ?? d.env.E2ET_REPLAY_BROWSER ?? 'auto';
    if (selection.browser === 'managed'
      && requestedBrowser === 'auto'
      && await configuredCdpAvailable(d.env)) {
      selection = resolveReplaySelection(input, d.env, {
        profileAvailable,
        existingAvailable: true,
      });
    }
    return {
      selection: selection.authState !== undefined
        ? { ...selection, authState: path.resolve(d.cwd, selection.authState) }
        : selection,
    };
  } catch (error) {
    if (error instanceof ReplaySelectionError) return { error: error.message };
    throw error;
  }
}

function makeVerifyEnv(d: Deps, replay: ReplaySelection): VerificationEnvironment {
  const replayEnv = { ...d.env };
  delete replayEnv.E2ET_RUN_ACCEPTANCE_DIR;
  delete replayEnv.E2ET_RUN_ID;
  delete replayEnv.E2ET_RUN_ENV;
  if (replay.auth) replayEnv.E2ET_AUTH = replay.auth;
  if (replay.browser) replayEnv.E2ET_REPLAY_BROWSER = replay.browser;
  if (replay.authState) replayEnv.E2ET_AUTH_STATE = replay.authState;
  return {
    env: replayEnv,
    diagnostic: (text: string) => diag(d, text),
    playwrightRunner: (env, cliPackageRoot, testFile, testTimeoutMs) =>
      d.playwrightRunner({ ...d, env }, cliPackageRoot, testFile, testTimeoutMs),
  };
}

function acceptanceFromArgs(d: Deps, values: Record<string, string>, snapshot: CaseSnapshot): { input?: AcceptanceInput } | { exit: number } {
  try {
    const file = values['--acceptance'];
    return { input: readAcceptanceInput(file === undefined ? undefined : path.resolve(d.cwd, file), snapshot.ir, irDigest(snapshot.ir)) };
  } catch (error) {
    if (error instanceof AcceptanceInputError) return { exit: emitError(d, error.code, error.message, undefined, EXIT_USAGE) };
    throw error;
  }
}

export function handleCase(d: Deps, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === 'list') return caseList(d, argv.slice(1));
  if (sub === 'run') return caseRun(d, argv.slice(1));
  return Promise.resolve(emitError(d, 'USAGE', `case 需要子命令 (list|run)`, undefined, EXIT_USAGE));
}

async function caseList(d: Deps, argv: string[]): Promise<number> {
  const { errors } = parseArgs(argv, getArgs('case', 'list'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const library = serviceCaseLibraryRoot(d.homeDir);
  const result = serviceListCases(library);
  if (!result.ok) return emitError(d, result.error.code, result.error.message);
  return emitOk(d, result.data);
}

async function caseRun(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('case', 'run'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const name = values['name'];
  if (!isCaseName(name)) return emitError(d, 'USAGE', `非法用例名: ${name}`, undefined, EXIT_USAGE);
  const library = serviceCaseLibraryRoot(d.homeDir);
  const snapshot = readStoredCase(library, name);
  if (isLoadFailure(snapshot)) return emitLoadFailure(d, snapshot);
  const acceptance = acceptanceFromArgs(d, values, snapshot);
  if ('exit' in acceptance) return acceptance.exit;
  const replay = await replaySelectionFromArgs(values, d);
  if ('error' in replay) return emitError(d, 'USAGE', replay.error, undefined, EXIT_USAGE);
  const env = makeVerifyEnv(d, replay.selection);
  const result = await serviceVerifyCase(env, snapshot, { skip: false, output: values['--output'], replay: replay.selection, acceptance: acceptance.input });
  if (!result.ok) {
    const kind = result.error.kind;
    return emitError(d, result.error.code, result.error.message, result.error.hint, kind === 'usage' ? EXIT_USAGE : kind === 'environment' ? 3 : EXIT_VALIDATION, result.error.evidence);
  }
  return emitOk(d, result.data);
}

export async function handleVerify(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('verify'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const snapshot = readFullCase(values['ir-file']);
  if (isLoadFailure(snapshot)) return emitLoadFailure(d, snapshot);
  const acceptance = acceptanceFromArgs(d, values, snapshot);
  if ('exit' in acceptance) return acceptance.exit;
  const replay = await replaySelectionFromArgs(values, d);
  if ('error' in replay) return emitError(d, 'USAGE', replay.error, undefined, EXIT_USAGE);
  const env = makeVerifyEnv(d, replay.selection);
  const result = await serviceVerifyCase(env, snapshot, { skip: values['--skip-test'] === 'true', output: values['--output'], replay: replay.selection, acceptance: acceptance.input });
  if (!result.ok) {
    const kind = result.error.kind;
    return emitError(d, result.error.code, result.error.message, result.error.hint, kind === 'usage' ? EXIT_USAGE : kind === 'environment' ? 3 : EXIT_VALIDATION, result.error.evidence);
  }
  return emitOk(d, result.data);
}

export async function handleLand(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('land'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const snapshot = readFullCase(values['ir-file']);
  if (isLoadFailure(snapshot)) return emitLoadFailure(d, snapshot);
  const acceptance = acceptanceFromArgs(d, values, snapshot);
  if ('exit' in acceptance) return acceptance.exit;
  const replay = await replaySelectionFromArgs(values, d);
  if ('error' in replay) return emitError(d, 'USAGE', replay.error, undefined, EXIT_USAGE);
  const env = { ...makeVerifyEnv(d, replay.selection), homeDir: d.homeDir };
  const result = await serviceLandCase(env, snapshot, { force: values['--force'] === 'true', output: values['--output'], replay: replay.selection, acceptance: acceptance.input });
  if (!result.ok) {
    const kind = result.error.kind;
    return emitError(d, result.error.code, result.error.message, result.error.hint, kind === 'usage' ? EXIT_USAGE : kind === 'environment' ? 3 : EXIT_VALIDATION, result.error.evidence);
  }
  return emitOk(d, result.data);
}
