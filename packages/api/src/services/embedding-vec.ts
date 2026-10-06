/**
 * The BLOB ↔ Float32Array codec and unit-normalisation shared by every reader
 * of `library_embeddings` and the centroid tables derived from it.
 */

/** Decode a stored BLOB back into a Float32Array (copy — the BLOB is a view). */
export function decodeVec(vec: Uint8Array): Float32Array {
  // Copy so the backing buffer is exactly the vector's bytes and 4-byte aligned.
  const bytes = Uint8Array.from(vec);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

export function encodeVec(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** In-place L2 normalisation; false when the vector is all zeros (unusable). */
export function normalise(v: Float32Array): boolean {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  if (n === 0) return false;
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < v.length; i++) v[i]! *= inv;
  return true;
}
