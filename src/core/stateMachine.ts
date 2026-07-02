// Açık lead state machine — kod tanımsız geçişi reddeder (sessiz-bozulmayı önler).
export const LEAD_TRANSITIONS: Record<string, string[]> = {
  new: ["verified", "suppressed", "dead"],
  verified: ["enriched", "suppressed", "dead"],
  enriched: ["drafted", "suppressed", "dead"],
  drafted: ["queued", "suppressed", "dead"],
  queued: ["sent", "suppressed", "dead"],
  sent: ["replied", "suppressed"],
  replied: ["hot", "suppressed"],
  hot: ["suppressed"],
  suppressed: [],
  dead: [],
};

export function assertLeadTransition(from: string, to: string): void {
  const allowed = LEAD_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`illegal lead transition: ${from} -> ${to}`);
  }
}
