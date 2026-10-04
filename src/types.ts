/**
 * Restaurant Management & Intelligence System - Core Types
 */
/**
 * Two operational roles. A legacy 'MANAGER' may exist in stored data and is
 * migrated to EMPLOYEE on load (least privilege) -- see permissions.normalizeRole.
 */
export type UserRole = 'ADMIN' | 'EMPLOYEE';
export interface User {
    id: string;
    /** Login identifier chosen by the admin. Unique, case-insensitive. */
    username: string;
    name: string;
    email: string;
    role: UserRole;
    avatar?: string;
    /** Deactivated staff keep their history but cannot sign in. */
    isActive: boolean;
}
/**
 * An authenticated session. `role` is derived from the authenticated user record
 * and is never settable from the UI (audit S1).
 */
export interface AuthSession {
    userId: string;
    name: string;
    role: UserRole;
    authenticatedAt: number;
    /** Set when a manager/admin authorised a specific privileged action. */
    lastElevationAt?: number;
}
export interface RestaurantProfile {
    id: string;
    name: string;
    tagline: string;
    address: string;
    phone: string;
    taxNumber: string;
    currencySymbol: string;
    taxRatePercent: number;
    tableCount: number;
    contractStartDate: string;
    contractDurationDays: number;
    gracePeriodDays: number;
    licenseKey: string;
}
export type UnitType = 'g' | 'kg' | 'pcs' | 'slice' | 'ml' | 'l' | 'pack';
export interface Ingredient {
    id: string;
    name: string;
    category: string;
    unit: UnitType;
    currentStock: number;
    openingStock: number;
    costPerUnit: number; // Cost in restaurant currency
    minReorderThreshold: number;
    criticalThreshold: number;
    supplierId: string;
    lastPurchaseDate?: string;
    lastPurchasePrice?: number;
    /**
     * When true, every lot received must carry an expiry date (DECISIONS D21).
     * Absent on data from before batch/lot inventory, which reads as false.
     */
    tracksExpiry?: boolean;
    /** Prefills the expiry date at receiving. Never overrides an entered date. */
    defaultShelfLifeDays?: number;
    /**
     * Quantity sold beyond every lot under an ADMIN stock override, not yet
     * cleared by a stock count (DECISIONS D20). `currentStock` is the lot total
     * minus this, so a negative position stays visible. Never settled by purchases.
     */
    negativeStockQty?: number;
}
/**
 * One receipt of one ingredient: a batch with its own cost and expiry.
 *
 * Lots are the source of truth for stock (DECISIONS D18). `Ingredient.currentStock`
 * and `Ingredient.costPerUnit` are derived from them. A lot's quantity never goes
 * negative.
 */
export type LotSource = 'PURCHASE' | 'OPENING' | 'LEGACY_MIGRATION' | 'COUNT_SURPLUS' | 'RETURN';
export type LotStatus = 'ACTIVE' | 'DEPLETED' | 'WRITTEN_OFF';
export interface InventoryLot {
    id: string;
    ingredientId: string;
    ingredientName: string;
    /** Supplier's batch / lot code, when there is one. */
    lotCode?: string;
    receivedAt: number;
    /**
     * Calendar date (YYYY-MM-DD). The lot is usable THROUGH this date and expired
     * from the next day. Absent for ingredients that do not track expiry.
     */
    expiryDate?: string;
    /** In the ingredient's base unit. */
    quantityReceived: number;
    quantityRemaining: number;
    /** Actual cost per ingredient base unit, six decimals. */
    unitCost: number;
    source: LotSource;
    purchaseId?: string;
    purchaseNumber?: string;
    supplierId?: string;
    status: LotStatus;
    notes?: string;
}
export type InventoryMovementType = 'PURCHASE' | 'RECIPE_CONSUMPTION' | 'WASTAGE' | 'EXPIRY' | 'DAMAGE' | 'RETURN' | 'MANUAL_ADJUSTMENT' | 'STOCK_COUNT_CORRECTION';
/**
 * Consumption that needed an ADMIN override, marked on the ledger row itself so
 * it is visible wherever movements are listed (DECISIONS D19, D20).
 */
export type MovementException = 'NEGATIVE_STOCK' | 'EXPIRED_LOT_OVERRIDE';
export interface InventoryMovement {
    id: string;
    timestamp: number;
    ingredientId: string;
    ingredientName: string;
    type: InventoryMovementType;
    quantityDelta: number; // Positive for stock in, negative for stock out
    unit: UnitType;
    resultingStock: number;
    unitCost: number;
    totalCostImpact: number;
    referenceId?: string; // Order #, Purchase #, etc.
    notes?: string;
    performedBy: string;
    /**
     * The lot this row moved. Absent on rows from before lots, and on a
     * NEGATIVE_STOCK exception row (there was no lot to take from).
     */
    lotId?: string;
    /** Sale consumption rows: the order line they were consumed for. */
    orderItemId?: string;
    /** Return rows: the consumption row being reversed. */
    reversesMovementId?: string;
    exception?: MovementException;
    /**
     * Return rows for an order sold before lot tracking with no consumption rows to
     * reverse: the original lot cannot be known, so the goods came back into a new
     * RETURN lot valued at the ingredient's cost estimate on the day of the return.
     * Marks the value as an estimate, never as the historical cost.
     */
    legacyEstimate?: boolean;
}
export interface RecipeIngredient {
    ingredientId: string;
    ingredientName: string;
    quantity: number;
    unit: UnitType;
    estimatedCost: number;
}
export interface Variation {
    id: string;
    name: string; // e.g. 'Small', 'Medium', 'Large'
    additionalPrice: number;
    recipe: RecipeIngredient[];
}
export interface Modifier {
    id: string;
    name: string; // e.g. 'Extra Cheese', 'Spicy Sauce'
    additionalPrice: number;
    recipe: RecipeIngredient[];
}
export interface MenuItem {
    id: string;
    name: string;
    categoryId: string;
    categoryName: string;
    description: string;
    basePrice: number;
    isAvailable: boolean;
    recipe: RecipeIngredient[];
    variations: Variation[];
    modifiers: Modifier[];
    imageUrl?: string;
    iconEmoji: string;
    /**
     * Removed from the menu but retained, because past orders reference it.
     * Archived items never appear at the till and are excluded from readiness.
     */
    isArchived?: boolean;
}
export interface MenuCategory {
    id: string;
    name: string;
    icon: string;
    order: number;
}
export type OrderType = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
export type PaymentMethod = 'CASH' | 'BKASH' | 'NAGAD' | 'CARD' | 'BANK_TRANSFER';
/**
 * Kitchen/fulfilment state. Deliberately separate from payment state: a ticket
 * can be paid and not yet cooked, or cooked and not yet paid (open table).
 * Conflating the two is what caused revenue to depend on a kitchen button
 * being pressed (audit C1).
 */
export type FulfilmentStatus = 'DRAFT' // being built at the till, not yet sent anywhere
 | 'PLACED' // sent to the kitchen
 | 'PREPARING' | 'READY' | 'SERVED' | 'CANCELLED';
/** Money state. This -- not fulfilment -- decides revenue recognition. */
export type PaymentState = 'UNPAID' // open tab / table not yet settled
 | 'PARTIALLY_PAID' | 'PAID' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'VOIDED'; // sale reversed entirely; never happened commercially
/**
 * Shape of an order as written by the pre-two-axis model. Only used as the input
 * type for `migrateLegacyOrder` and for seed data; never persisted going forward.
 */
export interface LegacyOrderSeed {
    id: string;
    orderNumber: string;
    type: OrderType;
    tableNumber?: number;
    customerName?: string;
    items: OrderItem[];
    subtotal: number;
    discount: number;
    tax: number;
    total: number;
    cogs: number;
    grossProfit: number;
    paymentMethod: PaymentMethod;
    paymentStatus: 'PAID' | 'PENDING' | 'REFUNDED';
    status: OrderStatus;
    cashierId: string;
    cashierName: string;
    timestamps: {
        created: number;
        prepStarted?: number;
        prepCompleted?: number;
        completed?: number;
    };
    notes?: string;
}
/** @deprecated Legacy single-axis status, retained only to migrate stored orders. */
export type OrderStatus = 'OPEN' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED' | 'REFUNDED';
/**
 * One payment applied to an order. Orders hold a list, so split tender
 * (part cash, part mobile) is representable and the day-close can reconcile
 * each method separately.
 */
export interface Tender {
    id: string;
    method: PaymentMethod;
    /** Amount applied against the order total. */
    amount: number;
    /** Cash handed over, when method is CASH. */
    tenderedAmount?: number;
    changeGiven?: number;
    /**
     * Method-specific reference: mobile-money transaction id, card approval code,
     * bank reference. Free text, keyed in by the cashier; no gateway involved.
     */
    reference?: string;
    takenAt: number;
    takenByUserId: string;
    takenByName: string;
}
/**
 * A till operator reporting a suspected mistake on a completed order.
 *
 * Employees cannot edit money. When they notice a data-entry error they raise a
 * flag; an administrator investigates and applies the correction. Both the flag
 * and the correction are retained, so the original transaction and everything
 * done to it stay auditable.
 */
export interface OrderFlag {
    id: string;
    orderId: string;
    orderNumber: string;
    note: string;
    raisedByUserId: string;
    raisedByName: string;
    raisedAt: number;
    status: 'OPEN' | 'RESOLVED' | 'DISMISSED';
    resolvedByUserId?: string;
    resolvedByName?: string;
    resolvedAt?: number;
    resolutionNote?: string;
}
export type RefundReason = 'CUSTOMER_COMPLAINT' | 'WRONG_ORDER' | 'ITEM_UNAVAILABLE' | 'OVERCHARGE' | 'OTHER';
/**
 * How a refund was paid back, per payment method.
 *
 * Without this a split-tender sale becomes unreconcilable the moment part of it
 * is refunded: the order records ৳600 cash + ৳400 bKash and a ৳500 refund, and
 * nothing says which drawer the ৳500 left (integrity pass, item 7).
 */
export interface RefundAllocation {
    method: PaymentMethod;
    amount: number;
}
export interface RefundRecord {
    id: string;
    orderId: string;
    amount: number;
    reason: RefundReason;
    notes?: string;
    /** True when goods came back unused and stock was returned. */
    restockedInventory: boolean;
    /**
     * The refund split across the methods the sale was actually paid with. Sums to
     * `amount`. Present on every refund recorded after the reconciliation fix;
     * older records have none, and are reported as unallocated rather than guessed.
     */
    allocations?: RefundAllocation[];
    /**
     * Share of the original ticket whose goods came back, and the COGS reversed as
     * a result. Zero when nothing was restocked.
     */
    restockedProportion?: number;
    cogsReversed?: number;
    /** Ledger rows written by this refund's restock, when goods came back. */
    restoredMovementIds?: string[];
    refundedAt: number;
    refundedByUserId: string;
    refundedByName: string;
    approvedByUserId: string;
    approvedByName: string;
}
export interface OrderCostAllocation {
    ingredientId: string;
    /** Absent for a NEGATIVE_STOCK exception allocation. */
    lotId?: string;
    quantity: number;
    unitCost: number;
    /** money(quantity x unitCost): exactly the ledger row's cost. */
    cost: number;
    movementId: string;
    exception?: MovementException;
}
export interface OrderItem {
    id: string;
    menuItemId: string;
    menuItemName: string;
    variationId?: string;
    variationName?: string;
    modifiers: {
        modifierId: string;
        name: string;
        price: number;
    }[];
    unitPrice: number;
    quantity: number;
    subtotal: number;
    itemCogs: number;
    /**
     * What this line actually consumed, lot by lot. `itemCogs` is the sum of the
     * `cost` values -- the one authoritative sale cost (DECISIONS D18). Absent on
     * orders from before lots.
     */
    costAllocations?: OrderCostAllocation[];
    consumedIngredients: {
        ingredientId: string;
        ingredientName: string;
        quantity: number;
        unit: UnitType;
    }[];
    notes?: string;
}
/** Where a delivery order is going. Captured at order entry, not guessed. */
export interface DeliveryDetails {
    recipientName: string;
    phone: string;
    address: string;
    notes?: string;
    /** Charged to the customer and treated as revenue, not as a discount. */
    deliveryFee: number;
}
export interface Order {
    id: string;
    orderNumber: string; // e.g. "ORD-1042"
    type: OrderType;
    tableNumber?: number;
    customerName?: string;
    delivery?: DeliveryDetails;
    items: OrderItem[];
    /** Money, all in restaurant currency. */
    subtotal: number; // sum of line subtotals, before discount
    discount: number;
    deliveryFee: number;
    tax: number; // VAT on (subtotal - discount + deliveryFee)
    total: number; // what the customer pays, tax inclusive
    /**
     * Net sales excluding tax: subtotal - discount + deliveryFee.
     * This -- not `total` -- is revenue. VAT is collected on the government's
     * behalf and is a liability, not income (audit C3).
     */
    netRevenue: number;
    cogs: number;
    grossProfit: number; // netRevenue - cogs
    /** Two independent axes; see FulfilmentStatus / PaymentState. */
    fulfilment: FulfilmentStatus;
    payment: PaymentState;
    tenders: Tender[];
    amountPaid: number;
    amountRefunded: number;
    /**
     * Guard against double deduction: inventory is consumed exactly once, and
     * these are the movement rows that did it, so a reversal can be exact
     * rather than recomputed.
     */
    inventoryConsumed: boolean;
    consumptionMovementIds: string[];
    /**
     * COGS already reversed out of this order by restocking refunds.
     *
     * A refund that puts goods back on the shelf has to take the cost back out of
     * the P&L too, or the stock is counted twice: once as inventory on hand and
     * again as cost of sale. Absent/zero on orders where nothing came back, which
     * is the normal case -- the food was made and is gone.
     */
    cogsReversed?: number;
    cashierId: string;
    cashierName: string;
    voidReason?: string;
    voidApprovedByName?: string;
    timestamps: {
        created: number;
        placed?: number;
        prepStarted?: number;
        prepCompleted?: number;
        served?: number;
        /** When payment completed. Revenue is recognised at this instant. */
        paidAt?: number;
        voidedAt?: number;
        lastRefundedAt?: number;
    };
    notes?: string;
    /** @deprecated Present only on orders migrated from the single-status model. */
    status?: OrderStatus;
    /** @deprecated Superseded by `tenders`. */
    paymentMethod?: PaymentMethod;
}
export interface Supplier {
    id: string;
    name: string;
    contactPerson: string;
    phone: string;
    email: string;
    address: string;
    ingredients: string[];
    averageLeadTimeDays: number;
}
export interface PurchaseItem {
    ingredientId: string;
    ingredientName: string;
    /** Total received, in `unit`. With packs this is packCount x packSize. */
    quantity: number;
    /** Any unit of the ingredient's dimension; converted to its base unit on receipt. */
    unit: UnitType;
    unitPrice: number;
    totalPrice: number;
    /** Receiving convenience: 10 x 25 kg (DECISIONS D22). */
    packCount?: number;
    packSize?: number;
    lotCode?: string;
    /** YYYY-MM-DD. Required when the ingredient tracks expiry. */
    expiryDate?: string;
    /** Set on receipt: the lot this line created. */
    lotId?: string;
}
export interface Purchase {
    id: string;
    purchaseNumber: string; // e.g. "PO-2026-09"
    supplierId: string;
    supplierName: string;
    /** Supplier's own invoice reference, for reconciliation against statements. */
    invoiceNumber?: string;
    date: string;
    timestamp: number;
    items: PurchaseItem[];
    totalAmount: number;
    paymentMethod: PaymentMethod;
    /** PENDING covers goods received on supplier credit. */
    paymentStatus: 'PAID' | 'PENDING';
    notes?: string;
    receivedBy: string;
}
export type ExpenseCategory = 'RENT' | 'SALARY' | 'UTILITIES' | 'MARKETING' | 'TRANSPORTATION' | 'MAINTENANCE' | 'OTHER';
export interface Expense {
    id: string;
    category: ExpenseCategory;
    amount: number;
    date: string;
    timestamp: number;
    vendor: string;
    paymentMethod: PaymentMethod;
    description: string;
    receiptNumber?: string;
    recordedBy: string;
}
export type WastageReason = 'SPOILAGE' | 'EXPIRY' | 'PREPARATION_WASTE' | 'OVERPRODUCTION' | 'BURNED_DAMAGED' | 'CUSTOMER_RETURN' | 'OTHER';
export interface WastageRecord {
    id: string;
    ingredientId: string;
    ingredientName: string;
    quantity: number;
    unit: UnitType;
    unitCost: number;
    totalCostImpact: number;
    reason: WastageReason;
    date: string;
    timestamp: number;
    employeeId: string;
    employeeName: string;
    notes?: string;
    /** Operator-chosen lot; FEFO across the ingredient's lots when absent. */
    lotId?: string;
    /** Lots the wastage was taken from, each at its own cost. */
    lotAllocations?: {
        lotId: string;
        quantity: number;
        unitCost: number;
        cost: number;
    }[];
}
export type LicenseStatus = 'ACTIVE' | 'EXPIRING_SOON' | 'EXPIRED_GRACE' | 'SUSPENDED';
export interface LicenseInfo {
    restaurantId: string;
    licenseId: string;
    restaurantName: string;
    activationDate: string; // ISO
    expirationDate: string; // ISO
    /** Issue time, set by the vendor issuer. Covered by the signature and used to
     *  reject a licence older than one already used here (audit S4). */
    issuedAt: string; // ISO
    contractDays: number; // e.g. 30
    gracePeriodDays: number; // e.g. 5
    status: LicenseStatus;
    daysRemaining: number;
    features: string[];
    signature: string;
}
export type AIRecommendationCategory = 'REORDER' | 'COST_WARNING' | 'WASTE_WARNING' | 'DEMAND_PREDICTION' | 'PROFIT_WARNING' | 'PURCHASING_OPTIMIZATION';
export interface AIRecommendation {
    id: string;
    category: AIRecommendationCategory;
    title: string;
    recommendation: string;
    reason: string;
    supportingStatistics: {
        label: string;
        value: string | number;
    }[];
    confidence: number; // 0 to 1
    expectedImpact: string;
    suggestedAction: string;
    actionPayload?: {
        type: 'PURCHASE_ORDER' | 'ADJUST_PRICE' | 'REVIEW_WASTE' | 'CHECK_STOCK';
        targetId?: string;
        suggestedQuantity?: number;
        suggestedPrice?: number;
    };
    generatedAt: number;
    isApplied?: boolean;
}
export interface AuditLog {
    id: string;
    timestamp: number;
    userId: string;
    userName: string;
    role: UserRole;
    action: string;
    details: string;
}
export interface MenuBCGItem {
    id: string;
    name: string;
    category: string;
    unitsSold: number;
    revenue: number;
    cogs: number;
    grossProfit: number;
    grossMarginPercent: number;
    /** Null when the item has no sales in the period: not enough data to classify. */
    classification: 'STAR' | 'PLOWHORSE' | 'PUZZLE' | 'DOG' | null;
    hasSales: boolean;
}
