import { Actor, log } from 'apify';
import { sanitize } from './egrid.js';
import { runActor } from './run.js';

try {
    await Actor.init();
    const pushed = await runActor((await Actor.getInput()) ?? {}, {
        actor: Actor,
        warn: (message) => log.warning(message),
    });
    log.info('Saved ' + pushed + ' emission factors.');
    await Actor.exit();
} catch (error) {
    const message = sanitize(error?.message ?? error);
    log.error(message);
    await Actor.fail(message);
}
