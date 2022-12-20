/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Queue } from 'vs/base/common/async';
import { VSBuffer } from 'vs/base/common/buffer';
import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter, Event } from 'vs/base/common/event';
import { ResourceMap } from 'vs/base/common/map';
import { URI, UriComponents } from 'vs/base/common/uri';
import { Metadata } from 'vs/platform/extensionManagement/common/extensionManagement';
import { areSameExtensions } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { IExtension, IExtensionIdentifier, isIExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { FileOperationResult, IFileService, toFileOperationResult } from 'vs/platform/files/common/files';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { ILogService } from 'vs/platform/log/common/log';
import { IUserDataProfilesService } from 'vs/platform/userDataProfile/common/userDataProfile';
import { IUriIdentityService } from 'vs/platform/uriIdentity/common/uriIdentity';
import { isObject, isString } from 'vs/base/common/types';
import { Schemas } from 'vs/base/common/network';

interface IStoredProfileExtension {
	identifier: IExtensionIdentifier;
	location: UriComponents | string;
	version: string;
	metadata?: Metadata;
}

export interface IScannedProfileExtension {
	readonly identifier: IExtensionIdentifier;
	readonly version: string;
	readonly location: URI;
	readonly metadata?: Metadata;
}

export interface ProfileExtensionsEvent {
	readonly extensions: readonly IScannedProfileExtension[];
	readonly profileLocation: URI;
}

export interface DidAddProfileExtensionsEvent extends ProfileExtensionsEvent {
	readonly error?: Error;
}

export interface DidRemoveProfileExtensionsEvent extends ProfileExtensionsEvent {
	readonly error?: Error;
}

export const IExtensionsProfileScannerService = createDecorator<IExtensionsProfileScannerService>('IExtensionsProfileScannerService');
export interface IExtensionsProfileScannerService {
	readonly _serviceBrand: undefined;

	readonly onAddExtensions: Event<ProfileExtensionsEvent>;
	readonly onDidAddExtensions: Event<DidAddProfileExtensionsEvent>;
	readonly onRemoveExtensions: Event<ProfileExtensionsEvent>;
	readonly onDidRemoveExtensions: Event<DidRemoveProfileExtensionsEvent>;

	scanProfileExtensions(profileLocation: URI): Promise<IScannedProfileExtension[]>;
	addExtensionsToProfile(extensions: [IExtension, Metadata | undefined][], profileLocation: URI): Promise<IScannedProfileExtension[]>;
	removeExtensionFromProfile(extension: IExtension, profileLocation: URI): Promise<void>;
}

export class ExtensionsProfileScannerService extends Disposable implements IExtensionsProfileScannerService {
	readonly _serviceBrand: undefined;

	private readonly _onAddExtensions = this._register(new Emitter<ProfileExtensionsEvent>());
	readonly onAddExtensions = this._onAddExtensions.event;

	private readonly _onDidAddExtensions = this._register(new Emitter<DidAddProfileExtensionsEvent>());
	readonly onDidAddExtensions = this._onDidAddExtensions.event;

	private readonly _onRemoveExtensions = this._register(new Emitter<ProfileExtensionsEvent>());
	readonly onRemoveExtensions = this._onRemoveExtensions.event;

	private readonly _onDidRemoveExtensions = this._register(new Emitter<DidRemoveProfileExtensionsEvent>());
	readonly onDidRemoveExtensions = this._onDidRemoveExtensions.event;

	private readonly resourcesAccessQueueMap = new ResourceMap<Queue<IScannedProfileExtension[]>>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	scanProfileExtensions(profileLocation: URI): Promise<IScannedProfileExtension[]> {
		return this.withProfileExtensions(profileLocation);
	}

	async addExtensionsToProfile(extensions: [IExtension, Metadata | undefined][], profileLocation: URI): Promise<IScannedProfileExtension[]> {
		const extensionsToRemove: IScannedProfileExtension[] = [];
		const extensionsToAdd: IScannedProfileExtension[] = [];
		try {
			await this.withProfileExtensions(profileLocation, profileExtensions => {
				const result: IScannedProfileExtension[] = [];
				for (const extension of profileExtensions) {
					if (extensions.some(([e]) => areSameExtensions(e.identifier, extension.identifier) && e.manifest.version !== extension.version)) {
						// Remove the existing extension with different version
						extensionsToRemove.push(extension);
					} else {
						result.push(extension);
					}
				}
				for (const [extension, metadata] of extensions) {
					if (!result.some(e => areSameExtensions(e.identifier, extension.identifier) && e.version === extension.manifest.version)) {
						// Add only if the same version of the extension is not already added
						const extensionToAdd = { identifier: extension.identifier, version: extension.manifest.version, location: extension.location, metadata };
						extensionsToAdd.push(extensionToAdd);
						result.push(extensionToAdd);
					}
				}
				if (extensionsToAdd.length) {
					this._onAddExtensions.fire({ extensions: extensionsToAdd, profileLocation });
				}
				if (extensionsToRemove.length) {
					this._onRemoveExtensions.fire({ extensions: extensionsToRemove, profileLocation });
				}
				return result;
			});
			if (extensionsToAdd.length) {
				this._onDidAddExtensions.fire({ extensions: extensionsToAdd, profileLocation });
			}
			if (extensionsToRemove.length) {
				this._onDidRemoveExtensions.fire({ extensions: extensionsToRemove, profileLocation });
			}
			return extensionsToAdd;
		} catch (error) {
			if (extensionsToAdd.length) {
				this._onDidAddExtensions.fire({ extensions: extensionsToAdd, error, profileLocation });
			}
			if (extensionsToRemove.length) {
				this._onDidRemoveExtensions.fire({ extensions: extensionsToRemove, error, profileLocation });
			}
			throw error;
		}
	}

	async removeExtensionFromProfile(extension: IExtension, profileLocation: URI): Promise<void> {
		const extensionsToRemove: IScannedProfileExtension[] = [];
		this._onRemoveExtensions.fire({ extensions: extensionsToRemove, profileLocation });
		try {
			await this.withProfileExtensions(profileLocation, profileExtensions => {
				const result: IScannedProfileExtension[] = [];
				for (const e of profileExtensions) {
					if (areSameExtensions(e.identifier, extension.identifier)) {
						extensionsToRemove.push(e);
					} else {
						result.push(e);
					}
				}
				if (extensionsToRemove.length) {
					this._onRemoveExtensions.fire({ extensions: extensionsToRemove, profileLocation });
				}
				return result;
			});
			if (extensionsToRemove.length) {
				this._onDidRemoveExtensions.fire({ extensions: extensionsToRemove, profileLocation });
			}
		} catch (error) {
			if (extensionsToRemove.length) {
				this._onDidRemoveExtensions.fire({ extensions: extensionsToRemove, error, profileLocation });
			}
			throw error;
		}
	}

	private async withProfileExtensions(file: URI, updateFn?: (extensions: IScannedProfileExtension[]) => IScannedProfileExtension[]): Promise<IScannedProfileExtension[]> {
		return this.getResourceAccessQueue(file).queue(async () => {
			let extensions: IScannedProfileExtension[] = [];

			// Read
			let storedProfileExtensions;
			try {
				const content = await this.fileService.readFile(file);
				storedProfileExtensions = JSON.parse(content.value.toString());
			} catch (error) {
				if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
					throw error;
				}
				// migrate from old location, remove this after couple of releases
				if (this.uriIdentityService.extUri.isEqual(file, this.userDataProfilesService.defaultProfile.extensionsResource)) {
					storedProfileExtensions = await this.migrateFromOldDefaultProfileExtensionsLocation();
				}
			}
			if (storedProfileExtensions) {
				if (!Array.isArray(storedProfileExtensions)) {
					throw new Error(`Invalid extensions content in ${file.toString()}`);
				}
				// TODO @sandy081: Remove this migration after couple of releases
				let migrate = false;
				for (const e of storedProfileExtensions) {
					if (!isStoredProfileExtension(e)) {
						throw new Error(`Invalid extensions content in ${file.toString()}`);
					}
					let location: URI;
					if (isString(e.location)) {
						location = this.resolveExtensionLocation(file, e.location);
					} else {
						location = URI.revive(e.location);
						const relativePath = this.toRelativePath(file, location);
						if (relativePath) {
							migrate = true;
							e.location = relativePath;
						}
					}
					extensions.push({
						identifier: e.identifier,
						location,
						version: e.version,
						metadata: e.metadata,
					});
				}
				if (migrate) {
					await this.fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(storedProfileExtensions)));
				}
			}

			// Update
			if (updateFn) {
				extensions = updateFn(extensions);
				const storedProfileExtensions: IStoredProfileExtension[] = extensions.map(e => ({
					identifier: e.identifier,
					version: e.version,
					location: this.toRelativePath(file, e.location) ?? e.location.toJSON(),
					metadata: e.metadata
				}));
				await this.fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(storedProfileExtensions)));
			}

			return extensions;
		});
	}

	private toRelativePath(extensionsProfileLocation: URI, extensionLocation: URI): string | undefined {
		// Extension Profile location scheme is always vscode-userdata and Extension location scheme is always file
		// Hence we need to convert the Extension Profile location scheme to file to resolve the relative path
		const parent = this.uriIdentityService.extUri.dirname(extensionsProfileLocation).with({ scheme: Schemas.file });
		if (this.uriIdentityService.extUri.isEqualOrParent(extensionLocation, parent)) {
			return this.uriIdentityService.extUri.relativePath(parent, extensionLocation);
		}
		return undefined;
	}

	private resolveExtensionLocation(extensionsProfileLocation: URI, path: string): URI {
		// Extension Profile location scheme is always vscode-userdata and Extension location scheme is always file
		// Hence we need to convert the Extension Profile location scheme to file to resolve extension location
		return this.uriIdentityService.extUri.joinPath(this.uriIdentityService.extUri.dirname(extensionsProfileLocation), path).with({ scheme: Schemas.file });
	}

	private _migrationPromise: Promise<IStoredProfileExtension[] | undefined> | undefined;
	private async migrateFromOldDefaultProfileExtensionsLocation(): Promise<IStoredProfileExtension[] | undefined> {
		if (!this._migrationPromise) {
			this._migrationPromise = (async () => {
				const oldDefaultProfileExtensionsLocation = this.uriIdentityService.extUri.joinPath(this.userDataProfilesService.defaultProfile.location, 'extensions.json');
				let content: string;
				try {
					content = (await this.fileService.readFile(oldDefaultProfileExtensionsLocation)).value.toString();
				} catch (error) {
					if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
						return undefined;
					}
					throw error;
				}

				this.logService.info('Migrating extensions from old default profile location', oldDefaultProfileExtensionsLocation.toString());
				let storedProfileExtensions: IStoredProfileExtension[] | undefined;
				try {
					const parsedData = JSON.parse(content);
					if (Array.isArray(parsedData) && parsedData.every(candidate => isStoredProfileExtension(candidate))) {
						storedProfileExtensions = parsedData;
					} else {
						this.logService.warn('Skipping migrating from old default profile locaiton: Found invalid data', parsedData);
					}
				} catch (error) {
					/* Ignore */
					this.logService.error(error);
				}

				if (storedProfileExtensions) {
					try {
						await this.fileService.createFile(this.userDataProfilesService.defaultProfile.extensionsResource, VSBuffer.fromString(JSON.stringify(storedProfileExtensions)), { overwrite: false });
						this.logService.info('Migrated extensions from old default profile location to new location', oldDefaultProfileExtensionsLocation.toString(), this.userDataProfilesService.defaultProfile.extensionsResource.toString());
					} catch (error) {
						if (toFileOperationResult(error) === FileOperationResult.FILE_MODIFIED_SINCE) {
							this.logService.info('Migration from old default profile location to new location is done by another window', oldDefaultProfileExtensionsLocation.toString(), this.userDataProfilesService.defaultProfile.extensionsResource.toString());
						} else {
							throw error;
						}
					}
				}

				try {
					await this.fileService.del(oldDefaultProfileExtensionsLocation);
				} catch (error) {
					if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
						this.logService.error(error);
					}
				}

				return storedProfileExtensions;
			})();
		}
		return this._migrationPromise;
	}

	private getResourceAccessQueue(file: URI): Queue<IScannedProfileExtension[]> {
		let resourceQueue = this.resourcesAccessQueueMap.get(file);
		if (!resourceQueue) {
			resourceQueue = new Queue<IScannedProfileExtension[]>();
			this.resourcesAccessQueueMap.set(file, resourceQueue);
		}
		return resourceQueue;
	}
}

function isStoredProfileExtension(candidate: any): candidate is IStoredProfileExtension {
	return isObject(candidate)
		&& isIExtensionIdentifier(candidate.identifier)
		&& (isUriComponents(candidate.location) || isString(candidate.location))
		&& candidate.version && isString(candidate.version);
}

function isUriComponents(thing: unknown): thing is UriComponents {
	if (!thing) {
		return false;
	}
	return isString((<any>thing).path) &&
		isString((<any>thing).scheme);
}
