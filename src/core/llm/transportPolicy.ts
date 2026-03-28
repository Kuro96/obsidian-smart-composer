import { Platform } from 'obsidian'

export function shouldUseBrowserNetworkStack(): boolean {
  return !Platform.isDesktop
}

export function shouldUseObsidianRequestUrlNetworkStack(): boolean {
  return !Platform.isDesktop
}

export function getBrowserCompatibleFetchFn(): typeof fetch | undefined {
  return shouldUseBrowserNetworkStack() ? fetch : undefined
}

export function supportsLocalOauthCallbackServer(): boolean {
  return Platform.isDesktop
}
