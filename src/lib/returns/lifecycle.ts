/**
 * The return lifecycle — the same table the app's src/shared/transitions.ts
 * renders, enforced here:
 *
 *   Requested → Under Review → (Info Requested) → Approved · RMA Issued
 *             → Received → Inspected → Credited          — or → Rejected
 */
export const STATUS_REQUESTED = "Requested";
export const STATUS_UNDER_REVIEW = "Under Review";
export const STATUS_INFO_REQUESTED = "Info Requested";
export const STATUS_APPROVED = "Approved · RMA Issued";
export const STATUS_RECEIVED = "Received";
export const STATUS_INSPECTED = "Inspected";
export const STATUS_CREDITED = "Credited";
export const STATUS_REJECTED = "Rejected";
/** History-only label: the customer answered an Info Requested. */
export const HISTORY_INFO_PROVIDED = "Info Provided";

export const ALL_STATUSES = [
  STATUS_REQUESTED,
  STATUS_UNDER_REVIEW,
  STATUS_INFO_REQUESTED,
  STATUS_APPROVED,
  STATUS_RECEIVED,
  STATUS_INSPECTED,
  STATUS_CREDITED,
  STATUS_REJECTED,
] as const;

export type ReturnAction =
  | "approve"
  | "requestInfo"
  | "reject"
  | "received"
  | "inspected"
  | "credit";

const REVIEW_STATES = [
  STATUS_REQUESTED,
  STATUS_UNDER_REVIEW,
  STATUS_INFO_REQUESTED,
];

const TRANSITIONS: Record<ReturnAction, { from: string[]; to: string }> = {
  approve: { from: REVIEW_STATES, to: STATUS_APPROVED },
  requestInfo: { from: REVIEW_STATES, to: STATUS_INFO_REQUESTED },
  reject: { from: REVIEW_STATES, to: STATUS_REJECTED },
  received: { from: [STATUS_APPROVED], to: STATUS_RECEIVED },
  inspected: { from: [STATUS_RECEIVED], to: STATUS_INSPECTED },
  credit: { from: [STATUS_INSPECTED], to: STATUS_CREDITED },
};

export function isReturnAction(value: unknown): value is ReturnAction {
  return typeof value === "string" && Object.hasOwn(TRANSITIONS, value);
}

export function transitionOf(action: ReturnAction) {
  return TRANSITIONS[action];
}

/** Actions whose customer-visible message is required. */
export function actionNeedsMessage(action: ReturnAction): boolean {
  return action === "requestInfo" || action === "reject";
}
