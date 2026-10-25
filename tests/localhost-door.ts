// A byte tunnel keeps the browser at the real WebAuthn relying-party origin
// while the disposable stack remains on its isolated compose network.
export function localhostDoor(target: string) {
  const upstream = new URL(target);
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const connections = new Set<Deno.TcpConn>();
  const relays: Promise<void>[] = [];
  const failures: unknown[] = [];
  let stopping = false;
  const close = (connection: Deno.TcpConn) => {
    if (connections.delete(connection)) connection.close();
  };
  const accepted = (async () => {
    try {
      for await (const incoming of listener) {
        connections.add(incoming);
        const relay = async () => {
          let outgoing: Deno.TcpConn | undefined;
          let ending = false;
          try {
            outgoing = await Deno.connect({ hostname: upstream.hostname, port: Number(upstream.port || 443) });
            connections.add(outgoing);
            if (stopping) return;
            const pump = async (source: Deno.TcpConn, sink: Deno.TcpConn) => {
              let reading = true;
              try {
                const buffer = new Uint8Array(64 * 1024);
                for (;;) {
                  reading = true;
                  const size = await source.read(buffer);
                  if (size === null) return;
                  reading = false;
                  for (let offset = 0; offset < size;) offset += await sink.write(buffer.subarray(offset, size));
                }
              } catch (error) {
                // Navigation may reset the browser's socket before the context
                // closes; a reset from Caddy still fails the regression.
                const disconnected = error instanceof Deno.errors.ConnectionReset || error instanceof Deno.errors.BrokenPipe;
                const browserCanceled = (reading ? source : sink) === incoming && disconnected;
                const closedHere = (ending || stopping) && (disconnected ||
                  error instanceof Deno.errors.BadResource || error instanceof Deno.errors.Interrupted);
                if (!(browserCanceled || closedHere)) throw error;
              } finally {
                ending = true;
                close(source);
                close(sink);
              }
            };
            const results = await Promise.allSettled([pump(incoming, outgoing), pump(outgoing, incoming)]);
            for (const result of results) if (result.status === "rejected") failures.push(result.reason);
          } finally {
            close(incoming);
            if (outgoing) close(outgoing);
          }
        };
        relays.push(relay().catch(error => { failures.push(error); }));
      }
    } catch (error) {
      if (!(stopping && error instanceof Deno.errors.BadResource)) throw error;
    }
  })();
  return {
    origin: `https://localhost:${(listener.addr as Deno.NetAddr).port}`,
    async close() {
      stopping = true;
      listener.close();
      for (const connection of connections) close(connection);
      await accepted;
      await Promise.all(relays);
      if (failures.length) throw new AggregateError(failures, "localhost WebAuthn tunnel failed");
    },
  };
}
