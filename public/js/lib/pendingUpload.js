// Hands a recorded clip (e.g. from the Duet/Stitch studio) to the upload page without a round trip.
let pending = null;
export const setPendingUpload = (p) => { pending = p; };
export const takePendingUpload = () => { const p = pending; pending = null; return p; };
