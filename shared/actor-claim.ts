/** One runtime session's claim on an actor. Writes fail after its epoch changes. */
export interface Claim { actor: string; session: string; epoch: number }
