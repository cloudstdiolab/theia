/********************************************************************************
 * Copyright (C) 2018 TypeFox and others.
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

import { injectable, inject, postConstruct } from 'inversify';
import { JsonSchemaStore } from '@theia/core/lib/browser/json-schema-store';
import { InMemoryResources, deepClone } from '@theia/core/lib/common';
import { IJSONSchema } from '@theia/core/lib/common/json-schema';
import URI from '@theia/core/lib/common/uri';
import { DebugService } from '../common/debug-service';
import { debugPreferencesSchema } from './debug-preferences';
import { DebugConfigurationManager } from './debug-configuration-manager';

@injectable()
export class DebugSchemaUpdater {

    @inject(JsonSchemaStore) protected readonly jsonSchemaStore: JsonSchemaStore;
    @inject(InMemoryResources) protected readonly inmemoryResources: InMemoryResources;
    @inject(DebugService) protected readonly debug: DebugService;

    @inject(DebugConfigurationManager)
    protected readonly configurations: DebugConfigurationManager;

    @postConstruct()
    protected init(): void {
        this.update();
        this.configurations.onDidChange(() => this.update());
    }

    async update(): Promise<void> {
        const types = await this.debug.debugTypes();
        const schema = { ...deepClone(launchSchema) };
        const items = (<IJSONSchema>schema!.properties!['configurations'].items);

        const attributePromises = types.map(type => this.debug.getSchemaAttributes(type));
        for (const attributes of await Promise.all(attributePromises)) {
            for (const attribute of attributes) {
                const properties: typeof attribute['properties'] = {};
                for (const key of ['debugViewLocation', 'openDebug', 'internalConsoleOptions']) {
                    properties[key] = debugPreferencesSchema.properties[`debug.${key}`];
                }
                attribute.properties = Object.assign(properties, attribute.properties);
                items.oneOf!.push(attribute);
            }
        }
        items.defaultSnippets!.push(...await this.debug.getConfigurationSnippets());

        const compoundConfigurationSchema = (schema.properties!.compounds.items as IJSONSchema).properties!.configurations;

        const uniqueFolderNames = new Set<string>();
        const uniqueLaunchNames = new Set<string>();
        for (const configuration of this.configurations.all) {
            if (configuration.workspaceFolderUri) {
                uniqueFolderNames.add(new URI(configuration.workspaceFolderUri).path.name);
            }
            // TODO exclude compounds
            uniqueLaunchNames.add(configuration.configuration.name);
        }

        const folderNames = [...uniqueFolderNames];
        const launchNames = [...uniqueLaunchNames];
        (compoundConfigurationSchema.items as IJSONSchema).oneOf![0].enum = launchNames;
        (compoundConfigurationSchema.items as IJSONSchema).oneOf![1].properties!.name.enum = launchNames;
        (compoundConfigurationSchema.items as IJSONSchema).oneOf![1].properties!.folder.enum = folderNames;

        const uri = new URI(launchSchemaId);
        const contents = JSON.stringify(schema);
        try {
            this.inmemoryResources.update(uri, contents);
        } catch (e) {
            this.inmemoryResources.add(uri, contents);
            this.jsonSchemaStore.registerSchema({
                fileMatch: ['launch.json'],
                url: uri.toString()
            });
        }
    }
}

// debug general schema
const defaultCompound = { name: 'Compound', configurations: [] };

export const launchSchemaId = 'vscode://schemas/launch';
const launchSchema: IJSONSchema = {
    $id: launchSchemaId,
    type: 'object',
    title: 'Launch',
    required: [],
    default: { version: '0.2.0', configurations: [], compounds: [] },
    properties: {
        version: {
            type: 'string',
            description: 'Version of this file format.',
            default: '0.2.0'
        },
        configurations: {
            type: 'array',
            description: 'List of configurations. Add new configurations or edit existing ones by using IntelliSense.',
            items: {
                defaultSnippets: [],
                'type': 'object',
                oneOf: []
            }
        },
        compounds: {
            type: 'array',
            description: 'List of compounds. Each compound references multiple configurations which will get launched together.',
            items: {
                type: 'object',
                required: ['name', 'configurations'],
                properties: {
                    name: {
                        type: 'string',
                        description: 'Name of compound. Appears in the launch configuration drop down menu.'
                    },
                    configurations: {
                        type: 'array',
                        default: [],
                        items: {
                            oneOf: [{
                                enum: [],
                                description: 'Please use unique configuration names.'
                            }, {
                                type: 'object',
                                required: ['name'],
                                properties: {
                                    name: {
                                        enum: [],
                                        description: 'Name of compound. Appears in the launch configuration drop down menu.'
                                    },
                                    folder: {
                                        enum: [],
                                        description: 'Name of folder in which the compound is located.'
                                    }
                                }
                            }]
                        },
                        description: 'Names of configurations that will be started as part of this compound.'
                    }
                },
                default: defaultCompound
            },
            default: [
                defaultCompound
            ]
        }
    }
};
