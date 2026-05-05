import { createOnboardingFlow } from './onboarding-flow.js';
import { createReportFormatters } from './report-formatters.js';
import {
  buildSlashCommands,
  normalizeSlashCommandName as normalizeSlashCommandNameBase,
  slashRef as slashRefBase,
} from './slash-command-surface.js';
import { createSlashCommandRouter } from './slash-command-router.js';
import { createSettingsPanel } from './settings-panel.js';
import { createTextCommandHandler } from './text-command-handler.js';
import { createWorkspaceBusyActions } from './workspace-busy-actions.js';
import { createWorkspaceBrowser } from './workspace-browser.js';

export function createCommandSurface({
  slashPrefix = '',
  botProvider = null,
  defaultUiLanguage = 'en',
  enableConfigCmd = false,
  SlashCommandBuilder,
  onboardingOptions = {},
  settingsPanelOptions = {},
  reportOptions = {},
  workspaceBrowserOptions = {},
  slashRouterOptions = {},
  textCommandOptions = {},
} = {}) {
  const slashCommands = buildSlashCommands({
    SlashCommandBuilder,
    slashPrefix,
    botProvider,
  });
  const normalizeSlashCommandName = (name) => normalizeSlashCommandNameBase(name, slashPrefix);
  const slashRef = (base) => slashRefBase(base, slashPrefix);

  const reports = createReportFormatters({
    ...reportOptions,
    slashRef,
  });

  const workspaceBrowser = createWorkspaceBrowser({
    ...workspaceBrowserOptions,
    formatWorkspaceUpdateReport: reports.formatWorkspaceUpdateReport,
    formatDefaultWorkspaceUpdateReport: reports.formatDefaultWorkspaceUpdateReport,
  });

  const workspaceBusyActions = createWorkspaceBusyActions({
    ...workspaceBrowserOptions,
    commandActions: workspaceBrowserOptions.commandActions,
    getSessionLanguage: reportOptions.getSessionLanguage,
    getSessionProvider: reportOptions.getSessionProvider,
    getWorkspaceBinding: reportOptions.getWorkspaceBinding,
    resolveChildThreadWorkspaceMode: workspaceBrowserOptions.resolveChildThreadWorkspaceMode,
    setChildThreadWorkspaceMode: workspaceBrowserOptions.setChildThreadWorkspaceMode,
    formatWorkspaceBusyReport: reports.formatWorkspaceBusyReport,
    formatWorkspaceUpdateReport: reports.formatWorkspaceUpdateReport,
    openWorkspaceBrowser: workspaceBrowser.openWorkspaceBrowser,
    slashRef,
  });

  const onboarding = createOnboardingFlow({
    ...onboardingOptions,
    botProvider,
    openWorkspaceBrowser: workspaceBrowser.openWorkspaceBrowser,
    slashRef,
  });

  const settingsPanel = createSettingsPanel({
    ...settingsPanelOptions,
    botProvider,
    defaultUiLanguage,
    openWorkspaceBrowser: workspaceBrowser.openWorkspaceBrowser,
    slashRef,
  });

  const routeSlashCommand = createSlashCommandRouter({
    botProvider,
    defaultUiLanguage,
    slashRef,
    ActionRowBuilder: settingsPanelOptions.ActionRowBuilder,
    ModalBuilder: settingsPanelOptions.ModalBuilder,
    TextInputBuilder: settingsPanelOptions.TextInputBuilder,
    TextInputStyle: settingsPanelOptions.TextInputStyle,
    ...slashRouterOptions,
    isOnboardingEnabled: onboarding.isOnboardingEnabled,
    buildOnboardingActionRows: onboarding.buildOnboardingActionRows,
    formatOnboardingStepReport: onboarding.formatOnboardingStepReport,
    formatOnboardingDisabledMessage: onboarding.formatOnboardingDisabledMessage,
    formatOnboardingConfigReport: onboarding.formatOnboardingConfigReport,
    formatStatusReport: reports.formatStatusReportWithLiveData,
    formatQueueReport: reports.formatQueueReport,
    formatDoctorReport: reports.formatDoctorReport,
    formatWorkspaceReport: reports.formatWorkspaceReport,
    formatWorkspaceSetHelp: reports.formatWorkspaceSetHelp,
    formatWorkspaceUpdateReport: reports.formatWorkspaceUpdateReport,
    formatDefaultWorkspaceSetHelp: reports.formatDefaultWorkspaceSetHelp,
    formatDefaultWorkspaceUpdateReport: reports.formatDefaultWorkspaceUpdateReport,
    formatLanguageConfigReport: reports.formatLanguageConfigReport,
    formatFastModeConfigHelp: reports.formatFastModeConfigHelp,
    formatFastModeConfigReport: reports.formatFastModeConfigReport,
    formatRuntimeModeConfigHelp: reports.formatRuntimeModeConfigHelp,
    formatRuntimeModeConfigReport: reports.formatRuntimeModeConfigReport,
    formatProfileConfigHelp: reports.formatProfileConfigHelp,
    formatProfileConfigReport: reports.formatProfileConfigReport,
    formatTimeoutConfigHelp: reports.formatTimeoutConfigHelp,
    formatTimeoutConfigReport: reports.formatTimeoutConfigReport,
    formatProgressReport: reports.formatProgressReport,
    formatCancelReport: reports.formatCancelReport,
    formatCompactStrategyConfigHelp: reports.formatCompactStrategyConfigHelp,
    formatCompactConfigReport: reports.formatCompactConfigReport,
    formatExtraInfoConfigHelp: reports.formatExtraInfoConfigHelp,
    formatExtraInfoConfigReport: reports.formatExtraInfoConfigReport,
    openWorkspaceBrowser: workspaceBrowser.openWorkspaceBrowser,
    openSettingsPanel: settingsPanel.openSettingsPanel,
    openModelSettingsPanel: settingsPanel.openModelSettingsPanel,
  });

  const handleCommand = createTextCommandHandler({
    botProvider,
    enableConfigCmd,
    ...textCommandOptions,
    isOnboardingEnabled: onboarding.isOnboardingEnabled,
    formatHelpReport: reports.formatHelpReport,
    formatStatusReport: reports.formatStatusReportWithLiveData,
    formatQueueReport: reports.formatQueueReport,
    formatDoctorReport: reports.formatDoctorReport,
    formatWorkspaceReport: reports.formatWorkspaceReport,
    formatWorkspaceSetHelp: reports.formatWorkspaceSetHelp,
    formatWorkspaceUpdateReport: reports.formatWorkspaceUpdateReport,
    formatDefaultWorkspaceSetHelp: reports.formatDefaultWorkspaceSetHelp,
    formatDefaultWorkspaceUpdateReport: reports.formatDefaultWorkspaceUpdateReport,
    formatOnboardingConfigHelp: onboarding.formatOnboardingConfigHelp,
    formatOnboardingConfigReport: onboarding.formatOnboardingConfigReport,
    formatOnboardingDisabledMessage: onboarding.formatOnboardingDisabledMessage,
    formatOnboardingReport: onboarding.formatOnboardingReport,
    formatLanguageConfigHelp: reports.formatLanguageConfigHelp,
    formatLanguageConfigReport: reports.formatLanguageConfigReport,
    formatFastModeConfigHelp: reports.formatFastModeConfigHelp,
    formatFastModeConfigReport: reports.formatFastModeConfigReport,
    formatRuntimeModeConfigHelp: reports.formatRuntimeModeConfigHelp,
    formatRuntimeModeConfigReport: reports.formatRuntimeModeConfigReport,
    formatProfileConfigHelp: reports.formatProfileConfigHelp,
    formatProfileConfigReport: reports.formatProfileConfigReport,
    formatTimeoutConfigHelp: reports.formatTimeoutConfigHelp,
    formatTimeoutConfigReport: reports.formatTimeoutConfigReport,
    formatProgressReport: reports.formatProgressReport,
    formatCancelReport: reports.formatCancelReport,
    formatCompactStrategyConfigHelp: reports.formatCompactStrategyConfigHelp,
    formatCompactConfigReport: reports.formatCompactConfigReport,
    formatExtraInfoConfigHelp: reports.formatExtraInfoConfigHelp,
    formatExtraInfoConfigReport: reports.formatExtraInfoConfigReport,
    formatReasoningEffortHelp: reports.formatReasoningEffortHelp,
    parseOnboardingConfigAction: onboarding.parseOnboardingConfigAction,
    openWorkspaceBrowser: workspaceBrowser.openWorkspaceBrowser,
  });

  return {
    formatWorkspaceBusyReport: reports.formatWorkspaceBusyReport,
    buildWorkspaceBusyPayload: workspaceBusyActions.buildWorkspaceBusyPayload,
    handleCommand,
    handleOnboardingButtonInteraction: onboarding.handleOnboardingButtonInteraction,
    handleSettingsPanelInteraction: settingsPanel.handleSettingsPanelInteraction,
    handleSettingsPanelModalSubmit: settingsPanel.handleSettingsPanelModalSubmit,
    handleGoalModalSubmit: routeSlashCommand.handleGoalModalSubmit,
    handleWorkspaceBusyInteraction: workspaceBusyActions.handleWorkspaceBusyInteraction,
    handleWorkspaceBrowserInteraction: workspaceBrowser.handleWorkspaceBrowserInteraction,
    isOnboardingButtonId: onboarding.isOnboardingButtonId,
    isSettingsPanelComponentId: settingsPanel.isSettingsPanelComponentId,
    isSettingsPanelModalId: settingsPanel.isSettingsPanelModalId,
    isGoalModalId: routeSlashCommand.isGoalModalId,
    isWorkspaceBusyComponentId: workspaceBusyActions.isWorkspaceBusyComponentId,
    isWorkspaceBrowserComponentId: workspaceBrowser.isWorkspaceBrowserComponentId,
    normalizeSlashCommandName,
    routeSlashCommand,
    shouldHandleSlashCommandBeforeDefer: routeSlashCommand.shouldHandleBeforeDefer,
    slashCommands,
    slashRef,
  };
}
