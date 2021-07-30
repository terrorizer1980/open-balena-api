import type { Application, Request } from 'express';
import type StrictEventEmitter from 'strict-event-emitter-types';

import { EventEmitter } from 'events';
import { apiKeyMiddleware } from '../../infra/auth';

import { gracefullyDenyDeletedDevices } from './middleware';
import { stateV2 } from './routes/state-v2';
import { stateV3 } from './routes/state-v3';
import { statePatchV2 } from './routes/state-patch-v2';
import { statePatchV3 } from './routes/state-patch-v3';

export { setReadTransaction } from './utils';

export const setup = (app: Application) => {
	app.get(
		'/device/v2/:uuid/state',
		gracefullyDenyDeletedDevices,
		apiKeyMiddleware,
		stateV2,
	);
	app.get('/device/v3/:uuid/state', apiKeyMiddleware, stateV3);
	app.patch(
		'/device/v2/:uuid/state',
		gracefullyDenyDeletedDevices,
		apiKeyMiddleware,
		statePatchV2,
	);
	app.patch('/device/v3/state', apiKeyMiddleware, statePatchV3);
};

export interface Events {
	'get-state': (uuid: string, req: Pick<Request, 'apiKey'>) => void;
}
export const events: StrictEventEmitter<EventEmitter, Events> =
	new EventEmitter();
