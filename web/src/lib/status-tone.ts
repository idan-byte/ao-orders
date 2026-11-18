// The colour of a status, the same on every screen. The colour says where something stands at a glance; the
// words say what it is, so a colour is never the only way to tell a status apart.
//   neutral  nothing has happened yet, or it is closed without a result
//   waiting  someone else has to act: a customer, an approval, a delay
//   info     it is moving inside the factory: approved, in production
//   active   it is ready or on its way to the customer
//   done     finished well
//   problem  it needs a person now
export type Tone = "neutral" | "waiting" | "info" | "active" | "done" | "problem";

const DELIVERY: Record<string, Tone> = {
  draft: "neutral",
  pending_approval: "waiting",
  approved: "info",
  in_production: "info",
  ready_to_ship: "active",
  shipped: "active",
  delivered: "done",
  partially_delivered: "done",
  exception: "problem",
  delayed: "waiting",
  cancelled: "neutral",
};

const QUOTE: Record<string, Tone> = {
  draft: "neutral",
  sent: "waiting",
  follow_up: "waiting",
  approved: "done",
  rejected: "problem",
  expired: "problem",
};

const LEAD: Record<string, Tone> = {
  new: "info",
  quote_in_progress: "info",
  sent: "waiting",
  follow_up: "waiting",
  won: "done",
  lost: "neutral",
};

export const deliveryTone = (status: string): Tone => DELIVERY[status] ?? "neutral";
export const quoteTone = (status: string): Tone => QUOTE[status] ?? "neutral";
export const leadTone = (stage: string): Tone => LEAD[stage] ?? "neutral";
