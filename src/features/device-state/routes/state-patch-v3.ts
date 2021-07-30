import type { RequestHandler } from 'express';

import * as _ from 'lodash';
import {
	captureException,
	handleHttpErrors,
} from '../../../infra/error-handling';
import { sbvrUtils, errors } from '@balena/pinejs';
import { getIP } from '../../../lib/utils';
import {
	Application,
	Device,
	Image,
	ImageInstall,
	PickDeferred,
	Release,
} from '../../../balena-model';
import { deleteOldImageInstalls, upsertImageInstall } from './state-patch-v2';

const { BadRequestError, UnauthorizedError, InternalRequestError } = errors;
const { api } = sbvrUtils;

const validPatchFields = [
	'status',
	'os_version',
	'os_variant',
	'supervisor_version',
	'provisioning_progress',
	'provisioning_state',
	'ip_address',
	'mac_address',
	'api_port',
	'api_secret',
	'logs_channel',
	'memory_usage',
	'memory_total',
	'storage_block_device',
	'storage_usage',
	'storage_total',
	'cpu_temp',
	'cpu_usage',
	'cpu_id',
	'is_undervolted',
	'is_online',
] as const;

/**
 * These typings should be used as a guide to what should be sent, but cannot be trusted as what actually *is* sent.
 */
export type StatePatchV3Body = {
	[uuid: string]: {
		name?: string;
		status?: string;
		os_version?: string; // TODO: Should these purely come from the os app?
		os_variant?: string; // TODO: Should these purely come from the os app?
		supervisor_version?: string; // TODO: Should this purely come from the supervisor app?
		provisioning_progress?: number | null; // TODO: should this be reported as part of the os app?
		provisioning_state?: string | null; // TODO: should this be reported as part of the os app?
		ip_address?: string;
		mac_address?: string;
		api_port?: number; // TODO: should this be reported as part of the supervisor app?
		api_secret?: string; // TODO: should this be reported as part of the supervisor app?
		logs_channel?: string; // TODO: should this be reported as part of the supervisor app? or should it not be reported anymore at all?
		memory_usage?: number;
		memory_total?: number;
		storage_block_device?: string;
		storage_usage?: number;
		storage_total?: number;
		cpu_temp?: number;
		cpu_usage?: number;
		cpu_id?: string;
		is_undervolted?: boolean;
		/**
		 * Used for setting dependent devices as online
		 */
		is_online?: boolean;
		/**
		 * Used for setting gateway device of dependent devices
		 */
		parent_device?: number;
		apps?: {
			[uuid: string]: {
				/**
				 * We report the overall release uuid the supervisor considers the active one, even though there may be info for multiple releases.
				 */
				release_uuid?: string;
				releases?: {
					[releaseUUID: string]: {
						services?: {
							[name: string]: {
								image: string;
								status: string;
								download_progress?: number;
							};
						};
					};
				};
			};
		};
	};
};

export const statePatchV3: RequestHandler = async (req, res) => {
	try {
		const body = req.body as StatePatchV3Body;
		const custom: AnyObject = {}; // shove custom values here to make them available to the hooks

		// forward the public ip address if the request is from the supervisor.
		if (req.apiKey != null) {
			custom.ipAddress = getIP(req);
		}

		const uuids = Object.keys(body).filter((uuid) => body[uuid] != null);
		if (uuids.length === 0) {
			throw new BadRequestError();
		}

		const appReleaseUuids: {
			[appUuid: string]: Set<string>;
		} = {};
		const imageLocations: string[] = [];
		for (const uuid of uuids) {
			const { apps } = body[uuid];
			if (apps != null) {
				for (const [
					appUuid,
					{ release_uuid: isRunningReleaseUuid, releases },
				] of Object.entries(apps)) {
					appReleaseUuids[appUuid] ??= new Set();
					if (isRunningReleaseUuid) {
						appReleaseUuids[appUuid].add(isRunningReleaseUuid);
					}
					if (releases != null) {
						for (const [releaseUuid, { services }] of Object.entries(
							releases,
						)) {
							appReleaseUuids[appUuid].add(releaseUuid);
							if (services != null) {
								for (const [, service] of Object.entries(services)) {
									imageLocations.push(service.image);
								}
							}
						}
					}
				}
			}
		}

		let devices: Array<
			Pick<Device, 'id' | 'uuid'> & {
				belongs_to__application: Array<Pick<Application, 'uuid'>>;
			}
		>;
		let images: Array<Pick<Image, 'id' | 'is_stored_at__image_location'>>;
		const appReleases: {
			[appUuid: string]: Array<Pick<Release, 'id' | 'commit'>>;
		} = {};
		await sbvrUtils.db.readTransaction(async (tx) => {
			const resinApiTx = api.resin.clone({
				passthrough: { req, custom, tx },
			});
			devices = (await resinApiTx.get({
				resource: 'device',
				options: {
					$select: ['id', 'uuid', 'belongs_to__application'],
					$filter: {
						uuid: { $in: uuids },
					},
					$expand: {
						belongs_to__application: {
							$select: 'uuid',
						},
					},
				},
			})) as Array<
				Pick<Device, 'id' | 'uuid'> & {
					belongs_to__application: Array<Pick<Application, 'uuid'>>;
				}
			>;
			if (devices.length !== uuids.length) {
				throw new UnauthorizedError();
			}

			if (imageLocations.length > 0) {
				images = (await resinApiTx.get({
					resource: 'image',
					options: {
						$select: ['id', 'is_stored_at__image_location'],
						$filter: {
							is_stored_at__image_location: { $in: imageLocations },
						},
					},
				})) as Array<Pick<Image, 'id' | 'is_stored_at__image_location'>>;
				if (imageLocations.length !== images.length) {
					throw new UnauthorizedError();
				}
			}

			for (const [appUuid, releaseUuids] of Object.entries(appReleaseUuids)) {
				appReleases[appUuid] = (await resinApiTx.get({
					resource: 'release',
					options: {
						$select: ['id', 'commit'],
						$filter: {
							commit: { $in: Array.from(releaseUuids) },
							belongs_to__application: {
								$any: {
									$alias: 'a',
									$expr: {
										a: { uuid: appUuid },
									},
								},
							},
						},
					},
				})) as Array<Pick<Release, 'id' | 'commit'>>;
				if (appReleases[appUuid].length !== releaseUuids.size) {
					throw new UnauthorizedError();
				}
			}
		});

		await sbvrUtils.db.transaction(async (tx) => {
			const resinApiTx = api.resin.clone({
				passthrough: { req, custom, tx },
			});

			const waitPromises: Array<PromiseLike<any>> = [];

			for (const uuid of uuids) {
				const state = body[uuid];

				const { apps } = state;

				const deviceBody: AnyObject = _.pick(state, validPatchFields);
				if (state.name != null) {
					deviceBody.device_name = state.name;
				}

				const device = devices.find((d) => d.uuid === uuid);
				if (device == null) {
					throw new UnauthorizedError();
				}
				const userAppUuid = device.belongs_to__application[0].uuid;
				if (apps != null) {
					const release = appReleases[userAppUuid].find(
						(r) => r.commit === apps[userAppUuid].release_uuid,
					);
					if (release) {
						deviceBody.is_running__release = release.id;
					}
				}

				if (!_.isEmpty(deviceBody)) {
					waitPromises.push(
						resinApiTx.patch({
							resource: 'device',
							id: device.id,
							options: {
								$filter: { $not: deviceBody },
							},
							body: deviceBody,
						}),
					);
				}

				if (apps != null) {
					const imgInstalls: Array<{
						imageId: number;
						releaseId: number;
						status: string;
						downloadProgress?: number;
					}> = [];
					for (const [
						appUuid,
						{
							// release_uuid: isRunningReleaseUuid,
							releases = {},
						},
					] of Object.entries(apps)) {
						// // TODO: This gets the release we are running for the given app but currently we handle the user app out of band above, and ignore supervisor/os
						// const release = releases[appUuid].find(
						// 	(r) => r.commit === isRunningReleaseUuid,
						// );
						// if (release == null) {
						// 	throw new InternalRequestError();
						// }
						for (const [releaseUuid, { services = {} }] of Object.entries(
							releases,
						)) {
							const release = appReleases[appUuid].find(
								(r) => r.commit === releaseUuid,
							);
							if (release == null) {
								throw new InternalRequestError();
							}
							for (const service of Object.values(services)) {
								const image = images.find(
									(i) => i.is_stored_at__image_location === service.image,
								);
								if (image == null) {
									throw new InternalRequestError();
								}
								imgInstalls.push({
									imageId: image.id,
									releaseId: release.id,
									status: service.status,
									downloadProgress: service.download_progress,
								});
							}
						}
					}

					const imageIds = imgInstalls.map(({ imageId }) => imageId);

					if (imageIds.length > 0) {
						waitPromises.push(
							(async () => {
								const existingImgInstalls = (await resinApiTx.get({
									resource: 'image_install',
									options: {
										$select: ['id', 'installs__image'],
										$filter: {
											device: device.id,
											installs__image: { $in: imageIds },
										},
									},
								})) as Array<
									PickDeferred<ImageInstall, 'id' | 'installs__image'>
								>;
								const existingImgInstallsByImage = _.keyBy(
									existingImgInstalls,
									({ installs__image }) => installs__image.__id,
								);

								await Promise.all(
									imgInstalls.map(async (imgInstall) => {
										await upsertImageInstall(
											resinApiTx,
											existingImgInstallsByImage[imgInstall.imageId],
											imgInstall,
											device.id,
										);
									}),
								);
							})(),
						);
					}

					waitPromises.push(
						deleteOldImageInstalls(resinApiTx, device.id, imageIds),
					);
				}
			}

			await Promise.all(waitPromises);
		});

		res.status(200).end();
	} catch (err) {
		if (handleHttpErrors(req, res, err)) {
			return;
		}
		captureException(err, 'Error setting device state', { req });
		res.sendStatus(500);
	}
};
