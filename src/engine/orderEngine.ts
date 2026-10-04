/**
 * Order money and lifecycle rules.
 *
 * Pure functions only: no React, no storage, no clock beyond what is passed in.
 * Everything here is unit tested, because this is where money and stock meet.
 *
 * BUSINESS RULES ENCODED HERE (documented deliberately -- these are decisions,
 * not incidental behaviour):
 *
 *  1. REVENUE IS RECOGNISED AT PAYMENT, not when the kitchen marks a ticket
 *     served. Previously a paid order that was never marked "served" contributed
 *     nothing to the P&L while its stock had already been consumed (audit C1).
 *
 *  2. REVENUE EXCLUDES TAX. `netRevenue` = subtotal - discount + deliveryFee.
 *     VAT is collected for the government and is a liability, never income
 *     (audit C3). `total` remains what the customer actually pays.
 *
 *  3. TAX IS CHARGED ON THE DISCOUNTED AMOUNT, including any delivery fee.
 *
 *  4. VOID vs REFUND are different events:
 *       - VOID: the sale should never have happened (mis-punch, wrong ticket).
 *         Reverses revenue AND returns stock, because nothing was really sold.
 *       - REFUND: money given back after a real sale. Reverses revenue but does
 *         NOT return stock by default -- the food was made and is gone. A
 *         manager may set `restockInventory` when goods genuinely come back
 *         unused.
 *     Neither ever mutates or deletes the original order: both append.
 *
 *  5. INVENTORY IS CONSUMED EXACTLY ONCE per order, guarded by
 *     `inventoryConsumed`. Re-confirming a paid order is a no-op for stock.
 */
import type { Order, OrderItem, PaymentMethod, PaymentState, RefundAllocation, Tender, FulfilmentStatus, } from '../types';
/** Money is rounded to 2dp at every boundary to keep totals reproducible. */
export function money(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}
export interface OrderTotalsInput {
    items: {
        subtotal: number;
        itemCogs: number;
    }[];
    discount: number;
    deliveryFee?: number;
    taxRatePercent: number;
}
export interface OrderTotals {
    subtotal: number;
    discount: number;
    deliveryFee: number;
    taxableBase: number;
    tax: number;
    total: number;
    netRevenue: number;
    cogs: number;
    grossProfit: number;
}
export function calculateOrderTotals(input: OrderTotalsInput): OrderTotals {
    const subtotal = money(input.items.reduce((sum, i) => sum + i.subtotal, 0));
    const cogs = money(input.items.reduce((sum, i) => sum + i.itemCogs, 0));
    // A discount can never exceed the goods value, and never goes negative.
    const discount = money(Math.min(Math.max(0, input.discount || 0), subtotal));
    const deliveryFee = money(Math.max(0, input.deliveryFee || 0));
    const taxableBase = money(subtotal - discount + deliveryFee);
    const tax = money((taxableBase * Math.max(0, input.taxRatePercent)) / 100);
    const total = money(taxableBase + tax);
    // Rule 2: revenue excludes tax.
    const netRevenue = taxableBase;
    const grossProfit = money(netRevenue - cogs);
    return { subtotal, discount, deliveryFee, taxableBase, tax, total, netRevenue, cogs, grossProfit };
}
/* -------------------------------------------------------------------------- */
/* Tender                                                                     */
/* -------------------------------------------------------------------------- */
export interface TenderInput {
    method: PaymentMethod;
    /** Amount to apply to the order. For cash this is capped at the amount due. */
    amount: number;
    tenderedAmount?: number;
    reference?: string;
}
export interface TenderValidation {
    ok: boolean;
    error?: string;
    /** Amount that will actually be applied to the balance. */
    applied: number;
    changeGiven: number;
}
/**
 * Validates a single tender against the outstanding balance.
 *
 * Cash may be over-tendered (the customer hands over a larger note) and the
 * excess becomes change. Non-cash methods must be exact -- you cannot give
 * change against a card or mobile-money payment.
 */
export function validateTender(tender: TenderInput, amountDue: number): TenderValidation {
    const due = money(amountDue);
    const amount = money(tender.amount);
    if (!(amount > 0)) {
        return { ok: false, error: 'Payment amount must be greater than zero.', applied: 0, changeGiven: 0 };
    }
    if (due <= 0) {
        return { ok: false, error: 'This order is already settled.', applied: 0, changeGiven: 0 };
    }
    if (tender.method === 'CASH') {
        const handed = money(tender.tenderedAmount ?? amount);
        if (handed < amount) {
            return {
                ok: false,
                error: 'Cash received is less than the amount being applied.',
                applied: 0,
                changeGiven: 0,
            };
        }
        const applied = money(Math.min(amount, due));
        return { ok: true, applied, changeGiven: money(handed - applied) };
    }
    if (amount > due) {
        return {
            ok: false,
            error: 'Non-cash payments cannot exceed the amount due.',
            applied: 0,
            changeGiven: 0,
        };
    }
    return { ok: true, applied: amount, changeGiven: 0 };
}
export function sumTenders(tenders: Tender[]): number {
    return money(tenders.reduce((sum, t) => sum + t.amount, 0));
}
/** Payment state implied by amounts. Never set this by hand. */
export function derivePaymentState(total: number, amountPaid: number, amountRefunded: number, voided: boolean): PaymentState {
    if (voided)
        return 'VOIDED';
    const paid = money(amountPaid);
    const refunded = money(amountRefunded);
    const due = money(total);
    if (refunded > 0) {
        return refunded >= paid ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    }
    if (paid <= 0)
        return 'UNPAID';
    if (paid + 0.005 < due)
        return 'PARTIALLY_PAID';
    return 'PAID';
}
export function amountDue(order: Pick<Order, 'total' | 'amountPaid'>): number {
    return money(Math.max(0, order.total - order.amountPaid));
}
/* -------------------------------------------------------------------------- */
/* Revenue recognition                                                        */
/* -------------------------------------------------------------------------- */
/**
 * Whether an order contributes to sales figures.
 *
 * Rule 1: money in the till is the trigger, not the kitchen. Voided orders never
 * count. Refunds are netted off separately rather than removing the sale, so the
 * trading history stays truthful.
 */
export function contributesToRevenue(order: Order): boolean {
    if (order.payment === 'VOIDED')
        return false;
    return order.amountPaid > 0;
}
/** Net revenue after refunds, excluding tax. */
export function recognizedNetRevenue(order: Order): number {
    if (!contributesToRevenue(order))
        return 0;
    if (order.total <= 0)
        return 0;
    // Refunds are recorded gross (tax inclusive); reverse them in the same
    // proportion the sale itself splits between net revenue and tax.
    const netShare = order.netRevenue / order.total;
    return money(order.netRevenue - order.amountRefunded * netShare);
}
/**
 * COGS attributable to an order.
 *
 * A refund does NOT reduce COGS unless stock was actually returned: the food was
 * made and consumed regardless. Void does reduce it, because stock went back.
 *
 * WHAT WAS BROKEN (integrity pass, item 6)
 * The restocking case was expressible only through the optional second argument,
 * and every caller -- the P&L, the reporting engine, the AI aggregator -- called
 * `recognizedCogs(order)`. So a refund could put goods back on the shelf while
 * the full cost stayed in cost of sales: the same stock counted twice. The
 * reversal is now persisted on the order by `refundSale`, so every caller gets
 * it without having to know about it. The explicit argument is retained as an
 * override for callers modelling a hypothetical return.
 */
export function recognizedCogs(order: Order, restockedRefundPortion?: number): number {
    if (!contributesToRevenue(order))
        return 0;
    if (restockedRefundPortion !== undefined) {
        if (restockedRefundPortion <= 0)
            return money(order.cogs);
        const keep = Math.max(0, 1 - restockedRefundPortion);
        return money(order.cogs * keep);
    }
    const reversed = Number.isFinite(order.cogsReversed) ? (order.cogsReversed as number) : 0;
    return money(Math.max(0, order.cogs - Math.max(0, reversed)));
}
export function recognizedTax(order: Order): number {
    if (!contributesToRevenue(order))
        return 0;
    if (order.total <= 0)
        return 0;
    const taxShare = order.tax / order.total;
    return money(order.tax - order.amountRefunded * taxShare);
}
/* -------------------------------------------------------------------------- */
/* Lifecycle guards                                                           */
/* -------------------------------------------------------------------------- */
export interface LifecycleCheck {
    ok: boolean;
    reason?: string;
}
export function canVoid(order: Order): LifecycleCheck {
    if (order.payment === 'VOIDED')
        return { ok: false, reason: 'This order is already voided.' };
    if (order.amountRefunded > 0) {
        return { ok: false, reason: 'This order has been refunded; it cannot also be voided.' };
    }
    if (order.fulfilment === 'SERVED') {
        return {
            ok: false,
            reason: 'This order was served. Use a refund instead of a void.',
        };
    }
    return { ok: true };
}
export function canRefund(order: Order, amount: number): LifecycleCheck {
    if (order.payment === 'VOIDED')
        return { ok: false, reason: 'A voided order cannot be refunded.' };
    if (order.amountPaid <= 0) {
        return { ok: false, reason: 'This order was never paid, so there is nothing to refund.' };
    }
    const refundable = money(order.amountPaid - order.amountRefunded);
    if (refundable <= 0)
        return { ok: false, reason: 'This order has already been fully refunded.' };
    if (!(amount > 0))
        return { ok: false, reason: 'Refund amount must be greater than zero.' };
    if (money(amount) > refundable) {
        return { ok: false, reason: `Refund cannot exceed the refundable balance (${refundable}).` };
    }
    return { ok: true };
}
/** Valid kitchen transitions. Payment state is unaffected by any of these. */
const FULFILMENT_TRANSITIONS: Record<FulfilmentStatus, FulfilmentStatus[]> = {
    DRAFT: ['PLACED', 'CANCELLED'],
    PLACED: ['PREPARING', 'READY', 'CANCELLED'],
    PREPARING: ['READY', 'CANCELLED'],
    READY: ['SERVED', 'CANCELLED'],
    SERVED: [],
    CANCELLED: [],
};
export function canTransitionFulfilment(from: FulfilmentStatus, to: FulfilmentStatus): boolean {
    return FULFILMENT_TRANSITIONS[from]?.includes(to) ?? false;
}
/* -------------------------------------------------------------------------- */
/* Identifiers                                                                */
/* -------------------------------------------------------------------------- */
/**
 * Receipt numbers come from a persisted monotonic counter, never from
 * `orders.length` -- which reused numbers after a deletion (audit C5).
 */
export function formatOrderNumber(sequence: number): string {
    return `ORD-${String(sequence).padStart(5, '0')}`;
}
let idCounter = 0;
/** Collision-free within a process, unlike the previous `ord-${Date.now()}`. */
export function generateId(prefix: string, now = Date.now()): string {
    idCounter = (idCounter + 1) % 1000000;
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${now.toString(36)}-${idCounter.toString(36)}-${random}`;
}
/* -------------------------------------------------------------------------- */
/* Migration                                                                  */
/* -------------------------------------------------------------------------- */
/**
 * Brings an order stored under the old single-status model onto the two-axis
 * model. Existing trading history is preserved rather than discarded.
 *
 * The old model recorded `paymentStatus: 'PAID'` at creation for every order, so
 * a legacy order that was not CANCELLED is treated as paid in full by its
 * recorded method -- which is what actually happened at the till.
 */
export function migrateLegacyOrder(raw: any): Order {
    if (raw && typeof raw === 'object' && 'fulfilment' in raw && 'payment' in raw) {
        return raw as Order;
    }
    const legacyStatus: string = raw?.status ?? 'COMPLETED';
    const total = money(raw?.total ?? 0);
    const tax = money(raw?.tax ?? 0);
    const subtotal = money(raw?.subtotal ?? 0);
    const discount = money(raw?.discount ?? 0);
    const cancelled = legacyStatus === 'CANCELLED';
    const refunded = legacyStatus === 'REFUNDED' || raw?.paymentStatus === 'REFUNDED';
    const wasPaid = !cancelled && raw?.paymentStatus !== 'PENDING';
    const fulfilment: FulfilmentStatus = cancelled
        ? 'CANCELLED'
        : legacyStatus === 'COMPLETED'
            ? 'SERVED'
            : legacyStatus === 'READY'
                ? 'READY'
                : legacyStatus === 'PREPARING'
                    ? 'PREPARING'
                    : 'PLACED';
    const amountPaid = wasPaid ? total : 0;
    const amountRefunded = refunded ? total : 0;
    const createdAt = raw?.timestamps?.created ?? Date.now();
    const tenders: Tender[] = amountPaid > 0
        ? [
            {
                id: generateId('tnd', createdAt),
                method: (raw?.paymentMethod ?? 'CASH') as PaymentMethod,
                amount: amountPaid,
                takenAt: createdAt,
                takenByUserId: raw?.cashierId ?? 'unknown',
                takenByName: raw?.cashierName ?? 'Unknown',
            },
        ]
        : [];
    return {
        ...raw,
        subtotal,
        discount,
        deliveryFee: money(raw?.deliveryFee ?? 0),
        tax,
        total,
        netRevenue: money(subtotal - discount + (raw?.deliveryFee ?? 0)),
        cogs: money(raw?.cogs ?? 0),
        grossProfit: money(subtotal - discount - (raw?.cogs ?? 0)),
        fulfilment,
        payment: derivePaymentState(total, amountPaid, amountRefunded, false),
        tenders,
        amountPaid,
        amountRefunded,
        // Legacy orders deducted stock at creation, so they are already consumed.
        inventoryConsumed: !cancelled,
        consumptionMovementIds: [],
        timestamps: {
            created: createdAt,
            placed: createdAt,
            prepStarted: raw?.timestamps?.prepStarted,
            prepCompleted: raw?.timestamps?.prepCompleted,
            served: raw?.timestamps?.completed,
            paidAt: wasPaid ? createdAt : undefined,
        },
    } as Order;
}
/* -------------------------------------------------------------------------- */
/* Refund allocation (integrity pass, item 7)                                  */
/* -------------------------------------------------------------------------- */
/**
 * Splits a refund across the payment methods the sale was actually paid with.
 *
 * THE PROBLEM THIS SOLVES
 * A ticket settled ৳600 cash + ৳400 bKash, then partly refunded ৳500, used to
 * record only "৳500 refunded". The takings report still showed ৳600 cash and
 * ৳400 bKash, and nothing in the data said which of them the ৳500 came out of,
 * so neither the drawer nor the mobile-money statement could be reconciled.
 *
 * THE RULE
 * A refund is allocated pro rata across what each method still has refundable
 * (its tenders, less what earlier refunds already took back from it). Pro rata
 * is the only defensible default: the operator refunds a ticket, not a tender,
 * and any other split would be an invention. A caller that knows better -- cash
 * back on a card sale, say -- may pass an explicit allocation instead.
 *
 * Rounding drift from the split is put on the largest allocation, so the parts
 * always add up to the refund exactly.
 */
export function allocateRefundAcrossTenders(tenders: Tender[], priorAllocations: RefundAllocation[], amount: number): {
    ok: true;
    allocations: RefundAllocation[];
} | {
    ok: false;
    error: string;
} {
    const target = money(amount);
    if (!(target > 0))
        return { ok: false, error: 'Refund amount must be greater than zero.' };
    const refundable = new Map<PaymentMethod, number>();
    for (const tender of tenders ?? []) {
        refundable.set(tender.method, money((refundable.get(tender.method) ?? 0) + tender.amount));
    }
    for (const prior of priorAllocations ?? []) {
        if (!refundable.has(prior.method))
            continue;
        refundable.set(prior.method, money((refundable.get(prior.method) as number) - prior.amount));
    }
    const available = Array.from(refundable.entries())
        .filter(([, remaining]) => remaining > 0)
        .sort((a, b) => b[1] - a[1]);
    const totalAvailable = money(available.reduce((sum, [, remaining]) => sum + remaining, 0));
    if (totalAvailable <= 0) {
        return { ok: false, error: 'This order has no payment left to refund.' };
    }
    if (target > totalAvailable + 0.005) {
        return {
            ok: false,
            error: `Refund cannot exceed the refundable balance (${totalAvailable}).`,
        };
    }
    const capped = money(Math.min(target, totalAvailable));
    const allocations: RefundAllocation[] = available.map(([method, remaining]) => ({
        method,
        amount: money((capped * remaining) / totalAvailable),
    }));
    // Put any rounding remainder on the largest share, so the parts sum exactly.
    const allocated = money(allocations.reduce((sum, a) => sum + a.amount, 0));
    const drift = money(capped - allocated);
    if (drift !== 0 && allocations.length > 0) {
        allocations[0] = { ...allocations[0], amount: money(allocations[0].amount + drift) };
    }
    return { ok: true, allocations: allocations.filter((a) => a.amount > 0) };
}
/** Validates a caller-supplied allocation against the order's tenders. */
export function validateRefundAllocations(tenders: Tender[], priorAllocations: RefundAllocation[], amount: number, allocations: RefundAllocation[]): {
    ok: true;
} | {
    ok: false;
    error: string;
} {
    if (!Array.isArray(allocations) || allocations.length === 0) {
        return { ok: false, error: 'A refund must say which payment methods it came out of.' };
    }
    const sum = money(allocations.reduce((total, a) => total + a.amount, 0));
    if (Math.abs(sum - money(amount)) > 0.005) {
        return { ok: false, error: 'The refund split does not add up to the refund amount.' };
    }
    const refundable = new Map<PaymentMethod, number>();
    for (const tender of tenders ?? []) {
        refundable.set(tender.method, money((refundable.get(tender.method) ?? 0) + tender.amount));
    }
    for (const prior of priorAllocations ?? []) {
        refundable.set(prior.method, money((refundable.get(prior.method) ?? 0) - prior.amount));
    }
    for (const allocation of allocations) {
        if (!(allocation.amount > 0)) {
            return { ok: false, error: 'Every part of a refund split must be greater than zero.' };
        }
        const remaining = refundable.get(allocation.method) ?? 0;
        if (allocation.amount > remaining + 0.005) {
            return {
                ok: false,
                error: `Cannot refund ${allocation.amount} to ${allocation.method}: only ${money(Math.max(0, remaining))} was taken that way.`,
            };
        }
    }
    return { ok: true };
}
/** Every allocation already recorded against an order, for the checks above. */
export function priorRefundAllocations(refunds: {
    orderId: string;
    amount: number;
    allocations?: RefundAllocation[];
}[], orderId: string): RefundAllocation[] {
    const out: RefundAllocation[] = [];
    for (const refund of refunds) {
        if (refund.orderId !== orderId)
            continue;
        for (const allocation of refund.allocations ?? [])
            out.push(allocation);
    }
    return out;
}
