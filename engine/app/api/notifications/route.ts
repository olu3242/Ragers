import { getEngine } from '../../../lib/engine-instance.ts';
import { jsonOk } from '../../../lib/api.ts';
import { currentActor } from '../../../lib/session.ts';
import { notificationsFor, unreadCountFor } from '../../../src/engines/notification.engine.ts';

/** A recipient reads only their own notifications. */
export const GET = async (): Promise<Response> => {
  const engine = getEngine();
  const actor = await currentActor();
  if (!actor.authenticated) return jsonOk({ notifications: [], unread: 0 });
  return jsonOk({
    notifications: await notificationsFor(engine, actor.actorId),
    unread: await unreadCountFor(engine, actor.actorId),
  });
};
