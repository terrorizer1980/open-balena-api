import { expect } from './chai';
import * as nock from 'nock';
import { supertest } from './supertest';

import { VPN_SERVICE_API_KEY } from '../../src/lib/config';
import { waitFor, TimedOutError } from './common';

const registerService = async (version: string) => {
	const res = await supertest()
		.post(`/${version}/service_instance`)
		.query({ apikey: VPN_SERVICE_API_KEY })
		.expect(201);

	expect(res.body).to.have.property('id').that.is.a('number');

	return res.body.id;
};

export const connectDeviceAndWaitForUpdate = async (
	uuid: string,
	version: string,
	promiseFn: () => PromiseLike<any>,
) => {
	let updateRequested = false;

	const serviceId = await registerService(version);
	await supertest()
		.post('/services/vpn/client-connect')
		.query({ apikey: VPN_SERVICE_API_KEY })
		.send({
			common_name: uuid,
			virtual_address: '10.10.10.1',
			service_id: serviceId,
		})
		.expect(200);

	nock(`http://${uuid}.balena`)
		.post(/\/v1\/update/)
		.reply(() => {
			updateRequested = true;
			return [
				{
					statusCode: 200,
					headers: { 'content-type': 'text/plain' },
				},
				'OK',
			];
		});
	await promiseFn();

	try {
		await waitFor({
			checkFn: () => updateRequested,
		});
	} catch (err) {
		if (err instanceof TimedOutError) {
			throw new Error('Request to update device never happened');
		} else {
			throw err;
		}
	}
};
