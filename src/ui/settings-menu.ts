/**
 * settings-menu.ts — Interactive settings panel for /gitnexus settings.
 *
 * Uses ui.custom() + SettingsList for native TUI rendering with keyboard
 * navigation, live toggle, and per-row descriptions.
 */

import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@mariozechner/pi-tui";
import { type GitNexusConfig, saveConfig } from "../gitnexus.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type SettingsUI = {
  custom<T>(
    factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
    options?: { overlay?: boolean; overlayOptions?: any },
  ): Promise<T>;
};

// ── Settings panel ──────────────────────────────────────────────────────────

export async function openSettingsMenu(
  ui: SettingsUI,
  cfg: GitNexusConfig,
  state: { augmentEnabled: boolean },
  onBack: () => Promise<void>,
): Promise<void> {
  await ui.custom((_tui, theme, _kb, done) => {
    const items: SettingItem[] = [
      {
        id: "autoAugment",
        label: "Auto-augment",
        description:
          "When ON: search results (grep, find, read, bash) are automatically " +
          "enriched with knowledge graph context. When OFF: graph context is " +
          "only available via explicit /gitnexus commands and tools.",
        currentValue: state.augmentEnabled ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "augmentTimeout",
        label: "Augment timeout",
        description:
          "Maximum time (in seconds) to wait for a graph augmentation response. " +
          "Increase for large repos with slow I/O, decrease for snappier responses. " +
          "Default: 8s.",
        currentValue: String(cfg.augmentTimeout ?? 8),
        values: ["4", "6", "8", "10", "15", "20"],
      },
      {
        id: "maxAugmentsPerResult",
        label: "Max augments per result",
        description:
          "Maximum number of patterns to augment in parallel per search result. " +
          "Higher values provide more context but use more tokens. Default: 3.",
        currentValue: String(cfg.maxAugmentsPerResult ?? 3),
        values: ["1", "2", "3", "5"],
      },
      {
        id: "maxSecondaryPatterns",
        label: "Max secondary patterns",
        description:
          "Maximum number of secondary file-based patterns extracted from grep/bash " +
          "output. These provide additional context from files mentioned in results. " +
          "Default: 2.",
        currentValue: String(cfg.maxSecondaryPatterns ?? 2),
        values: ["0", "1", "2", "3", "5"],
      },
      {
        id: "cmd",
        label: "GitNexus command",
        description:
          "The shell command used to invoke gitnexus. " +
          "Change if gitnexus is installed in a non-standard location or you want " +
          "to use npx. Default: gitnexus.",
        currentValue: cfg.cmd ?? "gitnexus",
        values: ["gitnexus", "npx gitnexus@latest", "npx -y gitnexus@latest"],
      },
    ];

    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      /* onChange */ (id, newValue) => {
        if (id === "autoAugment") {
          state.augmentEnabled = newValue === "on";
          cfg.autoAugment = newValue === "on";
          saveConfig(cfg);
        }
        if (id === "augmentTimeout") {
          cfg.augmentTimeout = parseInt(newValue, 10);
          saveConfig(cfg);
        }
        if (id === "maxAugmentsPerResult") {
          cfg.maxAugmentsPerResult = parseInt(newValue, 10);
          saveConfig(cfg);
        }
        if (id === "maxSecondaryPatterns") {
          cfg.maxSecondaryPatterns = parseInt(newValue, 10);
          saveConfig(cfg);
        }
        if (id === "cmd") {
          cfg.cmd = newValue;
          saveConfig(cfg);
        }
      },
      /* onCancel */ () => done(undefined),
    );

    const container = new Container();
    container.addChild(new Text(theme.bold(theme.fg("accent", "⚙  GitNexus Settings")), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => list.handleInput?.(data),
    };
  });

  return onBack();
}
