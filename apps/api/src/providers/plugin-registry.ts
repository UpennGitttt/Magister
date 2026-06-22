import type { ProviderPlugin } from "./provider-plugin";
import { anthropicPlugin } from "./plugins/anthropic-plugin";
import { openAICompatPlugin } from "./plugins/openai-compat-plugin";

export const plugins: ProviderPlugin[] = [];

const dialectToPlugin = new Map<string, ProviderPlugin>();

export function registerProviderPlugin(plugin: ProviderPlugin): void {
  plugins.push(plugin);
  for (const dialect of plugin.dialects) {
    dialectToPlugin.set(dialect, plugin);
  }
}

export function resolveProviderPlugin(dialect: string): ProviderPlugin | undefined {
  return dialectToPlugin.get(dialect);
}

export function getSupportedDialects(): string[] {
  return [...dialectToPlugin.keys()];
}

registerProviderPlugin(anthropicPlugin);
registerProviderPlugin(openAICompatPlugin);
