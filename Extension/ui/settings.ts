/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

const elementId: { [key: string]: string } = {
    // Basic settings
    configName: "configName",
    configSelection: "configSelection",
    addConfigDiv: "addConfigDiv",
    addConfigBtn: "addConfigBtn",
    addConfigInputDiv: "addConfigInputDiv",
    addConfigOk: "addConfigOk",
    addConfigCancel: "addConfigCancel",
    addConfigName: "addConfigName",

    compilerPath: "compilerPath",
    compilerPathInvalid: "compilerPathInvalid",
    knownCompilers: "knownCompilers",

    intelliSenseMode: "intelliSenseMode",
    intelliSenseModeInvalid: "intelliSenseModeInvalid",
    includePath: "includePath",
    includePathInvalid: "includePathInvalid",
    defines: "defines",
    cStandard: "cStandard",
    cppStandard: "cppStandard",

    // Advanced settings
    windowsSdkVersion: "windowsSdkVersion",
    macFrameworkPath: "macFrameworkPath",
    macFrameworkPathInvalid: "macFrameworkPathInvalid",
    compileCommands: "compileCommands",
    compileCommandsInvalid: "compileCommandsInvalid",
    configurationProvider: "configurationProvider",
    forcedInclude: "forcedInclude",
    forcedIncludeInvalid: "forcedIncludeInvalid",

    // Browse properties
    browsePath: "browsePath",
    browsePathInvalid: "browsePathInvalid",
    limitSymbolsToIncludedHeaders: "limitSymbolsToIncludedHeaders",
    databaseFilename: "databaseFilename",
    databaseFilenameInvalid: "databaseFilenameInvalid",

    // Other
    showAdvanced: "showAdvanced",
    advancedSection: "advancedSection"
};

interface VsCodeApi {
    postMessage(msg: {}): void;
    setState(state: {}): void;
    getState(): {};
}

declare function acquireVsCodeApi(): VsCodeApi;

class SettingsApp {
    private readonly vsCodeApi: VsCodeApi;
    private updating: boolean = false;

    constructor() {
        this.vsCodeApi = acquireVsCodeApi();

        window.addEventListener("keydown", this.onTabKeyDown.bind(this));
        window.addEventListener("message", this.onMessageReceived.bind(this));

        // Add event listeners to UI elements
        this.addEventsToConfigNameChanges();
        this.addEventsToInputValues();
        document.getElementById(elementId.knownCompilers).addEventListener("change", this.onKnownCompilerSelect.bind(this));

        // Set view state of advanced settings and add event
        const oldState: any = this.vsCodeApi.getState();
        const advancedShown: boolean = (oldState && oldState.advancedShown);
        document.getElementById(elementId.advancedSection).style.display = advancedShown ? "block" : "none";
        document.getElementById(elementId.showAdvanced).classList.toggle(advancedShown ? "collapse" : "expand", true);
        document.getElementById(elementId.showAdvanced).addEventListener("click", this.onShowAdvanced.bind(this));
    }

    private addEventsToInputValues(): void {
        const elements: NodeListOf<HTMLElement> = document.getElementsByName("inputValue");
        elements.forEach(el => {
            el.addEventListener("change", this.onChanged.bind(this, el.id));
        });

        // Special case for checkbox element
        document.getElementById(elementId.limitSymbolsToIncludedHeaders).addEventListener("change", this.onChangedCheckbox.bind(this, elementId.limitSymbolsToIncludedHeaders));
    }

    private addEventsToConfigNameChanges(): void {
        document.getElementById(elementId.configName).addEventListener("change", this.onConfigNameChanged.bind(this));
        document.getElementById(elementId.configSelection).addEventListener("change", this.onConfigSelect.bind(this));
        document.getElementById(elementId.addConfigBtn).addEventListener("click", this.onAddConfigBtn.bind(this));
        document.getElementById(elementId.addConfigOk).addEventListener("click", this.OnAddConfigConfirm.bind(this, true));
        document.getElementById(elementId.addConfigCancel).addEventListener("click", this.OnAddConfigConfirm.bind(this, false));
    }

    private onTabKeyDown(e: any): void {
        if (e.keyCode === 9) {
            document.body.classList.add("tabbing");
            window.removeEventListener("keydown", this.onTabKeyDown);
            window.addEventListener("mousedown", this.onMouseDown.bind(this));
        }
    }

    private onMouseDown(): void {
        document.body.classList.remove("tabbing");
        window.removeEventListener("mousedown", this.onMouseDown);
        window.addEventListener("keydown", this.onTabKeyDown.bind(this));
    }

    private onShowAdvanced(): void {
        const isShown: boolean = (document.getElementById(elementId.advancedSection).style.display === "block");
        document.getElementById(elementId.advancedSection).style.display = isShown ? "none" : "block";

        // Save view state
        this.vsCodeApi.setState({ advancedShown: !isShown });

        // Update chevron on button
        const element: HTMLElement = document.getElementById(elementId.showAdvanced);
        element.classList.toggle("collapse");
        element.classList.toggle("expand");
    }

    private onAddConfigBtn(): void {
        this.showElement(elementId.addConfigDiv, false);
        this.showElement(elementId.addConfigInputDiv, true);
    }

    private OnAddConfigConfirm(request: boolean): void {
        this.showElement(elementId.addConfigInputDiv, false);
        this.showElement(elementId.addConfigDiv, true);

        // If request is yes, send message to create new config
        if (request) {
            const el: HTMLInputElement = <HTMLInputElement>document.getElementById(elementId.addConfigName);
            if (el.value !== undefined && el.value !== "") {
                this.vsCodeApi.postMessage({
                    command: "addConfig",
                    name: el.value
                });

                el.value = "";
            }
        }
    }

    private onConfigNameChanged(): void {
        if (this.updating) {
            return; 
        }

        const configName: HTMLInputElement = <HTMLInputElement>document.getElementById(elementId.configName);
        let list: HTMLSelectElement = <HTMLSelectElement>document.getElementById(elementId.configSelection);

        if (configName.value === "") {
            (<HTMLInputElement>document.getElementById(elementId.configName)).value = list.options[list.selectedIndex].value;
            return;
        }

        // Update name on selection
        list.options[list.selectedIndex].value = configName.value;
        list.options[list.selectedIndex].text = configName.value;

        this.onChanged(elementId.configName);
    }

    private onConfigSelect(): void {
        if (this.updating) {
            return; 
        }

        const el: HTMLSelectElement = <HTMLSelectElement>document.getElementById(elementId.configSelection);
        (<HTMLInputElement>document.getElementById(elementId.configName)).value = el.value;

        this.vsCodeApi.postMessage({
            command: "configSelect",
            index: el.selectedIndex
        });
    }

    private onKnownCompilerSelect(): void {
        if (this.updating) {
            return; 
        }
        const el: HTMLInputElement = <HTMLInputElement>document.getElementById(elementId.knownCompilers);
        (<HTMLInputElement>document.getElementById(elementId.compilerPath)).value = el.value;
        this.onChanged(elementId.compilerPath);

        // Post message that this control was used for telemetry
        this.vsCodeApi.postMessage({
            command: "knownCompilerSelect"
        });

        // Reset selection to none
        el.value = "";
    }
    private onChangedCheckbox(id: string): void {
        if (this.updating) {
            return; 
        }

        const el: HTMLInputElement = <HTMLInputElement>document.getElementById(id);
        this.vsCodeApi.postMessage({
            command: "change",
            key: id,
            value: el.checked
        });
    }

    private onChanged(id: string): void {
        if (this.updating) {
            return; 
        }

        const el: HTMLInputElement = <HTMLInputElement>document.getElementById(id);
        this.vsCodeApi.postMessage({
            command: "change",
            key: id,
            value: el.value
        });
    }

    private onMessageReceived(e: MessageEvent): void {
        const message: any = e.data; // The json data that the extension sent
        switch (message.command) {
            case 'updateConfig':
                this.updateConfig(message.config);
                break;
            case 'updateErrors':
                this.updateErrors(message.errors);
                break;
            case 'setKnownCompilers':
                this.setKnownCompilers(message.compilers);
                break;
            case 'updateConfigSelection':
                this.updateConfigSelection(message);
                break;
        }
    }

    private updateConfig(config: any): void {
        this.updating = true;
        try {
            // Basic settings
            (<HTMLInputElement>document.getElementById(elementId.configName)).value = config.name;
            (<HTMLInputElement>document.getElementById(elementId.compilerPath)).value = config.compilerPath ? config.compilerPath : "";
            (<HTMLInputElement>document.getElementById(elementId.intelliSenseMode)).value = config.intelliSenseMode ? config.intelliSenseMode : "${default}";

            (<HTMLInputElement>document.getElementById(elementId.includePath)).value = 
                (config.includePath && config.includePath.length > 0) ? config.includePath.join("\n") : "";

            (<HTMLInputElement>document.getElementById(elementId.defines)).value = 
                (config.defines && config.defines.length > 0 ) ? config.defines.join("\n") : "";

            (<HTMLInputElement>document.getElementById(elementId.cStandard)).value = config.cStandard;
            (<HTMLInputElement>document.getElementById(elementId.cppStandard)).value = config.cppStandard;

            // Advanced settings
            (<HTMLInputElement>document.getElementById(elementId.windowsSdkVersion)).value = config.windowsSdkVersion ? config.windowsSdkVersion : "";

            (<HTMLInputElement>document.getElementById(elementId.macFrameworkPath)).value =
                (config.macFrameworkPath && config.macFrameworkPath.length > 0) ? config.macFrameworkPath.join("\n") : "";

            (<HTMLInputElement>document.getElementById(elementId.compileCommands)).value = config.compileCommands ? config.compileCommands : "";
            (<HTMLInputElement>document.getElementById(elementId.configurationProvider)).value = config.configurationProvider ? config.configurationProvider : "";

            (<HTMLInputElement>document.getElementById(elementId.forcedInclude)).value =
                (config.forcedInclude && config.forcedInclude.length > 0) ? config.forcedInclude.join("\n") : "";

            if (config.browse) {
                (<HTMLInputElement>document.getElementById(elementId.browsePath)).value =
                    (config.browse.path && config.browse.path.length > 0) ? config.browse.path.join("\n") : "";
                (<HTMLInputElement>document.getElementById(elementId.limitSymbolsToIncludedHeaders)).checked = 
                    (config.browse.limitSymbolsToIncludedHeaders && config.browse.limitSymbolsToIncludedHeaders);
                (<HTMLInputElement>document.getElementById(elementId.databaseFilename)).value = config.browse.databaseFilename ? config.browse.databaseFilename : "";
            } else {
                (<HTMLInputElement>document.getElementById(elementId.browsePath)).value = "";
                (<HTMLInputElement>document.getElementById(elementId.limitSymbolsToIncludedHeaders)).checked = false;
                (<HTMLInputElement>document.getElementById(elementId.databaseFilename)).value = "";
            }
        } finally {
            this.updating = false;
        }
    }

    private updateErrors(errors: any): void {
        this.updating = true;
        try {
            this.showErrorWithInfo(elementId.intelliSenseModeInvalid, errors.intelliSenseMode);
            this.showErrorWithInfo(elementId.compilerPathInvalid, errors.compilerPath);
            this.showErrorWithInfo(elementId.includePathInvalid, errors.includePath);
            this.showErrorWithInfo(elementId.macFrameworkPathInvalid, errors.macFrameworkPath);
            this.showErrorWithInfo(elementId.forcedIncludeInvalid, errors.forcedInclude);
            this.showErrorWithInfo(elementId.compileCommandsInvalid, errors.compileCommands);
            this.showErrorWithInfo(elementId.browsePathInvalid, errors.browsePath);
            this.showErrorWithInfo(elementId.databaseFilenameInvalid, errors.databaseFilename);
        } finally {
            this.updating = false;
        }
    }

    private showErrorWithInfo(elementID: string, errorInfo: string): void {
        this.showElement(elementID, errorInfo ? true : false);
        document.getElementById(elementID).innerHTML = errorInfo ? errorInfo : "";
    }

    private updateConfigSelection(message: any): void {
        this.updating = true;
        try {
            let list: HTMLSelectElement = <HTMLSelectElement>document.getElementById(elementId.configSelection);

            // Clear list before updating
            list.options.length = 0;

            // Update list
            for (let name of message.selections) {
                let option: HTMLOptionElement = document.createElement("option");
                option.text = name;
                option.value = name;
                list.append(option);
            }

            list.selectedIndex = message.selectedIndex;
        } finally {
            this.updating = false;
        }
    }

    private setKnownCompilers(compilers: string[]): void {
        this.updating = true;
        try {
            let list: HTMLSelectElement = <HTMLSelectElement>document.getElementById(elementId.knownCompilers);

            // No need to add items unless webview is reloaded, in which case it will not have any elements.
            // Otherwise, add items again.
            if (list.firstChild) {
               return;
            }
    
            if (compilers.length === 0) {
                const noCompilers: string = "(No compiler paths detected)";
                let option: HTMLOptionElement = document.createElement("option");
                option.text = noCompilers;
                option.value = noCompilers;
                list.append(option);

                // Set the selection to this one item so that no selection change event will be fired
                list.value = noCompilers;
                return;
            }
    
            for (let path of compilers) {
                let option: HTMLOptionElement = document.createElement("option");
                option.text = path;
                option.value = path;
                list.append(option);
            }

            // Initialize list with no selected item
            list.value = "";
        } finally {
            this.updating = false;
        }
    }

    private showElement(elementID: string, show: boolean): void {
        document.getElementById(elementID).style.display = show ? "block" : "none";
    }
}

let app: SettingsApp = new SettingsApp();
