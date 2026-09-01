/** Build unsigned Linux x64 AppImage and deb artifacts on a native Linux host. */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIGNING_KEYS = [
  'APPLE_API_ISSUER',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_ID',
  'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE',
  'APPLE_TEAM_ID',
  'CSC_IDENTITY_AUTO_DISCOVERY',
  'CSC_FOR_PULL_REQUEST',
  'CSC_INSTALLER_KEY_PASSWORD',
  'CSC_INSTALLER_LINK',
  'CSC_KEYCHAIN',
  'CSC_KEY_PASSWORD',
  'CSC_LINK',
  'CSC_NAME',
  'WIN_CSC_KEY_PASSWORD',
  'WIN_CSC_LINK',
] as const

/** Injectable native Linux packaging boundary used by focused tests. */
export interface LinuxPackageOptions {
  /** Environment inherited by the packaging command. */
  readonly env: NodeJS.ProcessEnv
  /** Platform executing the package build. */
  readonly platform: NodeJS.Platform
  /** Node architecture executing the package build. */
  readonly arch: string
  /** Node version executing the package build. */
  readonly nodeVersion: string
  /** Repository root containing the Yarn workspace. */
  readonly workspaceRoot: string
  /** Desktop package root containing electron-builder configuration. */
  readonly desktopRoot: string
  /** Absolute electron-builder CLI module. */
  readonly builderCli: string
  /** Node executable used to run package-local scripts. */
  readonly nodeExecutable: string
  /** Absolute packaged artifact directory produced by electron-builder. */
  readonly outputDir: string
  /** Execute one packaging command. */
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => void
  /** Report non-secret packaging progress. */
  readonly log: (message: string) => void
}

/**
 * Remove all certificate discovery and secret variables from an unsigned build.
 * @param environment - Environment that may contain desktop signing configuration.
 * @returns A copy suitable for checks and unsigned packaging.
 */
export function withoutSigningSecrets(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment }
  const signingKeys = new Set<string>(SIGNING_KEYS)
  for (const key of Object.keys(sanitized)) {
    if (signingKeys.has(key.toUpperCase())) delete sanitized[key]
  }
  return sanitized
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

/** Create the native packaging options for the Linux verifier entry point. */
export function createLinuxPackageOptions(): LinuxPackageOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspaceRoot = resolve(desktopRoot, '..')
  const require = createRequire(import.meta.url)
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    workspaceRoot,
    desktopRoot,
    builderCli: require.resolve('electron-builder/cli.js'),
    nodeExecutable: process.execPath,
    outputDir: join(desktopRoot, 'dist'),
    run,
    log: message => console.log(message),
  }
}

/** Run the shared host and Node release gates before packaging. */
function assertLinuxPackageHost(options: LinuxPackageOptions): void {
  if (options.platform !== 'linux') {
    throw new Error('Linux artifacts must be built on a native Linux host')
  }
  if (options.arch !== 'x64') {
    throw new Error(`Linux x64 artifacts require x64 Node; received ${options.arch}`)
  }
  const versionMatch = /^(\d+)\.(\d+)\./u.exec(options.nodeVersion)
  const major = Number(versionMatch?.[1])
  const minor = Number(versionMatch?.[2])
  if (!((major === 22 && minor >= 19) || major === 24)) {
    throw new Error(
      `Linux artifacts require Node 22.19+ or Node 24.x; received ${options.nodeVersion}`,
    )
  }
}

/** Names of the unsigned artifacts produced by the Linux electron-builder targets. */
export const LINUX_ARTIFACT_SUFFIXES = ['.AppImage', '.deb'] as const

/**
 * Run the headless release gates and package unsigned Linux x64 artifacts.
 * @param options - injectable packaging boundary used by focused tests.
 */
export function packageLinuxArtifacts(
  options: LinuxPackageOptions = createLinuxPackageOptions(),
): void {
  assertLinuxPackageHost(options)

  const cleanEnvironment = withoutSigningSecrets(options.env)
  options.log('Building unsigned Linux x64 AppImage and deb artifacts; code signing is a separate release step.')

  if (options.env.DSH_PACKAGE_CHECK_ALREADY_RAN !== '1') {
    options.run(
      'corepack',
      ['yarn', 'workspace', 'dsh-plugin-desktop', 'check:linux-package'],
      options.workspaceRoot,
      cleanEnvironment,
    )
  } else {
    options.log('Skipping the Linux package preflight; the package gate already passed.')
  }

  options.run(
    options.nodeExecutable,
    [
      options.builderCli,
      '--linux',
      'AppImage',
      'deb',
      '--x64',
      '--publish',
      'never',
      '--config.npmRebuild=false',
    ],
    options.desktopRoot,
    {
      ...cleanEnvironment,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  )

  for (const suffix of LINUX_ARTIFACT_SUFFIXES) {
    const matches = existsSync(options.outputDir)
      ? readdirSync(options.outputDir).filter(name => name.startsWith('DSH-Desktop-') && name.endsWith(suffix))
      : []
    if (matches.length === 0) {
      throw new Error(`Linux packaging completed without producing a ${suffix} artifact in ${options.outputDir}`)
    }
    const artifact = matches[0] as string
    options.log(`Verified Linux artifact: ${join(options.outputDir, artifact)}`)
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    packageLinuxArtifacts()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
