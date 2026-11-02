// The hub's side of a deploy with no gap (#523). serve --follow runs the hub as a child with an IPC channel and
// NUWORQ_HANDOFF=1: the supervisor owns the public port and passes each accepted connection to the newest hub that
// is ready (like node:cluster, but a new hub can start beside the old one, from another worktree). The hub listens
// only on a private loopback port, for the supervisor's health check, and says so with { type: 'ready', port, commit };
// NUWORQ_COMMIT is the commit it was started on, so the supervisor checks it is the code it meant to run.
// Messages in: { type: 'conn' } + a socket (serve it), 'lead' (run the background loops: sweeper, Notifier, pull-request
// merges, mirror fetches), 'quiet' (stop them), 'drain' (finish what is in flight, then exit). Out: 'ready', and
// { type: 'loops', on } after lead and quiet. The channel closing (the supervisor died) drains the hub too.
export const handedOver = () => !!process.env.NUWORQ_HANDOFF && typeof process.send === 'function';

// server: createServer's, made with standby: true. lead() and quiet() run besides the server's own loops (the Notifier
// and the pushes live in the CLI). stop(): drain, then exit.
export function handoff(server, { lead = () => {}, quiet = () => {}, stop }) {
  server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port, commit: process.env.NUWORQ_COMMIT || null }));
  process.on('message', (m, socket) => {
    if (m?.type === 'conn' && socket) server.adopt(socket);
    else if (m?.type === 'lead') { server.lead(); lead(); process.send({ type: 'loops', on: true }); }
    else if (m?.type === 'quiet') { server.quiet(); quiet(); process.send({ type: 'loops', on: false }); }
    else if (m?.type === 'drain') stop();
  });
  process.on('disconnect', () => stop());
}
