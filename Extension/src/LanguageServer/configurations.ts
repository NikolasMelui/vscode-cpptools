/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as fs from "fs";
import * as vscode from 'vscode';
import * as util from '../common';
import * as telemetry from '../telemetry';
import { PersistentFolderState } from './persistentState';
import { CppSettings, OtherSettings } from './settings';
import { ABTestSettings, getABTestSettings } from '../abTesting';
import { getCustomConfigProviders } from './customProviders';
import { SettingsPanel } from './settingsPanel';
import * as os from 'os';
import escapeStringRegExp = require('escape-string-regexp');
const configVersion: number = 4;

type Environment = { [key: string]: string | string[] };

// No properties are set in the config since we want to apply vscode settings first (if applicable).
// That code won't trigger if another value is already set.
// The property defaults are moved down to applyDefaultIncludePathsAndFrameworks.
function getDefaultConfig(): Configuration {
    if (process.platform === 'darwin') {
        return { name: "Mac" };
    } else if (process.platform === 'win32') {
        return { name: "Win32" };
    } else {
        return { name: "Linux" };
    }
}

function getDefaultCppProperties(): ConfigurationJson {
    return {
        configurations: [getDefaultConfig()],
        version: configVersion
    };
}

export interface ConfigurationJson {
    configurations: Configuration[];
    env?: {[key: string]: string | string[]};
    version: number;
    enableConfigurationSquiggles?: boolean;
}

export interface Configuration {
    name: string;
    compilerPath?: string;
    knownCompilers?: KnownCompiler[];
    cStandard?: string;
    cppStandard?: string;
    includePath?: string[];
    macFrameworkPath?: string[];
    windowsSdkVersion?: string;
    defines?: string[];
    intelliSenseMode?: string;
    compileCommands?: string;
    forcedInclude?: string[];
    configurationProvider?: string;
    browse?: Browse;
}

export interface ConfigurationErrors {
    compilerPath?: string;
    includePath?: string;
    intelliSenseMode?: string;
    macFrameworkPath?: string;
    forcedInclude?: string;
    compileCommands?: string;
    browsePath?: string;
    databaseFilename?: string;
}

export interface Browse {
    path?: string[];
    limitSymbolsToIncludedHeaders?: boolean | string;
    databaseFilename?: string;
}

export interface KnownCompiler {
    path: string;
    isC: boolean;
}

export interface CompilerDefaults {
    compilerPath: string;
    knownCompilers: KnownCompiler[];
    cStandard: string;
    cppStandard: string;
    includes: string[];
    frameworks: string[];
    windowsSdkVersion: string;
    intelliSenseMode: string;
    rootfs: string;
}

export class CppProperties {
    private rootUri: vscode.Uri;
    private propertiesFile: vscode.Uri = undefined;
    private readonly configFolder: string;
    private configurationJson: ConfigurationJson = null;
    private currentConfigurationIndex: PersistentFolderState<number>;
    private configFileWatcher: vscode.FileSystemWatcher = null;
    private configFileWatcherFallbackTime: Date = new Date(); // Used when file watching fails.
    private compileCommandFileWatchers: fs.FSWatcher[] = [];
    private defaultCompilerPath: string = null;
    private knownCompilers: KnownCompiler[] = null;
    private defaultCStandard: string = null;
    private defaultCppStandard: string = null;
    private defaultIncludes: string[] = null;
    private defaultFrameworks: string[] = null;
    private defaultWindowsSdkVersion: string = null;
    private vcpkgIncludes: string[] = [];
    private vcpkgPathReady: boolean = false;
    private defaultIntelliSenseMode: string = null;
    private readonly configurationGlobPattern: string = "c_cpp_properties.json";
    private disposables: vscode.Disposable[] = [];
    private configurationsChanged = new vscode.EventEmitter<Configuration[]>();
    private selectionChanged = new vscode.EventEmitter<number>();
    private compileCommandsChanged = new vscode.EventEmitter<string>();
    private diagnosticCollection: vscode.DiagnosticCollection;
    private prevSquiggleMetrics: Map<string, { [key: string]: number }> = new Map<string, { [key: string]: number }>();
    private rootfs: string = null;
    private settingsPanel: SettingsPanel = undefined;

    // Any time the default settings are parsed and assigned to `this.configurationJson`,
    // we want to track when the default includes have been added to it.
    private configurationIncomplete: boolean = true;

    constructor(rootUri: vscode.Uri) {
        console.assert(rootUri !== undefined);
        this.rootUri = rootUri;
        let rootPath: string = rootUri ? rootUri.fsPath : "";
        this.currentConfigurationIndex = new PersistentFolderState<number>("CppProperties.currentConfigurationIndex", -1, rootPath);
        this.configFolder = path.join(rootPath, ".vscode");
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection(rootPath);
        this.buildVcpkgIncludePath();
        this.disposables.push(vscode.Disposable.from(this.configurationsChanged, this.selectionChanged, this.compileCommandsChanged));
    }

    public get ConfigurationsChanged(): vscode.Event<Configuration[]> { return this.configurationsChanged.event; }
    public get SelectionChanged(): vscode.Event<number> { return this.selectionChanged.event; }
    public get CompileCommandsChanged(): vscode.Event<string> { return this.compileCommandsChanged.event; }
    public get Configurations(): Configuration[] { return this.configurationJson ? this.configurationJson.configurations : null; }
    public get CurrentConfigurationIndex(): number { return this.currentConfigurationIndex.Value; }
    public get CurrentConfiguration(): Configuration { return this.Configurations ? this.Configurations[this.CurrentConfigurationIndex] : null; }
    public get CompilerPath(): string { return this.CurrentConfiguration ? this.CurrentConfiguration.compilerPath : null; }
    public get KnownCompiler(): KnownCompiler[] { return this.knownCompilers; }

    public get CurrentConfigurationProvider(): string|null {
        if (this.CurrentConfiguration.configurationProvider) {
            return this.CurrentConfiguration.configurationProvider;
        }
        return new CppSettings(this.rootUri).defaultConfigurationProvider;
    }

    public get ConfigurationNames(): string[] {
        let result: string[] = [];
        this.configurationJson.configurations.forEach((config: Configuration) => result.push(config.name));
        return result;
    }

    public set CompilerDefaults(compilerDefaults: CompilerDefaults) {
        this.defaultCompilerPath = compilerDefaults.compilerPath;
        this.knownCompilers = compilerDefaults.knownCompilers;
        this.defaultCStandard = compilerDefaults.cStandard;
        this.defaultCppStandard = compilerDefaults.cppStandard;
        this.defaultIncludes = compilerDefaults.includes;
        this.defaultFrameworks = compilerDefaults.frameworks;
        this.defaultWindowsSdkVersion = compilerDefaults.windowsSdkVersion;
        this.defaultIntelliSenseMode = compilerDefaults.intelliSenseMode;
        this.rootfs = compilerDefaults.rootfs;

        // defaultPaths is only used when there isn't a c_cpp_properties.json, but we don't send the configuration changed event
        // to the language server until the default include paths and frameworks have been sent.
        let configFilePath: string = path.join(this.configFolder, "c_cpp_properties.json");
        if (fs.existsSync(configFilePath)) {
            this.propertiesFile = vscode.Uri.file(configFilePath);
        } else {
            this.propertiesFile = null;
        }
        
        let settingsPath: string = path.join(this.configFolder, this.configurationGlobPattern);
        this.configFileWatcher = vscode.workspace.createFileSystemWatcher(settingsPath);
        this.disposables.push(this.configFileWatcher);
        this.configFileWatcher.onDidCreate((uri) => {
            this.propertiesFile = uri;
            this.handleConfigurationChange();
        });

        this.configFileWatcher.onDidDelete(() => {
            this.propertiesFile = null;
            this.resetToDefaultSettings(true);
            this.handleConfigurationChange();
        });

        this.configFileWatcher.onDidChange(() => {
            // If the file is one of the textDocument's vscode is tracking, we need to wait for an
            // onDidChangeTextDocument event, or we may get old/cached contents when we open it.
            let alreadyTracking: boolean = false;
            for (let i: number = 0; i < vscode.workspace.textDocuments.length; i++) {
                if (vscode.workspace.textDocuments[i].uri.fsPath === settingsPath) {
                    alreadyTracking = true;
                    break;
                }
            }
            if (!alreadyTracking) {
                this.handleConfigurationChange();
            }
        });

        vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
            if (e.document.uri.fsPath === settingsPath) {
                this.handleConfigurationChange();
            }
        });

        this.handleConfigurationChange();
    }

    public get VcpkgInstalled(): boolean {
        return this.vcpkgIncludes.length > 0;
    }

    private onConfigurationsChanged(): void {
        this.configurationsChanged.fire(this.Configurations);
    }

    private onSelectionChanged(): void {
        this.selectionChanged.fire(this.CurrentConfigurationIndex);
        this.handleSquiggles();
    }

    private onCompileCommandsChanged(path: string): void {
        this.compileCommandsChanged.fire(path);
    }

    public onDidChangeSettings(): void {
        // Default settings may have changed in a way that affects the configuration.
        // Just send another message since the language server will sort out whether anything important changed or not.
        if (!this.propertiesFile) {
            this.resetToDefaultSettings(true);
            this.handleConfigurationChange();
        } else if (!this.configurationIncomplete) {
            this.handleConfigurationChange();
        }
    }

    private resetToDefaultSettings(resetIndex: boolean): void {
        this.configurationJson = getDefaultCppProperties();
        if (resetIndex || this.CurrentConfigurationIndex < 0 ||
            this.CurrentConfigurationIndex >= this.configurationJson.configurations.length) {
            this.currentConfigurationIndex.Value = this.getConfigIndexForPlatform(this.configurationJson);
        }
        this.configurationIncomplete = true;
    }

     private applyDefaultIncludePathsAndFrameworks(): void {
        if (this.configurationIncomplete && this.defaultIncludes && this.defaultFrameworks && this.vcpkgPathReady) {
            let configuration: Configuration = this.CurrentConfiguration;
            this.applyDefaultConfigurationValues(configuration);
            this.configurationIncomplete = false;
        }
    }

    private applyDefaultConfigurationValues(configuration: Configuration): void {
        let settings: CppSettings = new CppSettings(this.rootUri);
        let isUnset: (input: any) => boolean = (input: any) => {
                // default values for "default" config settings is null.
                return input === null;
        };

        // Anything that has a vscode setting for it will be resolved in updateServerOnFolderSettingsChange.
        // So if a property is currently unset, but has a vscode setting, don't set it yet, otherwise the linkage
        // to the setting will be lost if this configuration is saved into a c_cpp_properties.json file.

        // Only add settings from the default compiler if user hasn't explicitly set the corresponding VS Code setting.

        if (isUnset(settings.defaultIncludePath)) {
            // We don't add system includes to the includePath anymore. The language server has this information.
            let abTestSettings: ABTestSettings = getABTestSettings();
            let rootFolder: string = abTestSettings.UseRecursiveIncludes ? "${workspaceFolder}/**" : "${workspaceFolder}";
            configuration.includePath = [rootFolder].concat(this.vcpkgIncludes);
        }
        // browse.path is not set by default anymore. When it is not set, the includePath will be used instead.
        if (isUnset(settings.defaultDefines)) {
            configuration.defines = (process.platform === 'win32') ? ["_DEBUG", "UNICODE", "_UNICODE"] : [];
        }
        if (isUnset(settings.defaultMacFrameworkPath) && process.platform === 'darwin') {
            configuration.macFrameworkPath = this.defaultFrameworks;
        }
        if (isUnset(settings.defaultWindowsSdkVersion) && this.defaultWindowsSdkVersion && process.platform === 'win32') {
            configuration.windowsSdkVersion = this.defaultWindowsSdkVersion;
        }
        if (isUnset(settings.defaultCompilerPath) && this.defaultCompilerPath &&
            isUnset(settings.defaultCompileCommands) && !configuration.compileCommands) {
            // compile_commands.json already specifies a compiler. compilerPath overrides the compile_commands.json compiler so
            // don't set a default when compileCommands is in use.
            configuration.compilerPath = this.defaultCompilerPath;
        }
        if (this.knownCompilers) {
            configuration.knownCompilers = this.knownCompilers;
        }
        if (isUnset(settings.defaultCStandard) && this.defaultCStandard) {
            configuration.cStandard = this.defaultCStandard;
        }
        if (isUnset(settings.defaultCppStandard) && this.defaultCppStandard) {
            configuration.cppStandard = this.defaultCppStandard;
        }
        if (isUnset(settings.defaultIntelliSenseMode)) {
            configuration.intelliSenseMode = this.defaultIntelliSenseMode;
        }
    }

    private get ExtendedEnvironment(): Environment {
        let result: Environment = {};
        if (this.configurationJson.env) {
            Object.assign(result, this.configurationJson.env);
        }

        result["workspaceFolderBasename"] = this.rootUri ? path.basename(this.rootUri.fsPath) : "";
        return result;
    }

    private async buildVcpkgIncludePath(): Promise<void> {
        try {
            // Check for vcpkgRoot and include relevent paths if found.
            let vcpkgRoot: string = util.getVcpkgRoot();
            if (vcpkgRoot) {
                let list: string[] = await util.readDir(vcpkgRoot);
                if (list !== undefined) {
                    // For every *directory* in the list (non-recursive). Each directory is basically a platform.
                    list.forEach((entry) => {
                        if (entry !== "vcpkg") {
                            let pathToCheck: string = path.join(vcpkgRoot, entry);
                            if (fs.existsSync(pathToCheck)) {
                                let p: string = path.join(pathToCheck, "include");
                                if (fs.existsSync(p)) {
                                    p = p.replace(/\\/g, "/");
                                    p = p.replace(vcpkgRoot, "${vcpkgRoot}");
                                    this.vcpkgIncludes.push(p);
                                }
                            }
                        }
                    });
                }
            }
        } catch (error) {} finally {
            this.vcpkgPathReady = true;
            this.handleConfigurationChange();
        }
    }

    private getConfigIndexForPlatform(config: any): number {
        let plat: string;
        if (process.platform === 'darwin') {
            plat = "Mac";
        } else if (process.platform === 'win32') {
            plat = "Win32";
        } else {
            plat = "Linux";
        }
        for (let i: number = 0; i < this.configurationJson.configurations.length; i++) {
            if (config.configurations[i].name === plat) {
                return i;
            }
        }
        return this.configurationJson.configurations.length - 1;
    }

    private getIntelliSenseModeForPlatform(name: string): string {
        // Do the built-in configs first.
        if (name === "Linux") {
            return "gcc-x64";
        } else if (name === "Mac") {
            return "clang-x64";
        } else if (name === "Win32") {
            return "msvc-x64";
        } else if (process.platform === 'win32') {
            // Custom configs default to the OS's preference.
            return "msvc-x64";
        } else if (process.platform === 'darwin') {
            return "clang-x64";
        } else {
            return "gcc-x64";
        }
    }

    private isCompilerIntelliSenseModeCompatible(configuration: Configuration): boolean {
        // Check if intelliSenseMode and compilerPath are compatible
        // cl.exe and msvc mode should be used together
        // Ignore if compiler path is not set or intelliSenseMode is not set
        if (configuration.compilerPath === undefined ||
            configuration.compilerPath === "" ||
            configuration.compilerPath === "${default}" ||
            configuration.intelliSenseMode === undefined ||
            configuration.intelliSenseMode === "" ||
            configuration.intelliSenseMode === "${default}") {
            return true;
        }
        let compilerPathAndArgs: util.CompilerPathAndArgs = util.extractCompilerPathAndArgs(configuration.compilerPath);
        return (compilerPathAndArgs.compilerName === "cl.exe") === (configuration.intelliSenseMode === "msvc-x64");
    }

    public addToIncludePathCommand(path: string): void {
        this.handleConfigurationEditCommand(() => {
            telemetry.logLanguageServerEvent("addToIncludePath");
            this.parsePropertiesFile(); // Clear out any modifications we may have made internally.
            let config: Configuration = this.CurrentConfiguration;
            if (config.includePath === undefined) {
                config.includePath = ["${default}"];
            }
            config.includePath.splice(config.includePath.length, 0, path);
            this.writeToJson();
            this.handleConfigurationChange();
        }, null);
    }

    public updateCustomConfigurationProvider(providerId: string): Thenable<void> {
        return new Promise<void>((resolve) => {
            if (this.propertiesFile) {
                this.handleConfigurationEditJSONCommand(() => {
                    this.parsePropertiesFile(); // Clear out any modifications we may have made internally.
                    let config: Configuration = this.CurrentConfiguration;
                    if (providerId) {
                        config.configurationProvider = providerId;
                    } else {
                        delete config.configurationProvider;
                    }
                    this.writeToJson();
                    this.handleConfigurationChange();
                    resolve();
                }, null);
            } else {
                let settings: CppSettings = new CppSettings(this.rootUri);
                if (providerId) {
                    settings.update("default.configurationProvider", providerId);
                } else {
                    settings.update("default.configurationProvider", undefined); // delete the setting
                }
                this.CurrentConfiguration.configurationProvider = providerId;
                resolve();
            }
        });
    }

    public setCompileCommands(path: string): void {
        this.handleConfigurationEditJSONCommand(() => {
            this.parsePropertiesFile(); // Clear out any modifications we may have made internally.
            let config: Configuration = this.CurrentConfiguration;
            config.compileCommands = path;
            this.writeToJson();
            this.handleConfigurationChange();
        }, null);
    }

    public select(index: number): Configuration {
        if (index === this.configurationJson.configurations.length) {
            this.handleConfigurationEditUICommand(null, vscode.window.showTextDocument);
            return;
        }
        if (index === this.configurationJson.configurations.length + 1) {
            this.handleConfigurationEditJSONCommand(null, vscode.window.showTextDocument);
            return;
        }

        this.currentConfigurationIndex.Value = index;
        this.onSelectionChanged();
    }

    private resolveDefaults(entries: string[], defaultValue: string[]): string[] {
        let result: string[] = [];
        entries.forEach(entry => {
            if (entry === "${default}") {
                // package.json default values for string[] properties is null.
                // If no default is set, return an empty array instead of an array with `null` in it.
                if (defaultValue !== null) {
                    result = result.concat(defaultValue);
                }
            } else {
                result.push(entry);
            }
        });
        return result;
    }

    private resolveAndSplit(paths: string[] | undefined, defaultValue: string[], env: Environment): string[] {
        let result: string[] = [];
        if (paths) {
            paths = this.resolveDefaults(paths, defaultValue);
            paths.forEach(entry => {
                let entries: string[] = util.resolveVariables(entry, env).split(";").filter(e => e);
                result = result.concat(entries);
            });
        }
        return result;
    }

    private resolveVariables(input: string | boolean, defaultValue: string | boolean, env: Environment): string | boolean {
        if (input === undefined || input === "${default}") {
            input = defaultValue;
        }
        if (typeof input === "boolean") {
            return input;
        }
        return util.resolveVariables(input, env);
    }

    private updateConfiguration(property: string[], defaultValue: string[], env: Environment): string[];
    private updateConfiguration(property: string, defaultValue: string, env: Environment): string;
    private updateConfiguration(property: string | boolean, defaultValue: boolean, env: Environment): boolean;
    private updateConfiguration(property, defaultValue, env): any {
        if (util.isString(property) || util.isString(defaultValue)) {
            return this.resolveVariables(property, defaultValue, env);
        } else if (util.isBoolean(property) || util.isBoolean(defaultValue)) {
            return this.resolveVariables(property, defaultValue, env);
        } else if (util.isArrayOfString(property) || util.isArrayOfString(defaultValue)) {
            if (property) {
                return this.resolveAndSplit(property, defaultValue, env);
            } else if (property === undefined && defaultValue) {
                return this.resolveAndSplit(defaultValue, [], env);
            }
        }
        return property;
    }

    private updateServerOnFolderSettingsChange(): void {
        if (!this.configurationJson) {
            return;
        }
        let settings: CppSettings = new CppSettings(this.rootUri);
        let env: Environment = this.ExtendedEnvironment;
        for (let i: number = 0; i < this.configurationJson.configurations.length; i++) {
            let configuration: Configuration = this.configurationJson.configurations[i];

            configuration.includePath = this.updateConfiguration(configuration.includePath, settings.defaultIncludePath, env);
            configuration.defines = this.updateConfiguration(configuration.defines, settings.defaultDefines, env);
            configuration.macFrameworkPath = this.updateConfiguration(configuration.macFrameworkPath, settings.defaultMacFrameworkPath, env);
            configuration.windowsSdkVersion = this.updateConfiguration(configuration.windowsSdkVersion, settings.defaultWindowsSdkVersion, env);
            configuration.forcedInclude = this.updateConfiguration(configuration.forcedInclude, settings.defaultForcedInclude, env);
            configuration.compileCommands = this.updateConfiguration(configuration.compileCommands, settings.defaultCompileCommands, env);
            configuration.compilerPath = this.updateConfiguration(configuration.compilerPath, settings.defaultCompilerPath, env);
            configuration.cStandard = this.updateConfiguration(configuration.cStandard, settings.defaultCStandard, env);
            configuration.cppStandard = this.updateConfiguration(configuration.cppStandard, settings.defaultCppStandard, env);
            configuration.intelliSenseMode = this.updateConfiguration(configuration.intelliSenseMode, settings.defaultIntelliSenseMode, env);
            configuration.configurationProvider = this.updateConfiguration(configuration.configurationProvider, settings.defaultConfigurationProvider, env);

            if (!configuration.browse) {
                configuration.browse = {};
            }

            if (!configuration.browse.path) {
                if (settings.defaultBrowsePath) {
                    configuration.browse.path = settings.defaultBrowsePath;
                } else if (configuration.includePath) {
                    // If the user doesn't set browse.path, copy the includePath over. Make sure ${workspaceFolder} is in there though...
                    configuration.browse.path = configuration.includePath.slice(0);
                    if (-1 === configuration.includePath.findIndex((value: string, index: number) => {
                        return !!value.match(/^\$\{(workspaceRoot|workspaceFolder)\}(\\\*{0,2}|\/\*{0,2})?$/g);
                    })) {
                        configuration.browse.path.push("${workspaceFolder}");
                    }
                }
            } else {
                configuration.browse.path = this.updateConfiguration(configuration.browse.path, settings.defaultBrowsePath, env);
            }

            configuration.browse.limitSymbolsToIncludedHeaders = this.updateConfiguration(configuration.browse.limitSymbolsToIncludedHeaders, settings.defaultLimitSymbolsToIncludedHeaders, env);
            configuration.browse.databaseFilename = this.updateConfiguration(configuration.browse.databaseFilename, settings.defaultDatabaseFilename, env);
        }

        this.updateCompileCommandsFileWatchers();
        if (!this.configurationIncomplete) {
            this.onConfigurationsChanged();
        }
    }

    // Dispose existing and loop through cpp and populate with each file (exists or not) as you go.
    // paths are expected to have variables resolved already
    public updateCompileCommandsFileWatchers(): void {
        this.compileCommandFileWatchers.forEach((watcher: fs.FSWatcher) => watcher.close());
        this.compileCommandFileWatchers = []; //reset it
        let filePaths: Set<string> = new Set<string>();
        this.configurationJson.configurations.forEach(c => {
            if (c.compileCommands !== undefined && fs.existsSync(c.compileCommands)) {
                filePaths.add(c.compileCommands);
            }
        });
        try {
            filePaths.forEach((path: string) => {
                this.compileCommandFileWatchers.push(fs.watch(path, (event: string, filename: string) => {
                    if (event !== "rename") {
                        this.onCompileCommandsChanged(path);
                    }
                }));
            });
        } catch (e) {
            // The file watcher limit is hit.
            // TODO: Check if the compile commands file has a higher timestamp during the interval timer.
        }
    }

    public handleConfigurationEditCommand(onCreation: () => void, showDocument: (document: vscode.TextDocument) => void): void {
        let otherSettings: OtherSettings = new OtherSettings(this.rootUri);
        if (otherSettings.settingsEditor === "ui") {
            this.handleConfigurationEditUICommand(onCreation, showDocument);
        } else {
            this.handleConfigurationEditJSONCommand(onCreation, showDocument);
        }
    }

    public handleConfigurationEditJSONCommand(onCreation: () => void, showDocument: (document: vscode.TextDocument) => void): void {
        this.ensurePropertiesFile().then(() => {
            console.assert(this.propertiesFile);
            if (onCreation) {
                onCreation();
            }
            // Directly open the json file
            vscode.workspace.openTextDocument(this.propertiesFile).then((document: vscode.TextDocument) => {
                if (showDocument) {
                    showDocument(document);
                }
            });
        });
    }

    private ensureSettingsPanelInitlialized(): void {
        if (this.settingsPanel === undefined) {
            let settings: CppSettings = new CppSettings(this.rootUri);
            this.settingsPanel = new SettingsPanel();
            this.settingsPanel.setKnownCompilers(this.knownCompilers, settings.preferredPathSeparator);
            this.settingsPanel.SettingsPanelActivated(() => this.onSettingsPanelActivated());
            this.settingsPanel.ConfigValuesChanged(() => this.saveConfigurationUI());
            this.settingsPanel.ConfigSelectionChanged(() => this.onConfigSelectionChanged());
            this.settingsPanel.AddConfigRequested((e) => this.onAddConfigRequested(e));
            this.disposables.push(this.settingsPanel);
        }
    }

    public handleConfigurationEditUICommand(onCreation: () => void, showDocument: (document: vscode.TextDocument) => void): void {
        this.ensurePropertiesFile().then(() => {
            if (this.propertiesFile) {
                if (onCreation) {
                    onCreation();
                }
                if (this.parsePropertiesFile()) {
                    this.ensureSettingsPanelInitlialized();

                    // Use the active configuration as the default selected configuration to load on UI editor
                    this.settingsPanel.selectedConfigIndex = this.currentConfigurationIndex.Value;
                    this.settingsPanel.createOrShow(this.ConfigurationNames,
                        this.configurationJson.configurations[this.settingsPanel.selectedConfigIndex],
                        this.getErrorsForConfigUI(this.settingsPanel.selectedConfigIndex));
                } else {
                    // Parse failed, open json file
                    vscode.workspace.openTextDocument(this.propertiesFile).then((document: vscode.TextDocument) => {
                        if (showDocument) {
                            showDocument(document);
                        }
                    });
                }
            }
        });
    }

    private onSettingsPanelActivated(): void {
        if (this.configurationJson) {
            this.ensurePropertiesFile().then(() => {
                if (this.propertiesFile) {
                    if (this.parsePropertiesFile()) {
                        // The settings UI became visible or active.
                        // Ensure settingsPanel has copy of latest current configuration
                        if (this.settingsPanel.selectedConfigIndex >= this.configurationJson.configurations.length) {
                            this.settingsPanel.selectedConfigIndex = this.currentConfigurationIndex.Value;
                        }
                        this.settingsPanel.updateConfigUI(this.ConfigurationNames,
                            this.configurationJson.configurations[this.settingsPanel.selectedConfigIndex],
                            this.getErrorsForConfigUI(this.settingsPanel.selectedConfigIndex));
                    } else {
                        // Parse failed, open json file
                        vscode.workspace.openTextDocument(this.propertiesFile);
                    }
                }
            });
        }
    }

    private saveConfigurationUI(): void {
        this.parsePropertiesFile(); // Clear out any modifications we may have made internally.
        let config: Configuration = this.settingsPanel.getLastValuesFromConfigUI();
        this.configurationJson.configurations[this.settingsPanel.selectedConfigIndex] = config;
        this.settingsPanel.updateErrors(this.getErrorsForConfigUI(this.settingsPanel.selectedConfigIndex));
        this.writeToJson();
    }

    private onConfigSelectionChanged(): void {
        this.settingsPanel.updateConfigUI(this.ConfigurationNames,
            this.configurationJson.configurations[this.settingsPanel.selectedConfigIndex],
            this.getErrorsForConfigUI(this.settingsPanel.selectedConfigIndex));
    }

    private onAddConfigRequested(configName: string): void {
        this.parsePropertiesFile(); // Clear out any modifications we may have made internally.

        // Create default config and add to list of configurations
        let newConfig: Configuration = { name: configName };
        this.applyDefaultConfigurationValues(newConfig);
        delete newConfig.knownCompilers;
        this.configurationJson.configurations.push(newConfig);

        // Update UI
        this.settingsPanel.selectedConfigIndex = this.configurationJson.configurations.length - 1;
        this.settingsPanel.updateConfigUI(this.ConfigurationNames,
            this.configurationJson.configurations[this.settingsPanel.selectedConfigIndex],
            null);

        // Save new config to file
        this.writeToJson();
    }

    private handleConfigurationChange(): void {
        if (this.propertiesFile === undefined) {
            return; // Occurs when propertiesFile hasn't been checked yet.
        }
        this.configFileWatcherFallbackTime = new Date();
        if (this.propertiesFile) {
            this.parsePropertiesFile();
            // parsePropertiesFile can fail, but it won't overwrite an existing configurationJson in the event of failure.
            // this.configurationJson should only be undefined here if we have never successfully parsed the propertiesFile.
            if (this.configurationJson) {
                if (this.CurrentConfigurationIndex < 0 ||
                    this.CurrentConfigurationIndex >= this.configurationJson.configurations.length) {
                    // If the index is out of bounds (during initialization or due to removal of configs), fix it.
                    this.currentConfigurationIndex.Value = this.getConfigIndexForPlatform(this.configurationJson);
                }
            }
        }

        if (!this.configurationJson) {
            this.resetToDefaultSettings(true);  // I don't think there's a case where this will be hit anymore.
        }

        this.applyDefaultIncludePathsAndFrameworks();
        this.updateServerOnFolderSettingsChange();
    }

    private async ensurePropertiesFile(): Promise<void> {
        if (this.propertiesFile && fs.existsSync(this.propertiesFile.fsPath)) {
            return;
        } else {
            try {
                if  (!fs.existsSync(this.configFolder)) {
                    fs.mkdirSync(this.configFolder);
                }

                let fullPathToFile: string = path.join(this.configFolder, "c_cpp_properties.json");
                if (this.configurationJson) {
                    this.resetToDefaultSettings(true);
                }
                this.applyDefaultIncludePathsAndFrameworks();
                let settings: CppSettings = new CppSettings(this.rootUri);
                if (settings.defaultConfigurationProvider) {
                    this.configurationJson.configurations.forEach(config => {
                        config.configurationProvider = settings.defaultConfigurationProvider;
                    });
                    settings.update("default.configurationProvider", undefined); // delete the setting
                }
                let savedKnownCompilers: KnownCompiler[] = this.configurationJson.configurations[0].knownCompilers;
                delete this.configurationJson.configurations[0].knownCompilers;

                await util.writeFileText(fullPathToFile, JSON.stringify(this.configurationJson, null, 4));
                this.configurationJson.configurations[0].knownCompilers = savedKnownCompilers;

                this.propertiesFile = vscode.Uri.file(path.join(this.configFolder, "c_cpp_properties.json"));

            } catch (err) {
                vscode.window.showErrorMessage(`Failed to create "${this.configFolder}": ${err.message}`);
            }
        }
        return;
    }

    private parsePropertiesFile(): boolean {
        let success: boolean = true;
        try {
            let readResults: string = fs.readFileSync(this.propertiesFile.fsPath, 'utf8');
            if (readResults === "") {
                return; // Repros randomly when the file is initially created. The parse will get called again after the file is written.
            }

            // Try to use the same configuration as before the change.
            let newJson: ConfigurationJson = JSON.parse(readResults);
            if (!newJson || !newJson.configurations || newJson.configurations.length === 0) {
                throw { message: "Invalid configuration file. There must be at least one configuration present in the array." };
            }
            if (!this.configurationIncomplete && this.configurationJson && this.configurationJson.configurations &&
                this.CurrentConfigurationIndex >= 0 && this.CurrentConfigurationIndex < this.configurationJson.configurations.length) {
                for (let i: number = 0; i < newJson.configurations.length; i++) {
                    if (newJson.configurations[i].name === this.configurationJson.configurations[this.CurrentConfigurationIndex].name) {
                        this.currentConfigurationIndex.Value = i;
                        break;
                    }
                }
            }
            this.configurationJson = newJson;
            if (this.CurrentConfigurationIndex < 0 || this.CurrentConfigurationIndex >= newJson.configurations.length) {
                this.currentConfigurationIndex.Value = this.getConfigIndexForPlatform(newJson);
            }

            let dirty: boolean = false;
            for (let i: number = 0; i < this.configurationJson.configurations.length; i++) {
                let newId: string = getCustomConfigProviders().checkId(this.configurationJson.configurations[i].configurationProvider);
                if (newId !== this.configurationJson.configurations[i].configurationProvider) {
                    dirty = true;
                    this.configurationJson.configurations[i].configurationProvider = newId;
                }
            }

            // Remove disallowed variable overrides
            if (this.configurationJson.env) {
                delete this.configurationJson.env['workspaceRoot'];
                delete this.configurationJson.env['workspaceFolder'];
                delete this.configurationJson.env['workspaceFolderBasename'];
                delete this.configurationJson.env['default'];
            }

            // Warning: There is a chance that this is incorrect in the event that the c_cpp_properties.json file was created before
            // the system includes were available.
            this.configurationIncomplete = false;

            if (this.configurationJson.version !== configVersion) {
                dirty = true;
                if (this.configurationJson.version === undefined) {
                    this.updateToVersion2();
                }

                if (this.configurationJson.version === 2) {
                    this.updateToVersion3();
                }

                if (this.configurationJson.version === 3) {
                    this.updateToVersion4();
                } else {
                    this.configurationJson.version = configVersion;
                    vscode.window.showErrorMessage('Unknown version number found in c_cpp_properties.json. Some features may not work as expected.');
                }
            }

            if (dirty) {
                try {
                    this.writeToJson();
                } catch (err) {
                    // Ignore write errors, the file may be under source control. Updated settings will only be modified in memory.
                    vscode.window.showWarningMessage(`Attempt to update "${this.propertiesFile.fsPath}" failed (do you have write access?)`);
                    success = false;
                }
            }

        } catch (err) {
            vscode.window.showErrorMessage(`Failed to parse "${this.propertiesFile.fsPath}": ${err.message}`);
            success = false;
        }

        if (success) {
            this.handleSquiggles();
        }

        return success;
    }

    private resolvePath(path: string, isWindows: boolean): string {
        if (!path || path === "${default}") {
            return "";
        }

        let result: string = "";

        // first resolve variables
        result = util.resolveVariables(path, this.ExtendedEnvironment);
        if (result.includes("${workspaceFolder}")) {
            result = result.replace("${workspaceFolder}", this.rootUri.fsPath);
        }
        if (result.includes("${workspaceRoot}")) {
            result = result.replace("${workspaceRoot}", this.rootUri.fsPath);
        }
        if (result.includes("${vcpkgRoot}") && util.getVcpkgRoot()) {
            result = result.replace("${vcpkgRoot}", util.getVcpkgRoot());
        }
        if (result.includes("*")) {
            result = result.replace(/\*/g, "");
        }

        // resolve WSL paths
        if (isWindows && result.startsWith("/")) {
            const mntStr: string = "/mnt/";
            if (result.length > "/mnt/c/".length && result.substr(0, mntStr.length) === mntStr) {
                result = result.substr(mntStr.length);
                result = result.substr(0, 1) + ":" + result.substr(1);
            } else if (this.rootfs && this.rootfs.length > 0) {
                result = this.rootfs + result.substr(1);
                // TODO: Handle WSL symlinks.
            }
        }

        return result;
    }

    private getErrorsForConfigUI(configIndex: number): ConfigurationErrors {
        let errors: ConfigurationErrors = {};
        const isWindows: boolean = os.platform() === 'win32';
        let config: Configuration = this.configurationJson.configurations[configIndex];

        // Validate compilerPath
        let resolvedCompilerPath: string = this.resolvePath(config.compilerPath, isWindows);
        let compilerPathAndArgs: util.CompilerPathAndArgs = util.extractCompilerPathAndArgs(resolvedCompilerPath);
        if (resolvedCompilerPath &&
            // Don't error cl.exe paths because it could be for an older preview build.
            !(isWindows && compilerPathAndArgs.compilerName === "cl.exe")) {
            resolvedCompilerPath = resolvedCompilerPath.trim();

            // Error when the compiler's path has spaces without quotes but args are used.
            // Except, exclude cl.exe paths because it could be for an older preview build.
            let compilerPathNeedsQuotes: boolean =
                compilerPathAndArgs.additionalArgs &&
                !resolvedCompilerPath.startsWith('"') &&
                compilerPathAndArgs.compilerPath.includes(" ");
            
            let compilerPathErrors: string[] = [];
            if (compilerPathNeedsQuotes) {
                compilerPathErrors.push(`Compiler path with spaces and arguments is missing double quotes " around the path.`);
            }

            // Get compiler path without arguments before checking if it exists
            resolvedCompilerPath = compilerPathAndArgs.compilerPath;

            let pathExists: boolean = true;
            let existsWithExeAdded: (path: string) => boolean = (path: string) => {
                return isWindows && !path.startsWith("/") && fs.existsSync(path + ".exe");
            };
            if (!fs.existsSync(resolvedCompilerPath)) {
                if (existsWithExeAdded(resolvedCompilerPath)) {
                    resolvedCompilerPath += ".exe";
                } else {
                    // Check again for a relative path.
                    const relativePath: string = this.rootUri.fsPath + path.sep + resolvedCompilerPath;
                    if (!fs.existsSync(relativePath)) {
                        if (existsWithExeAdded(resolvedCompilerPath)) {
                            resolvedCompilerPath += ".exe";
                        } else {
                            pathExists = false;
                        }
                    } else {
                        resolvedCompilerPath = relativePath;
                    }
                }
            }

            if (!pathExists) {
                let message: string = `Cannot find: ${resolvedCompilerPath}`;
                compilerPathErrors.push(message);
            } else if (compilerPathAndArgs.compilerPath === "") {
                let message: string = `Invalid input, cannot resolve compiler path`;
                compilerPathErrors.push(message);
            } else if (!util.checkFileExistsSync(resolvedCompilerPath)) {
                let message: string = `Path is not a file: ${resolvedCompilerPath}`;
                compilerPathErrors.push(message);
            }

            if (compilerPathErrors.length > 0) {
                errors.compilerPath = compilerPathErrors.join('\n');
            }
        }

        // Validate paths (directories)
        errors.includePath = this.validatePath(config.includePath);
        errors.macFrameworkPath = this.validatePath(config.macFrameworkPath);
        errors.browsePath = this.validatePath(config.browse ? config.browse.path : undefined);

        // Validate files
        errors.forcedInclude = this.validatePath(config.forcedInclude, false);
        errors.compileCommands = this.validatePath(config.compileCommands, false);
        errors.databaseFilename = this.validatePath((config.browse ? config.browse.databaseFilename : undefined), false);

        // Validate intelliSenseMode
        if (isWindows && !this.isCompilerIntelliSenseModeCompatible(config)) {
            errors.intelliSenseMode = `IntelliSense mode ${config.intelliSenseMode} is incompatible with compiler path.`;
        }

        return errors;
    }

    private validatePath(input: string|string[], isDirectory: boolean = true): string {
        if (!input) {
            return undefined;
        }

        const isWindows: boolean = os.platform() === 'win32';
        let errorMsg: string = undefined;
        let errors: string[] = [];
        let paths: string[] = [];

        if (util.isString(input)) {
            paths.push(input);
        } else {
            paths = input;
        }

        for (let p of paths) {
            let pathExists: boolean = true;
            let resolvedPath: string = this.resolvePath(p, isWindows);
            if (!resolvedPath) {
                continue;
            }

            // Check if resolved path exists
            if (!fs.existsSync(resolvedPath)) {
                // Check for relative path if resolved path does not exists
                const relativePath: string = this.rootUri.fsPath + path.sep + resolvedPath;
                if (!fs.existsSync(relativePath)) {
                    pathExists = false;
                } else {
                    resolvedPath = relativePath;
                }
            }

            if (!pathExists) {
                let message: string = `Cannot find: ${resolvedPath}`;
                errors.push(message);
                continue;
            }

            // Check if path is a directory or file
            if (isDirectory && !util.checkDirectoryExistsSync(resolvedPath)) {
                let message: string = `Path is not a directory: ${resolvedPath}`;
                errors.push(message);
            } else if (!isDirectory && !util.checkFileExistsSync(resolvedPath)) {
                let message: string = `Path is not a file: ${resolvedPath}`;
                errors.push(message);
            }
        }

        if (errors.length > 0) {
            errorMsg = errors.join('\n');
        }

        return errorMsg;
    }

    private handleSquiggles(): void {
        if (!this.propertiesFile) {
            return;
        }

        if (this.configurationJson.enableConfigurationSquiggles === false) {
            this.diagnosticCollection.clear();
            return;
        }

        const settings: CppSettings = new CppSettings(this.rootUri);
        if (settings.defaultEnableConfigurationSquiggles === false) {
            this.diagnosticCollection.clear();
            return;
        }

        vscode.workspace.openTextDocument(this.propertiesFile).then((document: vscode.TextDocument) => {
            let diagnostics: vscode.Diagnostic[] = new Array<vscode.Diagnostic>();

            // Get the text of the current configuration.
            let curText: string = document.getText();

            // Replace all \<escape character> with \\<character>, except for \"
            // Otherwise, the JSON.parse result will have the \<escape character> missing.
            let configurationsText: string = util.escapeForSquiggles(curText);
            let configurations: ConfigurationJson = JSON.parse(configurationsText);
            let currentConfiguration: Configuration = configurations.configurations[this.CurrentConfigurationIndex];

            let curTextStartOffset: number = 0;
            if (!currentConfiguration.name) {
                return;
            }
            const configStart: number = curText.search(new RegExp(`{\\s*"name"\\s*:\\s*"${escapeStringRegExp(currentConfiguration.name)}"`));
            if (configStart === -1) {
                telemetry.logLanguageServerEvent("ConfigSquiggles", { "error": "config name not first" });
                return;
            }
            curTextStartOffset = configStart + 1;
            curText = curText.substr(curTextStartOffset); // Remove earlier configs.
            const nameEnd: number = curText.indexOf(":");
            curTextStartOffset += nameEnd + 1;
            curText = curText.substr(nameEnd + 1);
            const nextNameStart: number = curText.search(new RegExp('"name"\\s*:\\s*"'));
            if (nextNameStart !== -1) {
                curText = curText.substr(0, nextNameStart + 6); // Remove later configs.
                const nextNameStart2: number = curText.search(new RegExp('\\s*}\\s*,\\s*{\\s*"name"'));
                if (nextNameStart2 === -1) {
                    telemetry.logLanguageServerEvent("ConfigSquiggles", { "error": "next config name not first" });
                    return;
                }
                curText = curText.substr(0, nextNameStart2);
            }
            if (this.prevSquiggleMetrics[currentConfiguration.name] === undefined) {
                this.prevSquiggleMetrics[currentConfiguration.name] = { PathNonExistent: 0, PathNotAFile: 0, PathNotADirectory: 0, CompilerPathMissingQuotes: 0, CompilerModeMismatch: 0 };
            }
            let newSquiggleMetrics: { [key: string]: number } = { PathNonExistent: 0, PathNotAFile: 0, PathNotADirectory: 0, CompilerPathMissingQuotes: 0, CompilerModeMismatch: 0 };
            const isWindows: boolean = os.platform() === 'win32';

            // TODO: Add other squiggles.

            // Check if intelliSenseMode and compilerPath are compatible
            if (isWindows) {
                // cl.exe is only available on Windows
                const intelliSenseModeStart: number = curText.search(/\s*\"intelliSenseMode\"\s*:\s*\"/);
                if (intelliSenseModeStart !== -1) {
                    const intelliSenseModeValueStart: number = curText.indexOf('"', curText.indexOf(":", intelliSenseModeStart));
                    const intelliSenseModeValueEnd: number = intelliSenseModeStart === -1 ? -1 : curText.indexOf('"', intelliSenseModeValueStart + 1) + 1;

                    if (!this.isCompilerIntelliSenseModeCompatible(currentConfiguration)) {
                        let message: string = `intelliSenseMode ${currentConfiguration.intelliSenseMode} is incompatible with compilerPath.`;
                        let diagnostic: vscode.Diagnostic = new vscode.Diagnostic(
                            new vscode.Range(document.positionAt(curTextStartOffset + intelliSenseModeValueStart),
                                document.positionAt(curTextStartOffset + intelliSenseModeValueEnd)),
                            message, vscode.DiagnosticSeverity.Warning);
                        diagnostics.push(diagnostic);
                        newSquiggleMetrics.CompilerModeMismatch++;
                    }
                }
            }

            // Check for path-related squiggles.
            let paths: Set<string> = new Set<string>();
            for (let pathArray of [ (currentConfiguration.browse ? currentConfiguration.browse.path : undefined),
                currentConfiguration.includePath, currentConfiguration.macFrameworkPath, currentConfiguration.forcedInclude ] ) {
                if (pathArray) {
                    for (let curPath of pathArray) {
                        paths.add(`${curPath}`);
                    }
                }
            }
            if (currentConfiguration.compileCommands) {
                paths.add(`${currentConfiguration.compileCommands}`);
            }

            if (currentConfiguration.compilerPath) {
                // Unlike other cases, compilerPath may not start or end with " due to trimming of whitespace and the possibility of compiler args.
                paths.add(`${currentConfiguration.compilerPath}`);
            }

            // Get the start/end for properties that are file-only.
            const forcedIncludeStart: number = curText.search(/\s*\"forcedInclude\"\s*:\s*\[/);
            const forcedeIncludeEnd: number = forcedIncludeStart === -1 ? -1 : curText.indexOf("]", forcedIncludeStart);
            const compileCommandsStart: number = curText.search(/\s*\"compileCommands\"\s*:\s*\"/);
            const compileCommandsEnd: number = compileCommandsStart === -1 ? -1 : curText.indexOf('"', curText.indexOf('"', curText.indexOf(":", compileCommandsStart)) + 1);
            const compilerPathStart: number = curText.search(/\s*\"compilerPath\"\s*:\s*\"/);
            const compilerPathEnd: number = compilerPathStart === -1 ? -1 : curText.indexOf('"', curText.indexOf('"', curText.indexOf(":", compilerPathStart)) + 1) + 1;

            for (let curPath of paths) {
                const isCompilerPath: boolean = curPath === currentConfiguration.compilerPath;
                // Resolve special path cases.
                if (curPath === "${default}") {
                    // TODO: Add squiggles for when the C_Cpp.default.* paths are invalid.
                    continue;
                }

                let resolvedPath: string = this.resolvePath(curPath, isWindows);
                if (!resolvedPath) {
                    continue;
                }

                // TODO: Invalid paths created from environment variables are not detected.

                let compilerPathNeedsQuotes: boolean = false;
                if (isCompilerPath) {
                    resolvedPath = resolvedPath.trim();
                    let compilerPathAndArgs: util.CompilerPathAndArgs = util.extractCompilerPathAndArgs(resolvedPath);
                    if (isWindows && compilerPathAndArgs.compilerName === "cl.exe") {
                        continue; // Don't squiggle invalid cl.exe paths because it could be for an older preview build.
                    }
                    // Squiggle when the compiler's path has spaces without quotes but args are used.
                    compilerPathNeedsQuotes = compilerPathAndArgs.additionalArgs && !resolvedPath.startsWith('"') && compilerPathAndArgs.compilerPath.includes(" ");
                    resolvedPath = compilerPathAndArgs.compilerPath;
                }

                const isWSL: boolean = isWindows && resolvedPath.startsWith("/");
                let pathExists: boolean = true;
                let existsWithExeAdded: (path: string) => boolean = (path: string) => {
                    return isCompilerPath && isWindows && !isWSL && fs.existsSync(path + ".exe");
                };
                if (!fs.existsSync(resolvedPath)) {
                    if (existsWithExeAdded(resolvedPath)) {
                        resolvedPath += ".exe";
                    } else {
                        // Check again for a relative path.
                        const relativePath: string = this.rootUri.fsPath + path.sep + resolvedPath;
                        if (!fs.existsSync(relativePath)) {
                            if (existsWithExeAdded(resolvedPath)) {
                                resolvedPath += ".exe";
                            } else {
                                pathExists = false;
                            }
                        } else {
                            resolvedPath = relativePath;
                        }
                    }
                }

                // Normalize path separators.
                if (path.sep === "/") {
                    resolvedPath = resolvedPath.replace(/\\/g, path.sep);
                } else {
                    resolvedPath = resolvedPath.replace(/\//g, path.sep);
                }

                // Iterate through the text and apply squiggles.

                // Escape the path string for literal use in a regular expression
                // Need to escape any quotes to match the original text
                let escapedPath: string = curPath.replace(/\"/g, '\\\"');
                escapedPath = escapedPath.replace(/[-\"\/\\^$*+?.()|[\]{}]/g, '\\$&');

                // Create a pattern to search for the path with either a quote or semicolon immediately before and after,
                // and extend that pattern to the next quote before and next quote after it.
                let pattern: RegExp = new RegExp(`"[^"]*?(?<="|;)${escapedPath}(?="|;).*?"`, "g");
                let matches: string[] = curText.match(pattern);
                if (matches) {
                    let curOffset: number = 0;
                    let endOffset: number = 0;
                    for (let curMatch of matches) {
                        curOffset = curText.substr(endOffset).search(pattern) + endOffset;
                        endOffset = curOffset + curMatch.length;
                        let message: string;
                        if (!pathExists) {
                            message = `Cannot find "${resolvedPath}".`;
                            newSquiggleMetrics.PathNonExistent++;
                        } else {
                            // Check for file versus path mismatches.
                            if ((curOffset >= forcedIncludeStart && curOffset <= forcedeIncludeEnd) ||
                                (curOffset >= compileCommandsStart && curOffset <= compileCommandsEnd) ||
                                (curOffset >= compilerPathStart && curOffset <= compilerPathEnd)) {
                                if (compilerPathNeedsQuotes) {
                                    message = `Compiler path with spaces and arguments is missing \\" around the path.`;
                                    newSquiggleMetrics.CompilerPathMissingQuotes++;
                                } else {
                                    if (util.checkFileExistsSync(resolvedPath)) {
                                        continue;
                                    }
                                    message = `Path is not a file: "${resolvedPath}".`;
                                    newSquiggleMetrics.PathNotAFile++;
                                }
                            } else {
                                if (util.checkDirectoryExistsSync(resolvedPath)) {
                                    continue;
                                }
                                message = `Path is not a directory: "${resolvedPath}".`;
                                newSquiggleMetrics.PathNotADirectory++;
                            }
                        }
                        let diagnostic: vscode.Diagnostic = new vscode.Diagnostic(
                            new vscode.Range(document.positionAt(curTextStartOffset + curOffset),
                                document.positionAt(curTextStartOffset + endOffset)),
                            message, vscode.DiagnosticSeverity.Warning);
                        diagnostics.push(diagnostic);
                    }
                }
            }
            if (diagnostics.length !== 0) {
                this.diagnosticCollection.set(document.uri, diagnostics);
            } else {
                this.diagnosticCollection.clear();
            }

            // Send telemetry on squiggle changes.
            let changedSquiggleMetrics: { [key: string]: number } = {};
            if (newSquiggleMetrics.PathNonExistent !== this.prevSquiggleMetrics[currentConfiguration.name].PathNonExistent) {
                changedSquiggleMetrics.PathNonExistent = newSquiggleMetrics.PathNonExistent;
            }
            if (newSquiggleMetrics.PathNotAFile !== this.prevSquiggleMetrics[currentConfiguration.name].PathNotAFile) {
                changedSquiggleMetrics.PathNotAFile = newSquiggleMetrics.PathNotAFile;
            }
            if (newSquiggleMetrics.PathNotADirectory !== this.prevSquiggleMetrics[currentConfiguration.name].PathNotADirectory) {
                changedSquiggleMetrics.PathNotADirectory = newSquiggleMetrics.PathNotADirectory;
            }
            if (newSquiggleMetrics.CompilerPathMissingQuotes !== this.prevSquiggleMetrics[currentConfiguration.name].CompilerPathMissingQuotes) {
                changedSquiggleMetrics.CompilerPathMissingQuotes = newSquiggleMetrics.CompilerPathMissingQuotes;
            }
            if (newSquiggleMetrics.CompilerModeMismatch !== this.prevSquiggleMetrics[currentConfiguration.name].CompilerModeMismatch) {
                changedSquiggleMetrics.CompilerModeMismatch = newSquiggleMetrics.CompilerModeMismatch;
            }
            if (Object.keys(changedSquiggleMetrics).length > 0) {
                telemetry.logLanguageServerEvent("ConfigSquiggles", null, changedSquiggleMetrics);
            }
            this.prevSquiggleMetrics[currentConfiguration.name] = newSquiggleMetrics;
        });
    }

    private updateToVersion2(): void {
        this.configurationJson.version = 2;
        // no-op. We don't automatically populate the browse.path anymore.
        // We use includePath if browse.path is not present which is what this code used to do.
    }

    private updateToVersion3(): void {
        this.configurationJson.version = 3;
        for (let i: number = 0; i < this.configurationJson.configurations.length; i++) {
            let config: Configuration = this.configurationJson.configurations[i];
            // Look for Mac configs and extra configs on Mac systems
            if (config.name === "Mac" || (process.platform === 'darwin' && config.name !== "Win32" && config.name !== "Linux")) {
                if (config.macFrameworkPath === undefined) {
                    config.macFrameworkPath = [
                        "/System/Library/Frameworks",
                        "/Library/Frameworks"
                    ];
                }
            }
        }
    }

    private updateToVersion4(): void {
        this.configurationJson.version = 4;
        // Update intelliSenseMode, compilerPath, cStandard, and cppStandard with the defaults if they're missing.
        // If VS Code settings exist for these properties, don't add them to c_cpp_properties.json
        let settings: CppSettings = new CppSettings(this.rootUri);
        for (let i: number = 0; i < this.configurationJson.configurations.length; i++) {
            let config: Configuration = this.configurationJson.configurations[i];

            if (config.intelliSenseMode === undefined && !settings.defaultIntelliSenseMode) {
                config.intelliSenseMode = this.getIntelliSenseModeForPlatform(config.name);
            }
            // Don't set the default if compileCommands exist, until it is fixed to have the correct value.
            if (config.compilerPath === undefined && this.defaultCompilerPath && !config.compileCommands && !settings.defaultCompilerPath) {
                config.compilerPath = this.defaultCompilerPath;
            }
            if (!config.cStandard && this.defaultCStandard && !settings.defaultCStandard) {
                config.cStandard = this.defaultCStandard;
            }
            if (!config.cppStandard && this.defaultCppStandard && !settings.defaultCppStandard) {
                config.cppStandard = this.defaultCppStandard;
            }
        }
    }

    private writeToJson(): void {
        console.assert(this.propertiesFile);
        fs.writeFileSync(this.propertiesFile.fsPath, JSON.stringify(this.configurationJson, null, 4));
    }

    public checkCppProperties(): void {
        // Check for change properties in case of file watcher failure.
        let propertiesFile: string = path.join(this.configFolder, "c_cpp_properties.json");
        fs.stat(propertiesFile, (err, stats) => {
            if (err) {
                if (this.propertiesFile) {
                    this.propertiesFile = null; // File deleted.
                    this.resetToDefaultSettings(true);
                    this.handleConfigurationChange();
                }
            } else if (stats.mtime > this.configFileWatcherFallbackTime) {
                if (!this.propertiesFile) {
                    this.propertiesFile = vscode.Uri.file(propertiesFile); // File created.
                }
                this.handleConfigurationChange();
            }
        });
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];

        this.compileCommandFileWatchers.forEach((watcher: fs.FSWatcher) => watcher.close());
        this.compileCommandFileWatchers = []; //reset it

        this.diagnosticCollection.dispose();
    }
}
