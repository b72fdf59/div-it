import { from, load, save } from "@automerge/automerge";

export function persistedRoundTrip(document) {
  return load(save(from(document)));
}
