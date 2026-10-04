import type { Ingredient, MenuItem, RecipeIngredient, UnitType } from '../types';
/**
 * Recipe resolution and unit conversion.
 *
 * UNIT CONVERSION IS NOW EXPLICIT (integrity pass, item 5)
 * `convertQuantity` used to return the quantity unchanged when the two units
 * belonged to different dimensions, so a recipe line of "2 kg" against an
 * ingredient stocked in `ml` silently became "2 ml" -- wrong cost, wrong
 * deduction, no warning anywhere. Crossing dimensions is now an error:
 *
 *  - `tryConvertQuantity` returns a result object, for callers that must not throw.
 *  - `convertQuantity` throws `UnitConversionError`, for call sites where an
 *    incompatible unit means the operation cannot legitimately continue.
 *
 * Conversions *within* a dimension are unchanged: g<->kg, ml<->l, and the count
 * units (pcs/slice/pack) remain interchangeable one-for-one, which is what every
 * existing recipe already relies on.
 */
export type UnitDimension = 'mass' | 'volume' | 'count';
/** Base unit per dimension: grams, millilitres, or a bare count. */
const UNIT_DIMENSIONS: Record<UnitType, {
    dimension: UnitDimension;
    perBase: number;
}> = {
    g: { dimension: 'mass', perBase: 1 },
    kg: { dimension: 'mass', perBase: 1000 },
    ml: { dimension: 'volume', perBase: 1 },
    l: { dimension: 'volume', perBase: 1000 },
    pcs: { dimension: 'count', perBase: 1 },
    slice: { dimension: 'count', perBase: 1 },
    pack: { dimension: 'count', perBase: 1 },
};
export class UnitConversionError extends Error {
    readonly fromUnit: UnitType;
    readonly toUnit: UnitType;
    constructor(fromUnit: UnitType, toUnit: UnitType) {
        super(`Cannot convert ${fromUnit} to ${toUnit}: these measure different things.`);
        this.name = 'UnitConversionError';
        this.fromUnit = fromUnit;
        this.toUnit = toUnit;
    }
}
/** True when a recognised unit. Guards data loaded from storage or a backup. */
export function isKnownUnit(unit: unknown): unit is UnitType {
    return typeof unit === 'string' && Object.hasOwn(UNIT_DIMENSIONS, unit);
}
export function dimensionOf(unit: UnitType): UnitDimension {
    return UNIT_DIMENSIONS[unit].dimension;
}
export function areUnitsCompatible(a: UnitType, b: UnitType): boolean {
    if (!isKnownUnit(a) || !isKnownUnit(b))
        return false;
    return dimensionOf(a) === dimensionOf(b);
}
export function convertToBaseUnit(quantity: number, unit: UnitType): {
    baseQty: number;
    dimension: UnitDimension;
} {
    if (!isKnownUnit(unit)) {
        throw new UnitConversionError(unit, unit);
    }
    const spec = UNIT_DIMENSIONS[unit];
    return { baseQty: quantity * spec.perBase, dimension: spec.dimension };
}
/** Converts a base quantity back into the target unit. */
export function convertFromBaseUnit(baseQty: number, targetUnit: UnitType): number {
    if (!isKnownUnit(targetUnit)) {
        throw new UnitConversionError(targetUnit, targetUnit);
    }
    return baseQty / UNIT_DIMENSIONS[targetUnit].perBase;
}
export type ConversionResult = {
    ok: true;
    value: number;
} | {
    ok: false;
    error: string;
};
/**
 * Converts between units, reporting rather than throwing. Use this wherever a
 * bad unit must not take a screen down -- e.g. showing a cost in the recipe
 * editor while the owner is still typing.
 */
export function tryConvertQuantity(qty: number, fromUnit: UnitType, toUnit: UnitType): ConversionResult {
    if (!Number.isFinite(qty)) {
        return { ok: false, error: 'Quantity is not a number.' };
    }
    if (!isKnownUnit(fromUnit))
        return { ok: false, error: `Unknown unit "${String(fromUnit)}".` };
    if (!isKnownUnit(toUnit))
        return { ok: false, error: `Unknown unit "${String(toUnit)}".` };
    if (fromUnit === toUnit)
        return { ok: true, value: qty };
    if (!areUnitsCompatible(fromUnit, toUnit)) {
        return {
            ok: false,
            error: `Cannot convert ${fromUnit} to ${toUnit}: these measure different things.`,
        };
    }
    const { baseQty } = convertToBaseUnit(qty, fromUnit);
    return { ok: true, value: convertFromBaseUnit(baseQty, toUnit) };
}
/**
 * Converts between compatible units. Throws `UnitConversionError` when the two
 * units measure different things -- it never falls back to 1:1, which is what
 * let incompatible recipe lines through silently.
 */
export function convertQuantity(qty: number, fromUnit: UnitType, toUnit: UnitType): number {
    const result = tryConvertQuantity(qty, fromUnit, toUnit);
    if (result.ok !== true)
        throw new UnitConversionError(fromUnit, toUnit);
    return result.value;
}
export interface ResolvedRecipeItem {
    ingredientId: string;
    ingredientName: string;
    quantityInIngredientUnit: number;
    unit: UnitType;
    costImpact: number;
}
/**
 * Resolves the full Bill of Materials (BOM) for a menu item with selected variation and modifiers
 */
export function resolveItemRecipe(menuItem: MenuItem, variationId?: string, selectedModifierIds: string[] = [], ingredientsMap: Map<string, Ingredient> = new Map()): ResolvedRecipeItem[] {
    const aggregated = new Map<string, {
        quantity: number;
        unit: UnitType;
        name: string;
    }>();
    // Determine base recipe: if item has variations, take the selected variation's recipe; otherwise take base recipe
    let baseRecipe = menuItem.recipe;
    if (menuItem.variations && menuItem.variations.length > 0) {
        const matchedVar = menuItem.variations.find((v) => v.id === variationId) || menuItem.variations[0];
        if (matchedVar && matchedVar.recipe && matchedVar.recipe.length > 0) {
            baseRecipe = matchedVar.recipe;
        }
    }
    // Aggregate base recipe ingredients
    for (const item of baseRecipe) {
        const existing = aggregated.get(item.ingredientId);
        if (!existing) {
            aggregated.set(item.ingredientId, {
                quantity: item.quantity,
                unit: item.unit,
                name: item.ingredientName,
            });
        }
        else {
            const converted = convertQuantity(item.quantity, item.unit, existing.unit);
            existing.quantity += converted;
        }
    }
    // Aggregate modifiers
    for (const modId of selectedModifierIds) {
        const mod = menuItem.modifiers.find((m) => m.id === modId);
        if (mod && mod.recipe) {
            for (const item of mod.recipe) {
                const existing = aggregated.get(item.ingredientId);
                if (!existing) {
                    aggregated.set(item.ingredientId, {
                        quantity: item.quantity,
                        unit: item.unit,
                        name: item.ingredientName,
                    });
                }
                else {
                    const converted = convertQuantity(item.quantity, item.unit, existing.unit);
                    existing.quantity += converted;
                }
            }
        }
    }
    // Match with actual Ingredient entities to calculate exact cost & unit representation
    const results: ResolvedRecipeItem[] = [];
    for (const [ingredientId, val] of aggregated.entries()) {
        const ing = ingredientsMap.get(ingredientId);
        const targetUnit = ing ? ing.unit : val.unit;
        const finalQty = convertQuantity(val.quantity, val.unit, targetUnit);
        const costPerUnit = ing ? ing.costPerUnit : 0;
        const costImpact = finalQty * costPerUnit;
        results.push({
            ingredientId,
            ingredientName: ing ? ing.name : val.name,
            quantityInIngredientUnit: finalQty,
            unit: targetUnit,
            costImpact,
        });
    }
    return results;
}
/**
 * Calculates recipe cost breakdown for a MenuItem
 */
export function calculateRecipeCost(recipe: RecipeIngredient[], ingredientsMap: Map<string, Ingredient>): {
    totalCost: number;
    breakdown: {
        ingredientName: string;
        cost: number;
        percent: number;
    }[];
} {
    let totalCost = 0;
    const items: {
        ingredientName: string;
        cost: number;
    }[] = [];
    for (const item of recipe) {
        const ing = ingredientsMap.get(item.ingredientId);
        const costPerUnit = ing ? ing.costPerUnit : 0;
        // Display path: an incompatible or unknown unit is shown as zero cost rather
        // than crashing the screen. `validateRecipeLines` is what refuses to sell it.
        const converted = ing
            ? tryConvertQuantity(item.quantity, item.unit, ing.unit)
            : ({ ok: true, value: item.quantity } as ConversionResult);
        const qtyInIngUnit = converted.ok === true ? converted.value : 0;
        const cost = qtyInIngUnit * costPerUnit;
        totalCost += cost;
        items.push({
            ingredientName: ing ? ing.name : item.ingredientName,
            cost,
        });
    }
    const breakdown = items.map((i) => ({
        ...i,
        percent: totalCost > 0 ? (i.cost / totalCost) * 100 : 0,
    }));
    return { totalCost, breakdown };
}
/* -------------------------------------------------------------------------- */
/* Recipe validation                                                           */
/* -------------------------------------------------------------------------- */
export interface RecipeLineProblem {
    ingredientId: string;
    ingredientName: string;
    reason: string;
}
/**
 * Checks a recipe against the ingredient master data before it is allowed to
 * move stock or book cost.
 *
 * Each of these used to pass silently and produce a sale with an understated
 * cost and an untouched stock level (integrity pass, item 4):
 *
 *  - a line pointing at an ingredient that no longer exists,
 *  - a quantity that is zero, negative, or not a number,
 *  - a unit that is unknown, or that measures something other than the unit the
 *    ingredient is stocked in.
 */
export function validateRecipeLines(recipe: RecipeIngredient[], ingredientsMap: Map<string, Ingredient>, context: string): RecipeLineProblem[] {
    const problems: RecipeLineProblem[] = [];
    for (const line of recipe) {
        const name = line.ingredientName || line.ingredientId;
        const ing = ingredientsMap.get(line.ingredientId);
        if (!ing) {
            problems.push({
                ingredientId: line.ingredientId,
                ingredientName: name,
                reason: `${context} uses "${name}", which is not in the ingredient list.`,
            });
            continue;
        }
        if (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0) {
            problems.push({
                ingredientId: line.ingredientId,
                ingredientName: ing.name,
                reason: `${context} has no usable portion size for ${ing.name}.`,
            });
            continue;
        }
        if (!isKnownUnit(line.unit)) {
            problems.push({
                ingredientId: line.ingredientId,
                ingredientName: ing.name,
                reason: `${context} measures ${ing.name} in an unknown unit "${String(line.unit)}".`,
            });
            continue;
        }
        if (!isKnownUnit(ing.unit)) {
            problems.push({
                ingredientId: line.ingredientId,
                ingredientName: ing.name,
                reason: `${ing.name} is stocked in an unknown unit "${String(ing.unit)}".`,
            });
            continue;
        }
        if (!areUnitsCompatible(line.unit, ing.unit)) {
            problems.push({
                ingredientId: line.ingredientId,
                ingredientName: ing.name,
                reason: `${context} measures ${ing.name} in ${line.unit}, but it is stocked in ` +
                    `${ing.unit}. These cannot be converted.`,
            });
        }
    }
    return problems;
}
