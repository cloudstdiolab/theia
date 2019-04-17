/********************************************************************************
 * Copyright (C) 2019 Ericsson and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

// tslint:disable:no-any

import { inject, injectable, postConstruct } from 'inversify';
import URI from '@theia/core/lib/common/uri';
import { PreferenceProvider } from '@theia/core/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { PreferenceConfigurations } from '@theia/core/lib/browser/preferences/preference-configurations';
import { FolderPreferenceProvider, FolderPreferenceProviderFactory, FolderPreferenceProviderOptions } from './folder-preference-provider';

@injectable()
export class FoldersPreferencesProvider extends PreferenceProvider {

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(FolderPreferenceProviderFactory)
    protected readonly folderPreferenceProviderFactory: FolderPreferenceProviderFactory;

    @inject(PreferenceConfigurations)
    protected readonly configurations: PreferenceConfigurations;

    protected readonly providers = new Map<string, FolderPreferenceProvider>();

    @postConstruct()
    protected async init(): Promise<void> {
        await this.workspaceService.roots;

        this.updateProviders();
        this.workspaceService.onWorkspaceChanged(() => this.updateProviders());

        const readyPromises: Promise<void>[] = [];
        for (const provider of this.providers.values()) {
            readyPromises.push(provider.ready.catch(e => console.error(e)));
        }
        Promise.all(readyPromises).then(() => this._ready.resolve());
    }

    protected updateProviders(): void {
        const roots = this.workspaceService.tryGetRoots();
        const toDelete = new Set(this.providers.keys());
        for (const folder of roots) {
            for (const configUri of this.configurations.getUris(new URI(folder.uri))) {
                const key = configUri.toString();
                toDelete.delete(key);
                if (!this.providers.has(key)) {
                    const provider = this.createProvider({ folder, configUri });
                    this.providers.set(key, provider);
                }
            }
        }
        for (const key of toDelete) {
            const provider = this.providers.get(key);
            if (provider) {
                this.providers.delete(key);
                provider.dispose();
            }
        }
    }

    getConfigUri(resourceUri?: string): URI | undefined {
        for (const provider of this.providers.values()) {
            const configUri = provider.getConfigUri(resourceUri);
            if (this.configurations.isConfigUri(configUri)) {
                return configUri;
            }
        }
        return undefined;
    }

    getDomain(): string[] {
        return this.workspaceService.tryGetRoots().map(root => root.uri);
    }

    resolve<T>(preferenceName: string, resourceUri?: string): { value?: T, configUri?: URI } {
        for (const provider of this.getProviders(resourceUri)) {
            const { value, configUri } = provider.resolve(preferenceName, resourceUri);
            if (value !== undefined && configUri) {
                return { value, configUri };
            }
        }
        return {};
    }

    getPreferences(resourceUri?: string): { [p: string]: any } {
        const result = {};
        const collectedConfigs = new Set<string>();
        for (const provider of this.getProviders(resourceUri).reverse()) {
            const configUri = provider.getConfigUri(resourceUri);
            if (configUri) {
                const configName = this.configurations.getName(configUri);
                if (!collectedConfigs.has(configName)) {
                    collectedConfigs.add(configName);
                    const preferences = provider.getPreferences();
                    Object.assign(result, preferences);
                }
            }
        }
        return result;
    }

    async setPreference(preferenceName: string, value: any, resourceUri?: string): Promise<boolean> {
        const sectionName = preferenceName.split('.', 1)[0];
        const configName = this.configurations.isSectionName(sectionName) ? sectionName : this.configurations.getConfigName();

        const providers = this.getProviders(resourceUri);
        let configPath: string | undefined;

        const iterator: (() => FolderPreferenceProvider | undefined)[] = [];
        for (const provider of providers) {
            if (configPath === undefined) {
                const configUri = provider.getConfigUri(resourceUri);
                if (configUri) {
                    configPath = this.configurations.getPath(configUri);
                }
            }
            if (this.configurations.getName(provider.getConfigUri()) === configName) {
                iterator.push(() => {
                    if (provider.getConfigUri(resourceUri)) {
                        return provider;
                    }
                    iterator.push(() => {
                        if (this.configurations.getPath(provider.getConfigUri()) === configPath) {
                            return provider;
                        }
                        iterator.push(() => provider);
                    });
                });
            }
        }

        let next = iterator.shift();
        while (next) {
            const provider = next();
            if (provider) {
                if (await provider.setPreference(preferenceName, value, resourceUri)) {
                    return true;
                }
            }
            next = iterator.shift();
        }
        return false;
    }

    protected getProviders(resourceUri?: string): FolderPreferenceProvider[] {
        if (!resourceUri) {
            return [];
        }
        const resourcePath = new URI(resourceUri).path;
        let folder: Readonly<{ relativity: number, uri?: string }> = { relativity: -1 };
        const providers = new Map<string, FolderPreferenceProvider[]>();
        for (const provider of this.providers.values()) {
            const uri = provider.folderUri.toString();
            const folderProviders = (providers.get(uri) || []);
            folderProviders.push(provider);
            providers.set(uri, folderProviders);

            const relativity = provider.folderUri.path.relativity(resourcePath);
            if (relativity >= 0 && folder.relativity <= relativity) {
                folder = { relativity, uri };
            }
        }
        return folder.uri && providers.get(folder.uri) || [];
    }

    protected createProvider(options: FolderPreferenceProviderOptions): FolderPreferenceProvider {
        const provider = this.folderPreferenceProviderFactory(options);
        this.toDispose.push(provider);
        this.toDispose.push(provider.onDidPreferencesChanged(change => this.onDidPreferencesChangedEmitter.fire(change)));
        return provider;
    }

}
