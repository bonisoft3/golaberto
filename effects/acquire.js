// The transport answers every fetch it attempted as one object: the
// provider's status, the hops it followed and the requests they cost. A
// non-200 from the transport itself means no fetch was attempted.
export async function issue(input, sink) {
  const r = await sink.fetch("/fetch", { method: "POST", body: { id: input.id, path: input.path } });
  if (r.status !== 200) throw new Error(`sofascore transport answered ${r.status}`);
  if (r.body.status === 200 && r.body.error == null) return { done: r.body };
  return { failed: r.body };
}
